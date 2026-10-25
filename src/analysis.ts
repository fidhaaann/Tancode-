import * as path from 'node:path';
import * as vscode from 'vscode';
import { summarizeJson } from './jsonc';
import { FILE_TYPES, isSupportedFile } from './fileTypes';

export interface SymbolInfo {
	kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'component' | 'constant' | 'method';
	name: string;
	line: number;
}

export interface FileExplanation {
	fileName: string;
	languageId: string;
	languageName: string;
	lineCount: number;
	nonBlankLineCount: number;
	summary: string;
	symbols: SymbolInfo[];
	imports: string[];
	exports: string[];
	details: string[];
}

const SUPPORTED_LANGUAGES = new Set([
	'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
	'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'scala',
	'json', 'jsonc',
]);
for (const fileType of FILE_TYPES) {
	for (const languageId of fileType.languageIds) SUPPORTED_LANGUAGES.add(languageId);
}

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
	typescript: 'TypeScript',
	typescriptreact: 'TypeScript React (TSX)',
	javascript: 'JavaScript',
	javascriptreact: 'JavaScript React (JSX)',
	python: 'Python',
	java: 'Java',
	c: 'C',
	cpp: 'C++',
	csharp: 'C#',
	go: 'Go',
	rust: 'Rust',
	php: 'PHP',
	ruby: 'Ruby',
	swift: 'Swift',
	kotlin: 'Kotlin',
	scala: 'Scala',
	json: 'JSON',
	jsonc: 'JSON with Comments',
	css: 'CSS',
	scss: 'SCSS',
	sass: 'Sass',
	less: 'Less',
	html: 'HTML',
	markdown: 'Markdown',
};

const MAX_SYMBOLS = 50;
const MAX_IMPORTS = 20;

interface DeclPattern {
	kind: SymbolInfo['kind'];
	pattern: RegExp;
}

