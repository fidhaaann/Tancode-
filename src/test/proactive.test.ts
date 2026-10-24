import assert from 'node:assert/strict';
import test from 'node:test';
import { diagKey, hashContent, pickDiagnostic, ProactiveBudget } from '../proactive';

test('diagKey is stable per file+line+code+message', () => {
	const d = { severity: 0, message: 'cannot find x', line: 5, code: 'TS2304' };
	assert.equal(diagKey('file:///a.ts', d), diagKey('file:///a.ts', { ...d }));
	assert.notEqual(diagKey('file:///a.ts', d), diagKey('file:///b.ts', d));
	assert.notEqual(diagKey('file:///a.ts', d), diagKey('file:///a.ts', { ...d, line: 6 }));
});

test('pickDiagnostic prefers the first error, then warnings', () => {
	const diags = [
		{ severity: 1, message: 'w1', line: 2 },
		{ severity: 0, message: 'e2', line: 9 },
		{ severity: 0, message: 'e1', line: 3 },
		{ severity: 2, message: 'info', line: 1 },
	];
	assert.equal(pickDiagnostic(diags, false)?.message, 'e1');
	// errors-only mode ignores warnings entirely
	assert.equal(pickDiagnostic([{ severity: 1, message: 'w', line: 1 }], true), undefined);
	assert.equal(pickDiagnostic(diags, true)?.message, 'e1');
});

test('budget allows once, dedupes repeats, enforces cooldown', () => {
	let now = 1000;
	const b = new ProactiveBudget(5000, 3, () => now);
	assert.equal(b.check('k1'), 'allow');
	b.commit('k1');
	assert.equal(b.check('k1'), 'seen');
	assert.equal(b.check('k2'), 'cooldown');
	now += 5001;
	assert.equal(b.check('k2'), 'allow');
	b.commit('k2');
	now += 5001;
	b.commit('k3');
	assert.equal(b.messagesPosted, 3);
	now += 5001;
	assert.equal(b.check('k4'), 'limit');
});

test('blocked keys are not marked seen — they can still post later', () => {
	let now = 0;
	const b = new ProactiveBudget(1000, 5, () => now);
	b.commit('first');
	assert.equal(b.check('second'), 'cooldown');
	now += 1001;
	assert.equal(b.check('second'), 'allow', 'cooldown block must not consume the key');
});

test('hashContent is deterministic and short', () => {
	assert.equal(hashContent('hello'), hashContent('hello'));
	assert.notEqual(hashContent('a'), hashContent('b'));
	assert.ok(hashContent('x'.repeat(1000)).length < 12);
});
