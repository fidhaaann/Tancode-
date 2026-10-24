import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBody, renderDocument } from '../view';

test('model text is HTML-escaped before rendering', () => {
	const html = renderBody({
		kind: 'model', fileName: 'x.ts', languageName: 'TypeScript', model: 'm', mode: 'summary',
		text: 'Look! <script>alert(1)</script>', fromCache: false,
	});
	assert.ok(!html.includes('<script>alert(1)</script>'));
	assert.ok(html.includes('&lt;script&gt;'));
});

test('file names from the workspace are escaped', () => {
	const html = renderBody({ kind: 'empty', fileName: '<img src=x onerror=alert(1)>.ts' });
	assert.ok(!html.includes('<img'));
});

test('document carries a restrictive CSP and a nonce script', () => {
	const html = renderDocument({ kind: 'noEditor' }, 'NONCE123');
	assert.match(html, /default-src 'none'/);
	assert.match(html, /script-src 'nonce-NONCE123'/);
	assert.match(html, /<script nonce="NONCE123">/);
});

test('rule-based fallback is explicitly labelled not AI-generated', () => {
	const fake = { fileName: 'a.ts', languageId: 'typescript', languageName: 'TypeScript', lineCount: 1, nonBlankLineCount: 1, summary: 's', symbols: [], imports: [], exports: [], details: [] };
	const html = renderBody({ kind: 'error', fileName: 'a.ts', languageName: 'TypeScript', model: 'm', message: 'down', hint: 'start it', fallback: fake });
	assert.match(html, /not AI-generated/i);
});
