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

// --- Project technology profile ------------------------------------------------
//
// Version evidence is classified, never guessed:
//   declared  — a range/requirement in a manifest ("typescript": "^5.0.0")
//   resolved  — a concrete version pinned by a lockfile (package-lock "5.2.1")
//   runtime   — a locally detected tool version (only when explicitly probed)
//   unknown   — no usable evidence
// Declared ≠ installed, and a conflict is shown, never silently resolved.

import { parseJsonc, redactSecrets } from './jsonc';

export type VersionKind = 'declared' | 'resolved' | 'runtime' | 'unknown';

export interface DepEvidence {
	name: string;
	declared?: string;   // range/requirement from the manifest
	resolved?: string;   // concrete version from a lockfile
}

export interface TechProfile {
	root: string;
	name?: string;
	dependencies: DepEvidence[];
	engines: Record<string, string>;
	scripts: string[];
	tsconfig?: {
		strict?: boolean;
		target?: string;
		module?: string;
	};
	/** e.g. '.nvmrc: 20' — a declared toolchain preference, not a runtime. */
	toolchainFiles: string[];
	/** manifests detected but only text-extracted: 'requirements.txt (3 deps)' etc. */
	otherManifests: string[];
	hasLockfile: boolean;
	/** discrepancies we can state factually (exact declared != resolved). */
	conflicts: string[];
	/** only set when the caller supplies a working runtime probe. */
	runtime?: { tool: string; version: string };
}

const MAX_DEPS = 60;
const MAX_CONFLICTS = 10;

function readIfExists(root: string, rel: string): string | undefined {
	try {
		return fs.readFileSync(path.join(root, rel), 'utf8');
	} catch {
		return undefined;
	}
}

// package-lock.json v2/v3 (and npm-shrinkwrap): name → resolved version.
// v3 nests under "packages" with "node_modules/<name>" keys; v2/v1 use
// "dependencies". Handles both conservatively.
function resolvedFromNpmLock(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const parsed = parseJsonc(text);
	if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
		return out;
	}
	const lock = parsed.value as Record<string, unknown>;
	const pkgs = lock.packages;
	if (pkgs && typeof pkgs === 'object') {
		for (const [key, meta] of Object.entries(pkgs as Record<string, unknown>)) {
			const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : undefined;
			const version = (meta as Record<string, unknown>)?.version;
			if (name && typeof version === 'string' && !name.includes('node_modules')) {
				out.set(name, version);
			}
		}
	}
	const deps = lock.dependencies;
	if (deps && typeof deps === 'object') {
		for (const [name, meta] of Object.entries(deps as Record<string, unknown>)) {
			const version = (meta as Record<string, unknown>)?.version;
			if (typeof version === 'string' && !out.has(name)) {
				out.set(name, version);
			}
		}
	}
	return out;
}

function isExactVersion(v: string): boolean {
	return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);
}

function npmProfile(root: string, profile: TechProfile): void {
	const raw = readIfExists(root, 'package.json');
	if (!raw) {
		return;
	}
	const parsed = parseJsonc(raw);
	if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
		return;
	}
	const pkg = redactSecrets(parsed.value) as Record<string, unknown>;
	if (typeof pkg.name === 'string') {
		profile.name = pkg.name;
	}
	profile.scripts = Object.keys((pkg.scripts as Record<string, unknown>) ?? {});
	const engines = pkg.engines as Record<string, unknown> | undefined;
	if (engines) {
		for (const [k, v] of Object.entries(engines)) {
			if (typeof v === 'string') {
				profile.engines[k] = v;
			}
		}
	}

	const declared = new Map<string, string>();
	for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
		const deps = pkg[section] as Record<string, unknown> | undefined;
		if (deps) {
			for (const [name, v] of Object.entries(deps)) {
				if (typeof v === 'string' && !declared.has(name)) {
					declared.set(name, `${v} (${section === 'dependencies' ? 'runtime dep' : 'dev/optional'})`);
				}
			}
		}
	}

	const lockRaw = readIfExists(root, 'package-lock.json') ?? readIfExists(root, 'npm-shrinkwrap.json');
	profile.hasLockfile = lockRaw !== undefined;
	const resolved = lockRaw ? resolvedFromNpmLock(lockRaw) : new Map<string, string>();

	profile.dependencies = [...declared.entries()]
		.slice(0, MAX_DEPS)
		.map(([name, spec]) => ({
			name,
			declared: spec,
			resolved: resolved.get(name),
		}));

	// Factual conflicts only: exact declared version != lockfile-resolved.
	for (const dep of profile.dependencies) {
		if (dep.resolved && dep.declared && profile.conflicts.length < MAX_CONFLICTS) {
			const bare = dep.declared.split(' ')[0];
			if (isExactVersion(bare) && bare !== dep.resolved) {
				profile.conflicts.push(`${dep.name}: manifest pins ${bare} but lockfile resolved ${dep.resolved}`);
			}
		}
	}
}

function tsconfigProfile(root: string, profile: TechProfile): void {
	const raw = readIfExists(root, 'tsconfig.json');
	if (!raw) {
		return;
	}
	const parsed = parseJsonc(raw);
	if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
		return; // invalid tsconfig — don't guess
	}
	const cfg = parsed.value as Record<string, unknown>;
	const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
	profile.tsconfig = {
		strict: typeof opts.strict === 'boolean' ? opts.strict : undefined,
		target: typeof opts.target === 'string' ? opts.target : undefined,
		module: typeof opts.module === 'string' ? opts.module : undefined,
	};
}

