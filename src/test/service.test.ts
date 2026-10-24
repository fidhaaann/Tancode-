import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplanationCache } from '../model/cache';
import { OllamaClient, OllamaError } from '../model/ollama';
import { DocLike, ExplanationResult, ExplanationService, ServiceOptions } from '../model/service';
import type { GenerateOptions } from '../model/ollama';

function doc(overrides: Partial<DocLike> = {}): DocLike {
	return {
		languageId: 'typescript',
		fileName: '/w/app.ts',
		uri: { fsPath: '/w/app.ts', toString: () => 'file:///w/app.ts' },
		version: 1,
		getText: () => 'export function main() {}',
		...overrides,
	};
}

function makeService(
	generate: (model: string, sys: string, prompt: string, opts?: GenerateOptions) => Promise<string>,
	extra: Partial<ServiceOptions> | boolean = true,
) {
	const fallbackToRules = typeof extra === 'boolean' ? extra : extra.fallbackToRules !== false;
	const calls: string[] = [];
	const genOpts: (GenerateOptions | undefined)[] = [];
	const logs: string[] = [];
	const client = new OllamaClient('http://127.0.0.1:11434', 5000, async () => {
		throw new Error('not implemented');
	});
	client.generate = async (model, sys, prompt, opts) => {
		calls.push(prompt);
		genOpts.push(opts);
		return generate(model, sys, prompt, opts);
	};
	const service = new ExplanationService(
		client,
		new ExplanationCache<ExplanationResult>(),
		d => (d.getText().includes('export') ? ({ summary: 'rules say it exports things', symbols: [], imports: [], exports: [], details: [], fileName: 'app.ts', languageId: 'typescript', languageName: 'TypeScript', lineCount: 1, nonBlankLineCount: 1 }) : undefined),
		() => true,
		{ model: 'm1', maxSourceBytes: 1024, fallbackToRules, ...(typeof extra === 'object' ? extra : {}) },
		{ info: m => logs.push(m) },
	);
	return { service, calls, genOpts, logs };
}

test('returns model text for a supported non-empty file', async () => {
	const { service } = makeService(async () => 'It bootstraps the app.');
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'ok');
	if (res.status === 'ok' && res.source === 'model') {
		assert.equal(res.text, 'It bootstraps the app.');
		assert.equal(res.fromCache, false);
	}
});

test('caches by file+version+model+mode and skips repeat calls', async () => {
	const { service, calls } = makeService(async () => 'cached answer');
	await service.explain(doc(), 'summary');
	const res = await service.explain(doc(), 'summary');
	assert.equal(calls.length, 1);
	if (res.status === 'ok' && res.source === 'model') {
		assert.equal(res.fromCache, true);
	}
	// A new version re-runs inference.
	await service.explain(doc({ version: 2 }), 'summary');
	assert.equal(calls.length, 2);
});

test('concurrent identical requests share one inference call', async () => {
	let release!: (v: string) => void;
	const gate = new Promise<string>(r => { release = r; });
	const { service, calls } = makeService(() => gate);
	const [a, b] = await Promise.all([service.explain(doc(), 'summary'), service.explain(doc(), 'summary')].map(async p => { setTimeout(() => release('done'), 0); return p; }));
	assert.equal(calls.length, 1);
	assert.deepEqual(a, b);
});

test('Ollama failure returns error with labelled rule-based fallback', async () => {
	const { service } = makeService(async () => { throw new OllamaError('unavailable', 'no server'); });
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.kind, 'unavailable');
		assert.match(res.hint, /ollama serve|baseUrl/);
		assert.ok(res.fallback, 'expected rule-based fallback');
		assert.equal(res.fallback?.summary, 'rules say it exports things');
	}
});

test('fallback is omitted when disabled', async () => {
	const { service } = makeService(async () => { throw new OllamaError('timeout', 'slow'); }, false);
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.fallback, undefined);
	}
});

test('invalid model produces modelMissing with pull instructions', async () => {
	const { service } = makeService(async () => { throw new OllamaError('modelMissing', 'Model "m1" is not available in Ollama.'); });
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.kind, 'modelMissing');
		assert.match(res.hint, /ollama pull m1/);
	}
});

test('timeout produces a timeout hint', async () => {
	const { service } = makeService(async () => { throw new OllamaError('timeout', 'Request timed out'); });
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.kind, 'timeout');
		assert.match(res.hint, /requestTimeoutMs/);
	}
});

