import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonc, summarizeJson, redactSecrets } from '../jsonc';

	test('valid JSON parses', () => {
		const r = parseJsonc('{"a": 1}');
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(r.value, { a: 1 });
	});

	test('JSONC comments and trailing commas parse', () => {
		const r = parseJsonc(`{
			// a comment
			"compilerOptions": {
				"strict": true, /* inline */
			},
		}`);
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual((r.value as any).compilerOptions.strict, true);
	});

	test('comment-like text inside strings survives', () => {
		const r = parseJsonc('{"url": "https://x//y", "s": "a /* b */ c"}');
		assert.strictEqual(r.ok, true);
		assert.strictEqual((r.value as any).s, 'a /* b */ c');
	});

	test('incomplete JSON reports error, not a value', () => {
		const r = parseJsonc('{"a": ');
		assert.strictEqual(r.ok, false);
		assert.ok(r.error);
	});

	test('empty file reports error', () => {
		assert.strictEqual(parseJsonc('   ').ok, false);
	});

	test('invalid syntax reports error', () => {
		assert.strictEqual(parseJsonc('{nope}').ok, false);
	});

	test('object summary: keys + depth + bounded excerpt', () => {
		const s = summarizeJson('{"name":"x","deps":{"a":1,"b":[1,2,{"c":3}]}}');
		assert.strictEqual(s.ok, true);
		assert.strictEqual(s.kind, 'object');
		assert.deepStrictEqual(s.topLevelKeys, ['name', 'deps']);
		assert.ok(s.maxDepth! >= 3);
		assert.ok(s.excerpt!.includes('"deps"'));
		assert.ok(s.excerpt!.length <= 1600);
	});

	test('array summary', () => {
		const s = summarizeJson('[1, [2, 3]]');
		assert.strictEqual(s.ok, true);
		assert.strictEqual(s.kind, 'array');
	});

	test('invalid JSON surfaces the parse error', () => {
		const s = summarizeJson('{broken');
		assert.strictEqual(s.ok, false);
		assert.ok(s.error);
	});

	test('secret-looking keys are redacted, others kept', () => {
		const out = redactSecrets({
			api_token: 'sk-123',
			password: 'hunter2',
			nested: { 'private-key': 'abc', normal: 'fine' },
			version: '1.0.0',
		}) as any;
		assert.strictEqual(out.api_token, '[redacted]');
		assert.strictEqual(out.password, '[redacted]');
		assert.strictEqual(out.nested['private-key'], '[redacted]');
		assert.strictEqual(out.nested.normal, 'fine');
		assert.strictEqual(out.version, '1.0.0');
	});

	test('summarizeJson excerpt redacts secrets', () => {
		const s = summarizeJson('{"auth":{"token":"topsecret"},"scripts":{"build":"tsc"}}');
		assert.ok(!s.excerpt!.includes('topsecret'));
		assert.ok(s.excerpt!.includes('tsc'));
	});
