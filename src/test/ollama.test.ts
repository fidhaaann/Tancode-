import assert from 'node:assert/strict';
import test from 'node:test';
import { FetchImpl, OllamaClient, OllamaError } from '../model/ollama';

function fakeRes(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	} as Response;
}

const BASE = 'http://127.0.0.1:11434';

test('generate posts to /api/generate and returns the response text', async () => {
	let called: { url: string; body: string } | undefined;
	const fetchImpl: FetchImpl = async (url, init) => {
		called = { url, body: String(init?.body) };
		return fakeRes(200, { response: 'It prints hello.' });
	};
	const client = new OllamaClient(BASE, 5000, fetchImpl);
	const text = await client.generate('m1', 'sys', 'prompt');
	assert.equal(text, 'It prints hello.');
	assert.equal(called?.url, `${BASE}/api/generate`);
	const sent = JSON.parse(called!.body);
	assert.equal(sent.model, 'm1');
	assert.equal(sent.system, 'sys');
	assert.equal(sent.stream, false);
});

test('404 from /api/generate becomes modelMissing', async () => {
	const client = new OllamaClient(BASE, 5000, async () => fakeRes(404, 'model not found'));
	await assert.rejects(
		client.generate('nope', '', ''),
		(err: unknown) => err instanceof OllamaError && err.kind === 'modelMissing'
	);
});

test('connection refusal becomes unavailable', async () => {
	const client = new OllamaClient(BASE, 5000, async () => {
		throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
	});
	await assert.rejects(
		client.generate('m', '', ''),
		(err: unknown) => err instanceof OllamaError && err.kind === 'unavailable'
	);
});

test('non-JSON body becomes malformed', async () => {
	const bad = {
		ok: true, status: 200,
		json: async () => { throw new SyntaxError('bad json'); },
		text: async () => 'nope',
	} as unknown as Response;
	const client = new OllamaClient(BASE, 5000, async () => bad);
	await assert.rejects(
		client.generate('m', '', ''),
		(err: unknown) => err instanceof OllamaError && err.kind === 'malformed'
	);
});

test('ollama error field becomes httpError', async () => {
	const client = new OllamaClient(BASE, 5000, async () => fakeRes(200, { error: 'model crashed' }));
	await assert.rejects(
		client.generate('m', '', ''),
		(err: unknown) => err instanceof OllamaError && err.kind === 'httpError'
	);
});

test('checkHealth lists installed models', async () => {
	const client = new OllamaClient(BASE, 5000, async (url) =>
		url.endsWith('/api/tags') ? fakeRes(200, { models: [{ name: 'qwen3:8b' }, { name: 'llama3' }] }) : fakeRes(404, {}));
	const health = await client.checkHealth();
	assert.equal(health.reachable, true);
	assert.deepEqual(health.models, ['qwen3:8b', 'llama3']);
});

test('checkHealth reports unreachable server without throwing', async () => {
	const client = new OllamaClient(BASE, 5000, async () => {
		throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
	});
	const health = await client.checkHealth();
	assert.equal(health.reachable, false);
	assert.equal(health.error?.kind, 'unavailable');
});
