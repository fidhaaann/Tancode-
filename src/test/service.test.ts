import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplanationCache } from '../model/cache';
import { OllamaClient, OllamaError } from '../model/ollama';
import { DocLike, ExplanationResult, ExplanationService } from '../model/service';

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

function makeService(generate: (model: string, sys: string, prompt: string) => Promise<string>, fallbackToRules = true) {
	const calls: string[] = [];
	const client = new OllamaClient('http://127.0.0.1:11434', 5000, async () => {
		throw new Error('not implemented');
	});
	client.generate = async (model, sys, prompt) => {
		calls.push(prompt);
		return generate(model, sys, prompt);
	};
	const service = new ExplanationService(
		client,
		new ExplanationCache<ExplanationResult>(),
		d => (d.getText().includes('export') ? ({ summary: 'rules say it exports things', symbols: [], imports: [], exports: [], details: [], fileName: 'app.ts', languageId: 'typescript', languageName: 'TypeScript', lineCount: 1, nonBlankLineCount: 1 }) : undefined),
		() => true,
		{ model: 'm1', maxSourceBytes: 1024, fallbackToRules },
	);
	return { service, calls };
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

test('empty model response is a malformed error, not a crash', async () => {
	const { service } = makeService(async () => '<think>hmm</think>');
	const res = await service.explain(doc(), 'summary');
	assert.equal(res.status, 'error');
	if (res.status === 'error') {
		assert.equal(res.kind, 'malformed');
	}
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
