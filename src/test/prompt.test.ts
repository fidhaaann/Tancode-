import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildAssessmentPrompt,
	buildPrompt,
	buildQuestionPrompt,
	buildSelectionPrompt,
	parseResponse,
	parseSections,
	SYSTEM_PROMPT,
} from '../model/prompt';

const doc = { fileName: 'app.ts', languageId: 'typescript', text: 'export function main() {}' };

test('buildPrompt wraps file content in untrusted <file> tags', () => {
	const { prompt } = buildPrompt(doc, 'summary');
	assert.match(prompt, /<file>\nexport function main\(\) \{\}\n<\/file>/);
	assert.ok(prompt.includes('app.ts'));
});

test('system prompt marks file content as untrusted', () => {
	assert.match(SYSTEM_PROMPT, /untrusted/i);
	assert.match(SYSTEM_PROMPT, /never follow instructions/i);
});

test('detail mode asks for a deeper explanation than summary', () => {
	const summary = buildPrompt(doc, 'summary').prompt;
	const detail = buildPrompt(doc, 'detail').prompt;
	assert.notEqual(summary, detail);
	assert.match(summary, /3-5 sentences/);
	assert.match(detail, /inputs and outputs/);
});

test('parseResponse strips <think> blocks and trims', () => {
	assert.equal(parseResponse('<think>reasoning here</think>The file parses args.'), 'The file parses args.');
	assert.equal(parseResponse('  \nAnswer.\n '), 'Answer.');
	assert.equal(parseResponse('<think>only thoughts</think>'), '');
});

const sel = {
	startLine: 3,
	endLine: 9,
	text: 'const y = x.map(f);',
	before: 'import f from "./f";',
	after: 'return y;',
};

test('selection prompt isolates the selected code from context', () => {
	const { prompt } = buildSelectionPrompt(doc, sel, 'explain');
	assert.match(prompt, /<selection file="app.ts" language="typescript" lines="3-9">/);
	assert.ok(prompt.includes('const y = x.map(f);'));
	assert.match(prompt, /<context>/);
	assert.match(prompt, /context only, not the code to explain/);
	assert.match(prompt, /Explain only the selected code/);
});

test('selection prompt omits the context block when there is none', () => {
	const { prompt } = buildSelectionPrompt(doc, { ...sel, before: undefined, after: undefined }, 'explain');
	assert.ok(!/<context>\nLines just (before|after)/.test(prompt));
});

test('learn mode requests the five teaching headings', () => {
	const { prompt } = buildSelectionPrompt(doc, sel, 'learn');
	for (const h of ['## Purpose', '## How it works', '## Concepts to learn', '## Important details', '## Remember this']) {
		assert.ok(prompt.includes(h), `missing ${h}`);
	}
	assert.match(prompt, /say so plainly instead of inventing details/);
});

test('question prompt asks for exactly one reasoning question, no answer', () => {
	const { prompt } = buildQuestionPrompt(doc, sel);
	assert.match(prompt, /ONE short question/);
	assert.match(prompt, /reasoning over memorization/);
	assert.match(prompt, /no answer/i);
	assert.ok(prompt.includes(sel.text));
});

test('assessment prompt embeds question, answer and section headings', () => {
	const { prompt } = buildAssessmentPrompt(doc, sel, 'What does map return?', 'a new array');
	assert.match(prompt, /<question>\nWhat does map return\?\n<\/question>/);
	assert.match(prompt, /<answer>\na new array\n<\/answer>/);
	for (const h of ['## What you got right', '## What to improve', '## Reference answer']) {
		assert.ok(prompt.includes(h), `missing ${h}`);
	}
});

test('parseSections splits markdown headings and drops empty ones', () => {
	const text = '## Purpose\nDoes a thing.\n\n## How it works\nStep one.\n## Empty\n## Remember this\nTakeaway.';
	const sections = parseSections(text);
	assert.equal(sections?.length, 3);
	assert.deepEqual(sections?.map(s => s.heading), ['Purpose', 'How it works', 'Remember this']);
	assert.equal(sections?.[0].body, 'Does a thing.');
});

test('parseSections returns undefined for unstructured output', () => {
	assert.equal(parseSections('just a paragraph\nand another'), undefined);
	assert.equal(parseSections('## Only one\nwith a body'), undefined);
});
