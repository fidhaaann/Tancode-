// Lightweight, deterministic project orientation — vscode-free and bounded so
// it is unit-testable and cheap: one directory listing at the root plus a
// package manifest read, never a repo-wide scan. Facts go to the model; the
// model explains them. Anything not established here stays unsaid.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectFacts {
	root: string;
	name: string;
	/** e.g. { typescript: 12, python: 3 } — counts of top-level-ish source files. */
	languages: Record<string, number>;
	/** package.json fields that actually exist. */
	manifest?: {
		scripts: string[];
		dependencies: string[];
		devDependencies: string[];
	};
	/** other config files spotted at the root (tsconfig.json, pyproject.toml, …). */
	configFiles: string[];
	/** top-level directories, common noise excluded. */
	directories: string[];
	/** plausible entry points found (src/index.ts, main.py, …). */
	entryCandidates: string[];
	readmeExcerpt?: string;
}

const IGNORED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'out', 'build', 'coverage', '__pycache__',
	'.venv', 'venv', '.idea', '.vscode-test', 'target', 'vendor',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
	'.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
	'.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.java': 'java',
	'.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.c': 'c', '.h': 'c/c++', '.cpp': 'c++',
	'.cs': 'csharp', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
	'.html': 'html', '.css': 'css', '.scss': 'css', '.vue': 'vue', '.svelte': 'svelte',
};

const CONFIG_FILES = [
	'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'requirements.txt',
	'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
	'.csproj', 'Dockerfile', 'docker-compose.yml', 'Makefile', '.eslintrc',
	'.eslintrc.json', 'vite.config.ts', 'vite.config.js', 'next.config.js',
];

const ENTRY_FILES = [
	'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'src/app.ts',
	'src/app.js', 'src/extension.ts', 'src/server.ts', 'src/server.js',
	'index.ts', 'index.js', 'main.ts', 'main.js', 'main.py', 'app.py',
	'src/main.py', 'src/main.rs', 'src/main.go', 'cmd/main.go',
];

const MAX_DIR_LIST = 40;
const MAX_LANG_COUNT_FILES = 300;
const MAX_README_CHARS = 600;

// One-level deep: root entries, and for each top-level dir a peek inside to
// count languages — still bounded and never recursive past depth 2.
function scanLanguages(root: string, topDirs: string[]): Record<string, number> {
	const langs: Record<string, number> = {};
	let scanned = 0;
	const bump = (file: string): void => {
		const lang = LANGUAGE_BY_EXT[path.extname(file).toLowerCase()];
		if (lang) {
			langs[lang] = (langs[lang] ?? 0) + 1;
		}
	};
	try {
		for (const e of fs.readdirSync(root, { withFileTypes: true })) {
			if (e.isFile() && scanned < MAX_LANG_COUNT_FILES) {
				bump(e.name);
				scanned++;
			}
		}
		for (const dir of topDirs) {
			if (scanned >= MAX_LANG_COUNT_FILES) {
				break;
			}
			try {
				for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
					if (scanned >= MAX_LANG_COUNT_FILES) {
						break;
					}
					if (e.isFile()) {
						bump(e.name);
						scanned++;
					} else if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) {
						try {
							for (const f of fs.readdirSync(path.join(root, dir, e.name))) {
								if (scanned >= MAX_LANG_COUNT_FILES) {
									break;
								}
								bump(f);
								scanned++;
							}
						} catch { /* unreadable subdir — skip */ }
					}
				}
			} catch { /* unreadable dir — skip */ }
		}
	} catch { /* unreadable root */ }
	return langs;
}

export function collectProjectFacts(root: string): ProjectFacts {
	const facts: ProjectFacts = {
		root,
		name: path.basename(root),
		languages: {},
		configFiles: [],
		directories: [],
		entryCandidates: [],
	};

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return facts; // unreadable root — hand back the empty shell
	}

	facts.directories = entries
		.filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
		.map(e => e.name)
		.slice(0, MAX_DIR_LIST);

	for (const cfg of CONFIG_FILES) {
		if (entries.some(e => e.isFile() && e.name === cfg)) {
			facts.configFiles.push(cfg);
		}
	}
	for (const rel of ENTRY_FILES) {
		try {
			if (fs.statSync(path.join(root, rel)).isFile()) {
				facts.entryCandidates.push(rel);
			}
		} catch { /* not present */ }
	}

	const pkg = entries.find(e => e.isFile() && e.name === 'package.json');
	if (pkg) {
		try {
			const json = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
			facts.manifest = {
				scripts: Object.keys(json.scripts ?? {}),
				dependencies: Object.keys(json.dependencies ?? {}),
				devDependencies: Object.keys(json.devDependencies ?? {}),
			};
			if (typeof json.name === 'string' && json.name.length > 0) {
				facts.name = json.name;
			}
		} catch { /* malformed manifest — leave it out */ }
	}

	const readme = entries.find(e => e.isFile() && /^readme(\.\w+)?$/i.test(e.name));
	if (readme) {
		try {
			facts.readmeExcerpt = fs
				.readFileSync(path.join(root, readme.name), 'utf8')
				.replace(/\s+/g, ' ')
				.slice(0, MAX_README_CHARS);
		} catch { /* unreadable */ }
	}

	facts.languages = scanLanguages(root, facts.directories);
	return facts;
}

const MAX_LIST = 25;

function fmtList(items: string[], cap = MAX_LIST): string {
	if (items.length === 0) {
		return 'none';
	}
	const shown = items.slice(0, cap).join(', ');
	return items.length > cap ? `${shown}, …(+${items.length - cap})` : shown;
}

// The facts block embedded in the orientation prompt — plain text, bounded.
export function formatFacts(f: ProjectFacts): string {
	const langs = Object.entries(f.languages)
		.sort((a, b) => b[1] - a[1])
		.map(([l, n]) => `${l} (${n})`);
	const lines = [
		`Project name: ${f.name}`,
		`Languages seen: ${fmtList(langs)}`,
		`Top-level directories: ${fmtList(f.directories)}`,
		`Config files: ${fmtList(f.configFiles)}`,
		`Entry point candidates: ${fmtList(f.entryCandidates)}`,
	];
	if (f.manifest) {
		lines.push(`package.json scripts: ${fmtList(f.manifest.scripts)}`);
		lines.push(`dependencies: ${fmtList(f.manifest.dependencies)}`);
		lines.push(`devDependencies: ${fmtList(f.manifest.devDependencies)}`);
	}
	if (f.readmeExcerpt) {
		lines.push(`README excerpt: ${f.readmeExcerpt}`);
	}
	return lines.join('\n');
}