// Declaration patterns per language family. Intentionally simple
// line-based regexes: this milestone is rule-based heuristics, not a
// parser. They favour precision over recall.
const JS_FAMILY_PATTERNS: DeclPattern[] = [
	{ kind: 'class', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'type', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
	{ kind: 'enum', pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'function', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'constant', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>/ },
	{ kind: 'function', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/ },
	{ kind: 'constant', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/ },
];

const PY_PATTERNS: DeclPattern[] = [
	{ kind: 'class', pattern: /^\s*class\s+([A-Za-z_][\w]*)/ },
	{ kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
];

const JAVA_FAMILY_PATTERNS: DeclPattern[] = [
	{ kind: 'class', pattern: /^\s*(?:public|private|protected|abstract|final|static|sealed|non-sealed|\s)*\s*class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'interface', pattern: /^\s*(?:public|private|protected|abstract|\s)*\s*(?:@?interface|interface)\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'enum', pattern: /^\s*(?:public|private|protected|\s)*\s*enum\s+([A-Za-z_$][\w$]*)/ },
	{ kind: 'function', pattern: /^\s*(?:public|private|protected|static|final|abstract|synchronized|async|inline|\s)*\s*[\w$<>\[\].,\s?]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws[\w\s,.]+)?\s*\{/ },
];

const GO_PATTERNS: DeclPattern[] = [
	{ kind: 'function', pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/ },
	{ kind: 'type', pattern: /^type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/ },
];

const RUST_PATTERNS: DeclPattern[] = [
	{ kind: 'function', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
	{ kind: 'class', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
	{ kind: 'enum', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/ },
	{ kind: 'type', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
];

const RUBY_PATTERNS: DeclPattern[] = [
	{ kind: 'class', pattern: /^\s*class\s+([A-Za-z_][\w:]*)/ },
	{ kind: 'type', pattern: /^\s*module\s+([A-Za-z_][\w:]*)/ },
	{ kind: 'function', pattern: /^\s*def\s+([A-Za-z_][\w!?=]*)/ },
];

// Structural fallback for JSON documents: top-level keys, shape, and depth
// from the tolerant JSONC parse. Invalid/incomplete JSON is reported as
// such — we never pretend a broken document is valid.
function explainJson(
	document: Pick<vscode.TextDocument, 'languageId' | 'fileName' | 'uri' | 'getText'>,
	text: string,
	languageId: string,
	languageName: string,
): FileExplanation {
	const fileName = path.basename(document.fileName);
	const lines = text.split(/\r?\n/);
	const nonBlank = lines.filter(l => l.trim().length > 0).length;
	const parsed = summarizeJson(text);

	const summaryParts: string[] = [];
	const details: string[] = [`Language: ${languageName}`, `Lines: ${lines.length} total, ${nonBlank} non-blank`];
	if (parsed.ok) {
		summaryParts.push(`This is a ${languageName} ${parsed.kind} document`);
		if (parsed.topLevelKeys && parsed.topLevelKeys.length > 0) {
			summaryParts.push(`with ${parsed.topLevelKeys.length} top-level ${parsed.topLevelKeys.length === 1 ? 'key' : 'keys'}: ${parsed.topLevelKeys.slice(0, 8).join(', ')}${parsed.topLevelKeys.length > 8 ? ', …' : ''}.`);
			details.push(`Top-level keys: ${parsed.topLevelKeys.join(', ')}`);
		} else {
			summaryParts.push('.');
		}

		if (parsed.maxDepth !== undefined && parsed.maxDepth > 2) {
			details.push(`Nesting depth: ${parsed.maxDepth}`);
		}
	} else {
		summaryParts.push(`This ${languageName} file does not currently parse (${parsed.error}). It may be incomplete while editing or contain a syntax error — see editor diagnostics.`);
	}

	return {
		fileName,
		languageId,
		languageName,
		lineCount: lines.length,
		nonBlankLineCount: nonBlank,
		summary: summaryParts.join(''),
		symbols: [],
		imports: [],
		exports: [],
		details,
	};
}

function explainCss(
	document: Pick<vscode.TextDocument, 'fileName' | 'getText'>,
	languageId: string,
	languageName: string,
): FileExplanation {
	const text = document.getText();
	const lines = text.split(/\r?\n/);
	const selectors = [...text.matchAll(/(^|})\s*([^@{}\s][^{}]*)\s*\{/gm)]
		.map(match => match[2].trim())
		.filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
		.slice(0, MAX_SYMBOLS);
	const variables = [...text.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, MAX_SYMBOLS);
	const imports = [...text.matchAll(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?/g)].map(m => m[1]).slice(0, MAX_IMPORTS);
	const mediaQueries = [...text.matchAll(/@media\s+([^{]+)/g)].map(m => m[1].trim()).slice(0, 10);
	const nonBlank = lines.filter(l => l.trim()).length;
	const details = [
		`Language: ${languageName}`,
		`Lines: ${lines.length} total, ${nonBlank} non-blank`,
		`Selectors (${selectors.length}): ${selectors.join(', ') || 'none detected'}`,
		`Custom properties (${variables.length}): ${variables.join(', ') || 'none detected'}`,
	];
	if (mediaQueries.length > 0) details.push(`Media queries: ${mediaQueries.join('; ')}`);
	return {
		fileName: path.basename(document.fileName),
		languageId,
		languageName,
		lineCount: lines.length,
		nonBlankLineCount: nonBlank,
		summary: `${path.basename(document.fileName)} is a ${languageName} stylesheet with ${selectors.length} selector${selectors.length === 1 ? '' : 's'} and ${variables.length} custom propert${variables.length === 1 ? 'y' : 'ies'}${mediaQueries.length > 0 ? `, plus ${mediaQueries.length} media quer${mediaQueries.length === 1 ? 'y' : 'ies'}` : ''}.`,
		symbols: selectors.map(name => ({ kind: 'constant' as const, name, line: Math.max(1, lines.findIndex(line => line.includes(name)) + 1) })),
		imports,
		exports: [],
		details,
	};
}

const SWIFT_KOTLIN_PATTERNS: DeclPattern[] = [
	{ kind: 'class', pattern: /^\s*(?:public|private|internal|open|final|data|abstract|\s)*\s*class\s+([A-Za-z_][\w]*)/ },
	{ kind: 'interface', pattern: /^\s*(?:public|private|internal|\s)*\s*protocol\s+([A-Za-z_][\w]*)/ },
	{ kind: 'enum', pattern: /^\s*(?:public|private|internal|\s)*\s*enum\s+([A-Za-z_][\w]*)/ },
	{ kind: 'class', pattern: /^\s*(?:public|private|internal|\s)*\s*struct\s+([A-Za-z_][\w]*)/ },
	{ kind: 'function', pattern: /^\s*(?:public|private|internal|static|override|suspend|\s)*\s*func\s+([A-Za-z_][\w]*)/ },
	{ kind: 'function', pattern: /^\s*(?:public|private|internal|override|suspend|inline|\s)*\s*fun\s+([A-Za-z_][\w]*)/ },
];

function patternsFor(languageId: string): DeclPattern[] {
	switch (languageId) {
		case 'typescript':
		case 'typescriptreact':
		case 'javascript':
		case 'javascriptreact':
		case 'php':
			return JS_FAMILY_PATTERNS;
		case 'python':
			return PY_PATTERNS;
		case 'java':
		case 'c':
		case 'cpp':
		case 'csharp':
		case 'scala':
			return JAVA_FAMILY_PATTERNS;
		case 'go':
			return GO_PATTERNS;
		case 'rust':
			return RUST_PATTERNS;
		case 'ruby':
			return RUBY_PATTERNS;
		case 'swift':
		case 'kotlin':
			return SWIFT_KOTLIN_PATTERNS;
		default:
			return [];
	}
}

const IMPORT_PATTERNS: Record<string, RegExp> = {
	default: /^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/,
	python: /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/,
	go: /^\s*(?:import\s+)?"([^"]+)"/,
	rust: /^\s*use\s+([\w:]+)/,
	java: /^\s*import\s+([\w.]+)/,
	ruby: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
};

export function isSupported(document: { languageId: string; fileName?: string }): boolean {
	return SUPPORTED_LANGUAGES.has(document.languageId) || (document.fileName ? isSupportedFile(document.fileName, document.languageId) : false);
}

export function explain(document: Pick<vscode.TextDocument, 'languageId' | 'fileName' | 'uri' | 'getText'>): FileExplanation | undefined {
	if (!isSupported(document)) {
		return undefined;
	}
	const text = document.getText();
	if (text.trim().length === 0) {
		return undefined;
	}

	const languageId = document.languageId;
	const languageName = LANGUAGE_DISPLAY_NAMES[languageId] ?? languageId;

	// JSON files get a structural summary from the tolerant parser — no
	// declaration/import pattern scanning.
	if (languageId === 'json' || languageId === 'jsonc') {
		return explainJson(document, text, languageId, languageName);
	}
	if (languageId === 'css' || languageId === 'scss' || languageId === 'sass' || languageId === 'less') {
		return explainCss(document, languageId, languageName);
	}
	const fileName = path.basename(document.uri.fsPath) || document.uri.path.split('/').pop() || 'untitled';

	const lines = text.split(/\r?\n/);
	const nonBlank = lines.filter(l => l.trim().length > 0).length;

	const symbols: SymbolInfo[] = [];
	const imports: string[] = [];
	const exportsFound: string[] = [];
	const declPatterns = patternsFor(languageId);
	const importPattern = IMPORT_PATTERNS[languageId] ?? IMPORT_PATTERNS.default;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const { kind, pattern } of declPatterns) {
			const m = line.match(pattern);
			if (m && m[1]) {
				let kindFinal = kind;
				if (kind === 'constant' && /^[A-Z]/.test(m[1]) && (languageId === 'typescriptreact' || languageId === 'javascriptreact')) {
					kindFinal = 'component';
				}
				symbols.push({ kind: kindFinal, name: m[1], line: i + 1 });
				break;
			}
		}
		const im = line.match(importPattern);
		if (im && imports.length < MAX_IMPORTS) {
			const spec = im[1] ?? im[2];
			if (spec && !imports.includes(spec)) {
				imports.push(spec);
			}
		}
		if (/^\s*export\s+default\s+/.test(line)) {
			const dm = line.match(/^\s*export\s+default\s+(?:class\s+|function\s+)?([A-Za-z_$][\w$]*)?/);
			if (dm && dm[1]) {
				exportsFound.push(`default export: ${dm[1]}`);
			}
		} else if (/^\s*export\s*\{/.test(line)) {
			exportsFound.push('named exports');
		}
	}

	if (symbols.length > MAX_SYMBOLS) {
		symbols.length = MAX_SYMBOLS;
	}

	const byKind = new Map<string, number>();
	for (const s of symbols) {
		byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
	}
	const kindCounts = [...byKind.entries()]
		.map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`)
		.join(', ');

	const summaryParts: string[] = [];
	summaryParts.push(`${fileName} is a ${languageName} file with ${nonBlank} lines of code.`);
	if (kindCounts) {
		summaryParts.push(`It declares ${kindCounts}.`);
	} else {
		summaryParts.push('No top-level function, class, or type declarations were detected.');
	}
	const hasJsx = languageId === 'typescriptreact' || languageId === 'javascriptreact' || /<[A-Za-z][^>]*>/.test(text);
	if (hasJsx && symbols.some(s => s.kind === 'component' || /^[A-Z]/.test(s.name))) {
		summaryParts.push('It appears to define UI component(s).');
	}
	if (imports.length > 0) {
		summaryParts.push(`It imports from ${imports.length} module${imports.length > 1 ? 's' : ''}.`);
	}
	if (exportsFound.includes('named exports') || exportsFound.some(e => e.startsWith('default'))) {
		summaryParts.push('It exposes exports for other files to use.');
	}

	const details: string[] = [];
	details.push(`Language: ${languageName}`);
	details.push(`Lines: ${lines.length} total, ${nonBlank} non-blank`);
	if (imports.length > 0) {
		details.push(`Imports: ${imports.join(', ')}`);
	}
	const commentLines = lines.filter(l => /^\s*(\/\/|#|\/\*|\*)/.test(l)).length;
	if (commentLines > 0) {
		details.push(`Comment lines (approx.): ${commentLines}`);
	}
	const symbolsByLine = [...symbols].sort((a, b) => a.line - b.line);
	if (symbolsByLine.length > 0) {
		details.push('Declarations (line: kind name):');
		for (const s of symbolsByLine) {
			details.push(`  ${s.line}: ${s.kind} ${s.name}`);
		}
	}

	return {
		fileName,
		languageId,
		languageName,
		lineCount: lines.length,
		nonBlankLineCount: nonBlank,
		summary: summaryParts.join(' '),
		symbols: symbolsByLine,
		imports,
		exports: exportsFound,
		details,
	};
}
