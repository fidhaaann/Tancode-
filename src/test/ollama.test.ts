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

function streamRes(lines: string[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			for (const l of lines) {
				c.enqueue(new TextEncoder().encode(l));
			}
			c.close();
		},
	});
	return { ok: true, status: 200, body: stream } as unknown as Response;
}

test('generate sends think:false, keep_alive and per-request num_predict', async () => {
	let sent: Record<string, unknown> = {};
	const client = new OllamaClient(BASE, 5000, async (_url, init) => {
		sent = JSON.parse(String(init?.body));
		return fakeRes(200, { response: 'ok' });
	});
	await client.generate('m1', 's', 'p', { numPredict: 200 });
	assert.equal(sent.think, false);
	assert.equal(sent.keep_alive, '10m');
	assert.equal(sent.stream, false);
	assert.deepEqual(sent.options, { num_predict: 200 });
});

test('streaming generate accumulates chunks and fires onToken', async () => {
	const chunks: string[] = [];
	const client = new OllamaClient(BASE, 5000, async (_url, init) => {
		const sent = JSON.parse(String(init?.body));
		assert.equal(sent.stream, true, 'onToken switches to streaming mode');
		return streamRes([
			'{"response":"Hello ","done":false}\n',
			'{"response":"world","done":false}\n',
			'{"response":"","done":true}\n',
		]);
	});
	const text = await client.generate('m1', 's', 'p', { onToken: t => chunks.push(t) });
	assert.equal(text, 'Hello world');
	assert.deepEqual(chunks, ['Hello ', 'Hello world']);
});

test('stream chunks split across network boundaries are reassembled', async () => {
	const client = new OllamaClient(BASE, 5000, async () =>
		streamRes(['{"resp', 'onse":"Hi","done":false}\n{"response":"","done":true}\n']));
	const text = await client.generate('m1', 's', 'p', { onToken: () => undefined });
	assert.equal(text, 'Hi');
});

test('malformed stream chunk aborts the request as malformed', async () => {
	const client = new OllamaClient(BASE, 5000, async () =>
		streamRes(['{"response":"Hi"}\n', 'not json\n']));
	await assert.rejects(
		client.generate('m', 's', 'p', { onToken: () => undefined }),
		(err: unknown) => err instanceof OllamaError && err.kind === 'malformed'
	);
});

test('thinking fields in stream chunks are ignored, never accumulated', async () => {
	const chunks: string[] = [];
	const client = new OllamaClient(BASE, 5000, async () =>
		streamRes([
			'{"thinking":"hmm","done":false}\n',
			'{"response":"Real.","done":true}\n',
		]));
	const text = await client.generate('m', 's', 'p', { onToken: t => chunks.push(t) });
	assert.equal(text, 'Real.');
	assert.ok(!chunks.some(t => t.includes('hmm')));
});

test('error field in a stream chunk becomes httpError', async () => {
	const client = new OllamaClient(BASE, 5000, async () =>
		streamRes(['{"error":"model crashed"}\n']));
	await assert.rejects(
		client.generate('m', 's', 'p', { onToken: () => undefined }),
		(err: unknown) => err instanceof OllamaError && err.kind === 'httpError'
	);
});

test('user cancellation maps to cancelled, not timeout', async () => {
	const ac = new AbortController();
	const client = new OllamaClient(BASE, 5000, (_url, init) =>
		new Promise<Response>((_res, rej) => {
			init?.signal?.addEventListener('abort', () =>
				rej(new DOMException('Aborted', 'AbortError')));
		}));
	const pending = client.generate('m', 's', 'p', { signal: ac.signal });
	ac.abort();
	await assert.rejects(
		pending,
		(err: unknown) => err instanceof OllamaError && err.kind === 'cancelled'
	);
});
