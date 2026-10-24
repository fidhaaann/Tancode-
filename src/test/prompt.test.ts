import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt, parseResponse, SYSTEM_PROMPT } from '../model/prompt';

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
