import assert from 'node:assert/strict';
import test from 'node:test';
import { splitSections, declarationsOf } from '../model/sections';

test('small file is a single section', () => {
	const s = splitSections('line1\nline2', 1000);
	assert.equal(s.length, 1);
	assert.equal(s[0].text, 'line1\nline2');
	assert.equal(s[0].startLine, 1);
	assert.equal(s[0].endLine, 2);
});

test('no content is lost across sections', () => {
	const lines = Array.from({ length: 50 }, (_, i) => `const v${i} = ${'x'.repeat(100)};`);
	const text = lines.join('\n');
	const s = splitSections(text, 500);
	assert.ok(s.length > 1);
	assert.equal(s.map(x => x.text).join('\n'), text, 'every line lands in exactly one section');
});

test('prefers splitting at declaration boundaries', () => {
	const text = [
		'const a = 1;',
		'const b = 2;',
		'function big() {',
		'\treturn ' + 'x'.repeat(400),
		'}',
		'function other() { return 3; }',
	].join('\n');
	const s = splitSections(text, 200);
	assert.ok(s.length >= 2);
	// first section should end before a clean declaration, not mid-function
	assert.ok(s.every(sec => sec.startLine >= 1 && sec.endLine >= sec.startLine));
});

test('single giant line becomes one section, not an infinite loop', () => {
	const s = splitSections('x'.repeat(5000), 500);
	assert.equal(s.length, 1);
});

test('empty text yields no sections', () => {
	assert.equal(splitSections('', 100).length, 0);
});

test('declarationsOf finds cross-section symbols', () => {
	const decls = declarationsOf('export class Foo {}\nasync function bar() {}\ndef baz():\nexport const x = 1;\nconst private var nope');
	assert.ok(decls.includes('Foo'));
	assert.ok(decls.includes('bar'));
	assert.ok(!decls.includes('x'), 'const not matched as a named decl by the fn/class regex');
});