test('service logs request outcome without logging file contents', async () => {
	const lines: string[] = [];
	const { service } = makeService(async () => 'ok text');
	// reach into constructor via a second service with logger
	const client = new OllamaClient('http://x', 1, async () => { throw new Error('n/a'); });
	client.generate = async () => 'ok text';
	const svc = new ExplanationService(client, new ExplanationCache<ExplanationResult>(), () => undefined, () => true,
		{ model: 'm1', maxSourceBytes: 1024, fallbackToRules: true }, { info: m => lines.push(m) });
	await svc.explain(doc(), 'summary');
	assert.match(lines.join('\n'), /explain request: file=app.ts/);
	assert.match(lines.join('\n'), /explain success: model=m1/);
	assert.ok(!lines.join('\n').includes('export function main'), 'log must not contain source code');
	void service;
});

test('empty model response is a malformed error, not a crash', async () => {
	const { service } = makeService(async () => '<think>hmm</think>');
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.kind, 'malformed');
	}
});

const sel = { startLine: 3, endLine: 9, text: 'export function helper() {}', before: 'import x from "x";', after: 'main();' };

test('explainSelection sends only the selection and caches by mode+range', async () => {
	const { service, calls } = makeService(async () => 'It maps keys.');
	const res = await service.explainSelection(doc(), sel, 'explain');
	assert.equal(res.status, 'ok');
	assert.match(calls[0], /<selection file="\/w\/app.ts" language="typescript" lines="3-9">/);
	assert.ok(calls[0].includes('export function helper()'), 'selection text is sent');
	assert.ok(!calls[0].includes('export function main() {}'), 'whole file text is not resent');
	assert.match(calls[0], /<context>/);

	// Same selection+mode hits cache; different mode or range re-runs.
	await service.explainSelection(doc(), sel, 'explain');
	assert.equal(calls.length, 1);
	await service.explainSelection(doc(), sel, 'learn');
	assert.equal(calls.length, 2);
	await service.explainSelection(doc(), { ...sel, endLine: 10 }, 'learn');
	assert.equal(calls.length, 3);
});

test('explainSelection short-circuits empty and oversized selections', async () => {
	const { service, calls } = makeService(async () => 'never');
	assert.equal((await service.explainSelection(doc(), { ...sel, text: '   ' }, 'explain')).status, 'empty');
	const big = await service.explainSelection(doc(), { ...sel, text: 'x'.repeat(2048) }, 'explain');
	assert.equal(big.status, 'tooLarge');
	assert.equal(calls.length, 0);
});

test('explainSelection error falls back to rules over the selection', async () => {
	const { service } = makeService(async () => { throw new OllamaError('timeout', 'slow'); });
	const res = await service.explainSelection(doc(), sel, 'explain');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.ok(res.fallback, 'rule-based fallback over the selection');
	}
});

test('generateQuestion returns model text and is never cached', async () => {
	const { service, calls } = makeService(async () => 'What does map return?');
	const res = await service.generateQuestion(doc(), sel);
	assert.equal(res.status, 'ok');
	assert.match(calls[0], /ONE short question/);
	await service.generateQuestion(doc(), sel);
	assert.equal(calls.length, 2, 'each question is a fresh request');
});

test('assessAnswer sends question and answer, returns model text', async () => {
	const { service, calls } = makeService(async () => '## What you got right\nMostly.');
	const res = await service.assessAnswer(doc(), sel, 'What does map return?', 'a new array');
	assert.equal(res.status, 'ok');
	assert.match(calls[0], /<question>\nWhat does map return\?\n<\/question>/);
	assert.match(calls[0], /<answer>\na new array\n<\/answer>/);
});

test('unsupported, empty, and oversized docs short-circuit before inference', async () => {
	const { service, calls } = makeService(async () => 'never called');
	const unsupported = new ExplanationService(
		(new OllamaClient('http://x', 1)), new ExplanationCache<ExplanationResult>(),
		() => undefined, () => false, { model: 'm', maxSourceBytes: 1024, fallbackToRules: true });
	assert.equal((await unsupported.explain(doc({ languageId: 'markdown' }), 'summary')).status, 'unsupported');
	assert.equal((await service.explain(doc({ getText: () => '   \n ' }), 'summary')).status, 'empty');
	const tooLarge = await service.explain(doc({ getText: () => 'x'.repeat(2048) }), 'summary');
	assert.equal(tooLarge.status, 'tooLarge');
	if (tooLarge.status === 'tooLarge') {
		assert.equal(tooLarge.limit, 1024);
	}
	assert.equal(calls.length, 0);
});

