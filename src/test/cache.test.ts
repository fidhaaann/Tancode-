import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplanationCache } from '../model/cache';

test('cache stores and returns by key', () => {
	const c = new ExplanationCache<string>();
	const k = ExplanationCache.key('file:///a.ts', 1, 'm', 'summary');
	c.set(k, 'v1');
	assert.equal(c.get(k), 'v1');
});

test('different versions, models, and modes produce different keys', () => {
	const base = ExplanationCache.key('file:///a.ts', 1, 'm', 'summary');
	assert.notEqual(base, ExplanationCache.key('file:///a.ts', 2, 'm', 'summary'));
	assert.notEqual(base, ExplanationCache.key('file:///a.ts', 1, 'm2', 'summary'));
	assert.notEqual(base, ExplanationCache.key('file:///a.ts', 1, 'm', 'detail'));
	assert.notEqual(base, ExplanationCache.key('file:///b.ts', 1, 'm', 'summary'));
});

test('cache evicts the least recently used entry past maxEntries', () => {
	const c = new ExplanationCache<string>(2);
	c.set('a', '1');
	c.set('b', '2');
	c.get('a'); // refresh a
	c.set('c', '3'); // evicts b
	assert.equal(c.get('a'), '1');
	assert.equal(c.get('b'), undefined);
	assert.equal(c.get('c'), '3');
});
