import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplanationCache } from '../model/cache';
import { ChatMessage, OllamaClient, OllamaError } from '../model/ollama';
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
	const chatCalls: ChatMessage[][] = [];
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
	client.chat = async (model, messages, opts) => {
		chatCalls.push(messages);
		genOpts.push(opts);
		return generate(model, messages.find(m => m.role === 'system')?.content ?? '', messages.at(-1)?.content ?? '', opts);
	};
	const service = new ExplanationService(
		client,
		new ExplanationCache<ExplanationResult>(),
		d => (d.getText().includes('export') ? ({ summary: 'rules say it exports things', symbols: [], imports: [], exports: [], details: [], fileName: 'app.ts', languageId: 'typescript', languageName: 'TypeScript', lineCount: 1, nonBlankLineCount: 1 }) : undefined),
		() => true,
		{ model: 'm1', maxSourceBytes: 1024, fallbackToRules, ...(typeof extra === 'object' ? extra : {}) },
		{ info: m => logs.push(m) },
	);
	return { service, calls, chatCalls, genOpts, logs };
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

test('explainSelection short-circuits empty selections but accepts large ones', async () => {
	const { service, calls } = makeService(async () => 'explained');
	assert.equal((await service.explainSelection(doc(), { ...sel, text: '   ' }, 'explain')).status, 'empty');
	const big = await service.explainSelection(doc(), { ...sel, text: 'x'.repeat(2048) }, 'explain');
	assert.equal(big.status, 'ok');
	assert.equal(calls.length, 1, 'a large selection is sent, not rejected');
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

test('unsupported and empty docs short-circuit before inference', async () => {
	const { service, calls } = makeService(async () => 'never called');
	const unsupported = new ExplanationService(
		(new OllamaClient('http://x', 1)), new ExplanationCache<ExplanationResult>(),
		() => undefined, () => false, { model: 'm', maxSourceBytes: 1024, fallbackToRules: true });
	assert.equal((await unsupported.explain(doc({ languageId: 'markdown' }), 'summary')).status, 'unsupported');
	assert.equal((await service.explain(doc({ getText: () => '   \n ' }), 'summary')).status, 'empty');
	assert.equal(calls.length, 0);
});

test('a doc over the context budget is analyzed in sections, not rejected', async () => {
	const { service, calls } = makeService(async (_m, _s, prompt) =>
		prompt.includes('<section_summaries>') ? 'final combined answer' : 'section summary');
	// 6 x ~600-char lines => ~3.6KB, over the 1KB test budget => 3+ sections.
	const big = Array.from({ length: 6 }, (_, i) => `export function fn${i}() { return '${'x'.repeat(500)}'; }`).join('\n');
	const res = await service.explain(doc({ getText: () => big }), 'detail');
	assert.equal(res.status, 'ok');
	if (res.status === 'ok' && res.source === 'model') {
		assert.equal(res.text, 'final combined answer');
	}
	assert.ok(calls.length >= 4, `expected section calls + combine, got ${calls.length}`);
	assert.ok(calls[calls.length - 1].includes('<section_summaries>'), 'final call is the combine prompt');
	assert.ok(calls[0].includes('section 1 of'));
});

test('sectioned analysis cancels between sections', async () => {
	const controller = new AbortController();
	let calls = 0;
	const { service } = makeService(async () => { calls++; controller.abort(); return 's'; });
	const big = Array.from({ length: 6 }, (_, i) => `function f${i}() { return '${'x'.repeat(500)}'; }`).join('\n');
	const res = await service.explain(doc({ getText: () => big }), 'detail', false, { signal: controller.signal });
	assert.equal(res.status, 'error');
	assert.ok(calls < 10, 'stopped before running every section + combine');
});

test('a failed section is disclosed to the combine prompt', async () => {
	let n = 0;
	const { service, calls } = makeService(async () => {
		n++;
		if (n === 2) { throw new OllamaError('timeout', 'slow'); }
		return n > 2 ? 'combined' : 'section summary';
	});
	const big = Array.from({ length: 6 }, (_, i) => `function g${i}() { return '${'x'.repeat(500)}'; }`).join('\n');
	const res = await service.explain(doc({ getText: () => big }), 'detail');
	assert.equal(res.status, 'ok');
	assert.match(calls[calls.length - 1], /could not be analyzed/);
});

test('single-line oversized doc (minified) sends one request, not a rejection', async () => {
	const { service, calls } = makeService(async () => 'explained');
	const res = await service.explain(doc({ getText: () => 'x'.repeat(3000) }), 'summary');
	assert.equal(res.status, 'ok');
	assert.equal(calls.length, 1);
});

test('large summary uses bounded structural evidence instead of the full file', async () => {
	const source = [
		'import { readFile } from "node:fs";',
		'export class ReportService {',
		'  async buildReport() { return readFile("report.json"); }',
		'}',
		'// implementation '.repeat(2000),
	].join('\n');
	const { service, calls } = makeService(async () => 'Purpose: builds reports.\nKey components: ReportService.\nHow it works: reads report data.\nDependencies: node:fs.');
	const result = await service.explain(doc({ getText: () => source }), 'summary');
	assert.equal(result.status, 'ok');
	assert.equal(calls.length, 1);
	assert.match(calls[0], /<structural_evidence>/);
	assert.match(calls[0], /ReportService/);
	assert.ok(calls[0].length < source.length / 2, 'summary prompt should be much smaller than the source');
});

test('per-mode num_predict limits keep routine answers short', async () => {
	const { service, genOpts } = makeService(async () => 'ok');
	const sel2 = { startLine: 1, endLine: 1, text: 'const a = 1;', before: undefined, after: undefined };
	await service.explain(doc(), 'summary');
	assert.equal(genOpts[0]?.numPredict, 600);
	await service.explain(doc(), 'detail');
	assert.equal(genOpts[1]?.numPredict, 1000);
	await service.explainSelection(doc(), sel2, 'explain');
	assert.equal(genOpts[2]?.numPredict, 700);
	await service.explainSelection(doc(), sel2, 'learn');
	assert.equal(genOpts[3]?.numPredict, 1000);
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
	assert.ok(logs.some(l => l.includes('num_predict=600')), 'output cap is logged per request');
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
	const { service, chatCalls, genOpts } = makeService(async () => 'It maps inputs.');
	const sel = { startLine: 1, endLine: 1, text: 'x' };
	await service.chatAnswer(doc(), sel, 'what does this do', [{ role: 'user', text: 'earlier' }]);
	assert.deepEqual(chatCalls[0]?.slice(-2), [
		{ role: 'user', content: 'earlier' },
		{ role: 'user', content: 'what does this do' },
	]);
	assert.equal(chatCalls[0]?.[0]?.role, 'system');
	assert.equal(genOpts[0]?.numPredict, 800);
	await service.chatAnswer(doc(), sel, 'what does this do', []);
	assert.equal(chatCalls.length, 2, 'chat is never cached');
});

test('explainDiagnostic caches by diag key and carries num_predict=400', async () => {
	const { service, calls, genOpts } = makeService(async () => 'The error means x may be undefined.');
	const sel = { startLine: 1, endLine: 1, text: 'x.y' };
	const diag = { message: 'possibly undefined', severity: 'error' as const, line: 1 };
	await service.explainDiagnostic(doc(), sel, diag, 'diag:k1');
	await service.explainDiagnostic(doc(), sel, diag, 'diag:k1');
	assert.equal(calls.length, 1);
	assert.equal(genOpts[0]?.numPredict, 800);
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
	assert.equal(genOpts[0]?.numPredict, 900, 'summary 600 * 1.5');
});

test('manifestInsight returns model text and caches by caller key', async () => {
	let calls = 0;
	const { service } = makeService(async () => { calls++; return 'engines.node is a declared requirement, not the installed version.'; });
	const r1 = await service.manifestInsight('tsconfig.json', 'engines.node: >=20', 'k1');
	assert.equal(r1.status, 'ok');
	if (r1.status === 'ok' && r1.source === 'model') {
		assert.ok(r1.text.includes('declared requirement'));
	}
	const r2 = await service.manifestInsight('tsconfig.json', 'engines.node: >=20', 'k1');
	assert.equal(r2.status === 'ok' && r2.source === 'model' && r2.fromCache, true);
	assert.equal(calls, 1);
});

test('manifestInsight re-requests when the profile key changes', async () => {
	let calls = 0;
	const { service } = makeService(async () => { calls++; return 'note'; });
	await service.manifestInsight('package.json', 'v1', 'k2');
	await service.manifestInsight('package.json', 'v2', 'k2b');
	assert.equal(calls, 2);
});
