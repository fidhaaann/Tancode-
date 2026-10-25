import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildAssessmentPrompt,
	buildChatPrompt,
	buildChatRequest,
	buildDiagnosticPrompt,
	buildInsightPrompt,
	buildManifestInsightPrompt,
	buildOrientationPrompt,
	buildPrompt,
	buildWrapupPrompt,
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

test('detail prompt carries the previous explanation for expansion', () => {
	const prompt = buildPrompt(
		{ fileName: 'a.ts', languageId: 'typescript', text: 'const x = 1;' },
		'detail',
		true,
		'The short explanation.',
	);
	assert.match(prompt.prompt, /<previous_explanation>\nThe short explanation\.\n<\/previous_explanation>/);
	assert.match(prompt.prompt, /Expand and correct this earlier explanation/);
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

test('diagnostic prompt marks the diagnostic confirmed and causes inferred', () => {
	const parts = buildDiagnosticPrompt(
		{ fileName: 'a.ts', languageId: 'typescript', text: 'x.y' },
		{ startLine: 1, endLine: 1, text: 'x.y' },
		{ message: 'Object is possibly undefined', severity: 'error', line: 1, code: 'TS2532' },
	);
	assert.match(parts.prompt, /confirmed error at line 1/);
	assert.match(parts.prompt, /<diagnostic>\n\[TS2532\] Object is possibly undefined/);
	assert.match(parts.prompt, /inference|likely/i);
	assert.match(parts.prompt, /follow-up question/i);
});

test('diagnostic prompt preserves evidence metadata and teaches a fix without applying it', () => {
	const parts = buildDiagnosticPrompt(
		{ fileName: 'styles.css', languageId: 'css', text: '.x { color: var(--missing); }' },
		{ startLine: 1, endLine: 1, text: '.x { color: var(--missing); }' },
		{
			message: 'Unknown custom property',
			severity: 'warning',
			line: 1,
			column: 15,
			endLine: 1,
			endColumn: 29,
			source: 'css-language-features',
			evidence: 'confirmed-diagnostic',
		},
	);
	assert.match(parts.prompt, /styles\.css:1:15/);
	assert.match(parts.prompt, /provider: css-language-features/);
	assert.match(parts.prompt, /What happened/);
	assert.match(parts.prompt, /suggest, never apply/);
});

test('insight prompt asks for one grounded insight or NONE', () => {
	const parts = buildInsightPrompt({ fileName: 'a.ts', languageId: 'typescript', text: 'code' });
	assert.match(parts.prompt, /ONE concise insight/);
	assert.match(parts.prompt, /reply with exactly: NONE/);
	assert.match(parts.prompt, /<file>\ncode\n<\/file>/);
});

test('chat prompt bounds history and marks user question untrusted', () => {
	const parts = buildChatPrompt(
		{ fileName: 'a.ts', languageId: 'typescript', text: 'file body' },
		{ startLine: 1, endLine: 2, text: 'x' },
		'what does x do?',
		[{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
	);
	assert.match(parts.prompt, /<history>\nUser: hi\nTancode: hello\n<\/history>/);
	assert.match(parts.prompt, /<user_question>\nwhat does x do\?\n<\/user_question>/);
	assert.match(parts.prompt, /<selection/);
	// without a selection, the file body is the context
	const noSel = buildChatPrompt(
		{ fileName: 'a.ts', languageId: 'typescript', text: 'file body' },
		undefined, 'q', []);
	assert.match(noSel.prompt, /<file>\nfile body\n<\/file>/);
});

test('chat request keeps current user text separate from prior role history', () => {
	const request = buildChatRequest(
		doc,
		undefined,
		'What is a REST API?',
		[{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi!' }],
		'framework: node',
	);
	assert.equal(request.messages.at(-1)?.role, 'user');
	assert.equal(request.messages.at(-1)?.content, 'What is a REST API?');
	assert.deepEqual(request.messages.slice(0, 2), [
		{ role: 'user', content: 'Hello' },
		{ role: 'assistant', content: 'Hi!' },
	]);
	assert.ok(!request.system.includes('Explain this typescript file'));
	assert.match(request.system, /<project_context>/);
	assert.match(request.system, /<file name="app\.ts"/);
});

test('orientation prompt is grounded only in observed facts', () => {
	const parts = buildOrientationPrompt('Project name: demo\nLanguages seen: typescript (5)');
	assert.match(parts.prompt, /facts that were\s*actually observed|actually observed on disk/);
	assert.match(parts.prompt, /<project_facts>\nProject name: demo/);
	assert.match(parts.prompt, /Do not invent files, behavior, or structure/);
});

test('wrapup prompt carries session evidence and explain-back questions', () => {
	const parts = buildWrapupPrompt({
		projectFacts: 'Project name: demo',
		touchedFiles: ['a.ts', 'b.ts'],
		history: [{ role: 'user', text: 'why a promise?' }],
	});
	assert.match(parts.prompt, /<touched_files>\na\.ts\nb\.ts/);
	assert.match(parts.prompt, /<session_conversation>/);
	assert.match(parts.prompt, /Can you explain it back to me/);
	assert.match(parts.prompt, /two optional questions/);
	assert.match(parts.prompt, /Never claim they mastered/);
});

test('learn + diagnostic prompts include simplified-guidance only when enabled', () => {
	const doc2 = { fileName: 'a.ts', languageId: 'typescript', text: 'x' };
	const sel = { startLine: 1, endLine: 1, text: 'x' };
	const diag = { message: 'm', severity: 'error' as const, line: 1 };
	assert.match(buildSelectionPrompt(doc2, sel, 'learn', true).prompt, /In plain terms/);
	assert.ok(!buildSelectionPrompt(doc2, sel, 'learn', false).prompt.includes('In plain terms'));
	assert.match(buildDiagnosticPrompt(doc2, sel, diag, true).prompt, /plain-language/);
	assert.ok(!buildDiagnosticPrompt(doc2, sel, diag, false).prompt.includes('plain-language'));
});

test('manifest insight prompt is evidence-only, NONE allowed', () => {
	const p = buildManifestInsightPrompt('tsconfig.json', 'engines.node: >=20 — declared');
	assert.ok(p.prompt.includes('project_profile'));
	assert.ok(p.prompt.includes('engines.node: >=20'));
	assert.ok(p.prompt.includes('NONE'));
	assert.ok(p.prompt.includes('Never claim a version is installed'));
});

test('chat prompt embeds project context when provided', () => {
	const doc = { fileName: 'app.ts', languageId: 'typescript', text: 'x' };
	const withCtx = buildChatPrompt(doc, undefined, 'which node version?', []);
	assert.ok(!withCtx.prompt.includes('<project_context>'));
	const ctx = buildChatPrompt(doc, undefined, 'which node version?', [], 'engines.node: >=20');
	assert.ok(ctx.prompt.includes('<project_context>'));
	assert.ok(ctx.prompt.includes('engines.node: >=20'));
});