test('per-mode num_predict limits keep routine answers short', async () => {
	const { service, genOpts } = makeService(async () => 'ok');
	const sel2 = { startLine: 1, endLine: 1, text: 'const a = 1;', before: undefined, after: undefined };
	await service.explain(doc(), 'summary');
	assert.equal(genOpts[0]?.numPredict, 200);
	await service.explain(doc(), 'detail');
	assert.equal(genOpts[1]?.numPredict, 500);
	await service.explainSelection(doc(), sel2, 'explain');
	assert.equal(genOpts[2]?.numPredict, 300);
	await service.explainSelection(doc(), sel2, 'learn');
	assert.equal(genOpts[3]?.numPredict, 500);
	await service.generateQuestion(doc(), sel2);
	assert.equal(genOpts[4]?.numPredict, 180);
	await service.assessAnswer(doc(), sel2, 'q?', 'a');
	assert.equal(genOpts[5]?.numPredict, 500);
	for (const o of genOpts) {
		assert.equal(o?.keepAlive, '10m', 'model kept warm on every request');
	}
});

test('onToken streams into the model call and logs time to first byte', async () => {
	const { service, logs } = makeService(async (_m, _s, _p, opts) => {
		opts?.onToken?.('partial ');
		opts?.onToken?.('partial text');
		return 'partial text';
	});
	const tokens: string[] = [];
	const res = await service.explain(doc(), 'summary', false, { onToken: t => tokens.push(t) });
	assert.deepEqual(tokens, ['partial ', 'partial text']);
	assert.equal(res.status, 'ok');
	assert.ok(logs.some(l => l.includes('explain first token')), 'time-to-first-token is logged');
});

test('cache hits and in-flight dedupe are logged for performance diagnostics', async () => {
	const { service, calls, logs } = makeService(async () => 'cached');
	await service.explain(doc(), 'summary');
	await service.explain(doc(), 'summary');
	assert.equal(calls.length, 1);
	assert.ok(logs.some(l => l.includes('explain cache hit')), 'cache hit is logged');
	assert.ok(logs.some(l => l.includes('num_predict=200')), 'output cap is logged per request');
});

test('a cancelled request surfaces as an error result, not a crash', async () => {
	const { service } = makeService(async () => {
		throw new OllamaError('cancelled', 'Request was cancelled by a newer update.');
	});
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.kind, 'cancelled');
	}
});

test('findInsight returns model text and caches by content hash', async () => {
	const { service, calls } = makeService(async () => 'The loop rebuilds the index every save.');
	const res = await service.findInsight(doc(), 'h1');
	assert.equal(res.status, 'ok');
	await service.findInsight(doc(), 'h1');
	assert.equal(calls.length, 1, 'same content hash hits cache');
	await service.findInsight(doc(), 'h2');
	assert.equal(calls.length, 2, 'new content re-asks');
});

test('chatAnswer sends question + history, never caches', async () => {
	const { service, calls, genOpts } = makeService(async () => 'It maps inputs.');
	const sel = { startLine: 1, endLine: 1, text: 'x' };
	await service.chatAnswer(doc(), sel, 'what does this do', [{ role: 'user', text: 'earlier' }]);
	assert.match(calls[0], /<user_question>\nwhat does this do/);
	assert.match(calls[0], /<history>/);
	assert.equal(genOpts[0]?.numPredict, 300);
	await service.chatAnswer(doc(), sel, 'what does this do', []);
	assert.equal(calls.length, 2, 'chat is never cached');
});

test('explainDiagnostic caches by diag key and carries num_predict=400', async () => {
	const { service, calls, genOpts } = makeService(async () => 'The error means x may be undefined.');
	const sel = { startLine: 1, endLine: 1, text: 'x.y' };
	const diag = { message: 'possibly undefined', severity: 'error' as const, line: 1 };
	await service.explainDiagnostic(doc(), sel, diag, 'diag:k1');
	await service.explainDiagnostic(doc(), sel, diag, 'diag:k1');
	assert.equal(calls.length, 1);
	assert.equal(genOpts[0]?.numPredict, 400);
});

test('projectOrientation caches by facts hash and caps output', async () => {
	const { service, calls, genOpts } = makeService(async () => 'Looks like a TypeScript web app.');
	await service.projectOrientation('facts-v1', 'orient:k1');
	await service.projectOrientation('facts-v1', 'orient:k1');
	assert.equal(calls.length, 1);
	assert.match(calls[0], /<project_facts>\nfacts-v1/);
	assert.equal(genOpts[0]?.numPredict, 350);
});

test('sessionRecap is never cached', async () => {
	const { service, calls } = makeService(async () => 'You built a form handler.');
	const data = { projectFacts: 'x', touchedFiles: ['a.ts'], history: [] };
	await service.sessionRecap(data);
	await service.sessionRecap(data);
	assert.equal(calls.length, 2);
});

test('detailed depth scales output budgets ~1.5x', async () => {
	const { service, genOpts } = makeService(async () => 'x', { depth: 'detailed' }); // eslint-disable-line
	await service.explain(doc(), 'summary');
	assert.equal(genOpts[0]?.numPredict, 300, 'summary 200 * 1.5');
});