// Non-JSON manifests: presence + conservative dependency-name extraction.
// No format is treated as JSON; each gets a plain-text parse.
function otherManifests(root: string, profile: TechProfile): void {
	const reqs = readIfExists(root, 'requirements.txt');
	if (reqs) {
		const names = reqs.split('\n')
			.map(l => l.trim())
			.filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('-'))
			.map(l => l.split(/[=<>~!\[\s]/)[0])
			.filter(Boolean)
			.slice(0, 30);
		profile.otherManifests.push(`requirements.txt (${names.length} deps: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''})`);
	}
	const pyproject = readIfExists(root, 'pyproject.toml');
	if (pyproject) {
		profile.otherManifests.push('pyproject.toml');
	}
	const gomod = readIfExists(root, 'go.mod');
	if (gomod) {
		const mod = gomod.match(/^module\s+(\S+)/m)?.[1];
		const go = gomod.match(/^go\s+([\d.]+)/m)?.[1];
		profile.otherManifests.push(`go.mod${mod ? ` (module ${mod}${go ? `, go ${go}` : ''})` : ''}`);
	}
	const cargo = readIfExists(root, 'Cargo.toml');
	if (cargo) {
		const deps = cargo.match(/^\[dependencies\]\s*\n([\s\S]*?)(?=^\[|\s*$)/m)?.[1]
			?.split('\n').map(l => l.split('=')[0].trim()).filter(l => /^[\w-]+$/.test(l)).slice(0, 20);
		profile.otherManifests.push(`Cargo.toml${deps?.length ? ` (${deps.length} deps: ${deps.slice(0, 8).join(', ')})` : ''}`);
	}
	const composer = readIfExists(root, 'composer.json');
	if (composer) {
		profile.otherManifests.push('composer.json');
	}
	const gemfile = readIfExists(root, 'Gemfile');
	if (gemfile) {
		const gems = [...gemfile.matchAll(/gem\s+['"]([\w-]+)['"]/g)].map(m => m[1]).slice(0, 20);
		profile.otherManifests.push(`Gemfile${gems.length ? ` (${gems.length} gems: ${gems.slice(0, 8).join(', ')})` : ''}`);
	}
	const dockerfile = readIfExists(root, 'Dockerfile');
	if (dockerfile) {
		const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1];
		profile.otherManifests.push(`Dockerfile${from ? ` (base image ${from})` : ''}`);
	}
}

export function collectTechProfile(
	root: string,
	probeRuntime?: () => { tool: string; version: string } | undefined,
): TechProfile {
	const profile: TechProfile = {
		root,
		dependencies: [],
		engines: {},
		scripts: [],
		toolchainFiles: [],
		otherManifests: [],
		hasLockfile: false,
		conflicts: [],
	};

	npmProfile(root, profile);
	tsconfigProfile(root, profile);
	otherManifests(root, profile);

	for (const f of ['.nvmrc', '.node-version']) {
		const v = readIfExists(root, f)?.trim();
		if (v) {
			profile.toolchainFiles.push(`${f}: ${v}`);
		}
	}
	if (probeRuntime) {
		try {
			const rt = probeRuntime();
			if (rt) {
				profile.runtime = rt;
			}
		} catch { /* probe failed — runtime stays unknown */ }
	}
	return profile;
}

// Bounded plain-text profile for prompts — classified per the spec so the
// model can state evidence honestly instead of guessing versions.
export function formatTechProfile(p: TechProfile): string {
	const lines: string[] = [];
	if (p.name) {
		lines.push(`Project: ${p.name}`);
	}
	if (p.scripts.length > 0) {
		lines.push(`Scripts (declared commands, not run): ${p.scripts.slice(0, 15).join(', ')}`);
	}
	for (const [tool, spec] of Object.entries(p.engines)) {
		lines.push(`engines.${tool}: ${spec} — declared compatibility requirement, NOT the installed version`);
	}
	for (const dep of p.dependencies.slice(0, 30)) {
		const parts = [`${dep.name}: declared ${dep.declared}`];
		parts.push(dep.resolved ? `resolved ${dep.resolved} (lockfile)` : 'no lockfile-resolved version recorded');
		lines.push(parts.join(', '));
	}
	if (!p.hasLockfile && p.dependencies.length > 0) {
		lines.push('No lockfile found — resolved versions are unknown; declared ranges only.');
	}
	if (p.tsconfig) {
		const t = p.tsconfig;
		lines.push(`tsconfig compilerOptions: strict=${t.strict ?? 'unset'} target=${t.target ?? 'unset'} module=${t.module ?? 'unset'}`);
	}
	for (const tf of p.toolchainFiles) {
		lines.push(`Toolchain file: ${tf} — declared preference, not the running version`);
	}
	if (p.runtime) {
		lines.push(`Detected local runtime: ${p.runtime.tool} ${p.runtime.version} (probed on this machine)`);
	}
	for (const m of p.otherManifests) {
		lines.push(`Other manifest: ${m}`);
	}
	for (const c of p.conflicts) {
		lines.push(`CONFLICT: ${c}`);
	}
	return lines.join('\n');
}
