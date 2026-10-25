import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectProjectFacts, formatFacts } from '../project';
import { effectiveCooldownSeconds } from '../proactive';

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tancode-proj-'));
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
		name: 'demo-app',
		scripts: { dev: 'vite', build: 'tsc' },
		dependencies: { react: '^18', express: '^4' },
		devDependencies: { typescript: '^5' },
	}));
	fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
	fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
	fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const y = 2;');
	fs.writeFileSync(path.join(root, 'README.md'), '# Demo App\n\nA small test project.\n');
	fs.writeFileSync(path.join(root, 'node_modules', 'ignored.ts'), 'x');
	return root;
}

test('collectProjectFacts reads manifest, dirs, languages and entry points', () => {
	const root = fixture();
	try {
		const f = collectProjectFacts(root);
		assert.equal(f.name, 'demo-app');
		assert.deepEqual(f.manifest?.scripts, ['dev', 'build']);
		assert.deepEqual(f.manifest?.dependencies, ['react', 'express']);
		assert.ok(f.configFiles.includes('tsconfig.json'));
		assert.ok(f.directories.includes('src'));
		assert.ok(!f.directories.includes('node_modules'), 'noise dirs excluded');
		assert.equal(f.languages.typescript, 2);
		assert.ok(f.entryCandidates.includes('src/index.ts'));
		assert.ok(f.entryCandidates.includes('src/app.ts'));
		assert.match(f.readmeExcerpt ?? '', /Demo App/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('formatFacts produces a bounded, plain-text evidence block', () => {
	const root = fixture();
	try {
		const text = formatFacts(collectProjectFacts(root));
		assert.match(text, /Project name: demo-app/);
		assert.match(text, /typescript \(2\)/);
		assert.match(text, /src\/index\.ts/);
		assert.ok(text.length < 4000, 'facts stay bounded');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('unreadable or empty roots produce an empty fact shell, not a throw', () => {
	const f = collectProjectFacts('/definitely/not/a/real/path-xyz');
	assert.equal(f.languages && Object.keys(f.languages).length, 0);
	assert.equal(f.manifest, undefined);
});

test('frequency maps to cooldowns; custom defers to the explicit setting', () => {
	assert.equal(effectiveCooldownSeconds('low', 90), 300);
	assert.equal(effectiveCooldownSeconds('balanced', 90), 90);
	assert.equal(effectiveCooldownSeconds('high', 90), 30);
	assert.equal(effectiveCooldownSeconds('custom', 137), 137);
});

// --- Technology profile -----------------------------------------------------

import { collectTechProfile, formatTechProfile } from '../project';

function mkEmpty(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'tancode-tech-'));
}

	test('declared vs resolved vs engines classified correctly', () => {
		const root = mkEmpty();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
			name: 'myproj',
			scripts: { build: 'tsc', test: 'mocha' },
			engines: { node: '>=20' },
			dependencies: { react: '5.2.1' },
			devDependencies: { typescript: '^5.0.0' },
		}));
		fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
			packages: {
				'': {},
				'node_modules/typescript': { version: '5.2.1' },
				'node_modules/react': { version: '5.2.1' },
			},
		}));
		const p = collectTechProfile(root);
		assert.strictEqual(p.name, 'myproj');
		assert.strictEqual(p.engines.node, '>=20');
		assert.strictEqual(p.hasLockfile, true);
		const ts = p.dependencies.find(d => d.name === 'typescript')!;
		assert.ok(ts.declared!.startsWith('^5.0.0'));
		assert.strictEqual(ts.resolved, '5.2.1');
		// exact declared (react 5.2.1) == resolved → no conflict
		assert.strictEqual(p.conflicts.length, 0);
	});

	test('missing lockfile → resolved stays undefined, no claim of install', () => {
		const root = mkEmpty();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.18.0' } }));
		const p = collectTechProfile(root);
		assert.strictEqual(p.hasLockfile, false);
		assert.strictEqual(p.dependencies[0].resolved, undefined);
		const text = formatTechProfile(p);
		assert.ok(text.includes('No lockfile'));
		assert.ok(!/installed/i.test(text.replace('not the installed version', '')));
	});

	test('exact declared != resolved surfaces a conflict', () => {
		const root = mkEmpty();
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { lodash: '4.17.20' } }));
		fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.21' } } }));
		const p = collectTechProfile(root);
		assert.ok(p.conflicts.some(c => c.includes('lodash')));
	});

	test('tsconfig strict/target/module extracted via JSONC parse', () => {
		const root = mkEmpty();
		fs.writeFileSync(root + '/tsconfig.json', '{ // comment\n "compilerOptions": { "strict": true, "target": "ES2020", "module": "commonjs", },\n}');
		const p = collectTechProfile(root);
		assert.strictEqual(p.tsconfig?.strict, true);
		assert.strictEqual(p.tsconfig?.target, 'ES2020');
		assert.strictEqual(p.tsconfig?.module, 'commonjs');
	});

	test('invalid tsconfig is skipped, not guessed', () => {
		const root = mkEmpty();
		fs.writeFileSync(root + '/tsconfig.json', '{broken');
		assert.strictEqual(collectTechProfile(root).tsconfig, undefined);
	});

	test('.nvmrc recorded as toolchain file, not a runtime', () => {
		const root = mkEmpty();
		fs.writeFileSync(root + '/.nvmrc', '20\n');
		const p = collectTechProfile(root);
		assert.ok(p.toolchainFiles.some(t => t.startsWith('.nvmrc: 20')));
		assert.ok(formatTechProfile(p).includes('not the running version'));
	});

	test('runtime probe reports a real detected version', () => {
		const root = mkEmpty();
		const p = collectTechProfile(root, () => ({ tool: 'node', version: 'v22.1.0' }));
		assert.strictEqual(p.runtime?.version, 'v22.1.0');
		assert.ok(formatTechProfile(p).includes('Detected local runtime'));
	});

	test('failing probe leaves runtime unknown', () => {
		const root = mkEmpty();
		const p = collectTechProfile(root, () => { throw new Error('no node'); });
		assert.strictEqual(p.runtime, undefined);
	});

	test('non-JSON manifests text-extracted conservatively', () => {
		const root = mkEmpty();
		fs.writeFileSync(root + '/requirements.txt', 'flask>=2.0\nrequests==2.31.0\n# comment\n');
		fs.writeFileSync(root + '/go.mod', 'module example.com/x\n\ngo 1.22\n');
		fs.writeFileSync(root + '/Dockerfile', 'FROM node:20-alpine\nRUN build\n');
		const p = collectTechProfile(root);
		const text = p.otherManifests.join(' ');
		assert.ok(text.includes('flask'));
		assert.ok(text.includes('module example.com/x'));
		assert.ok(text.includes('go 1.22'));
		assert.ok(text.includes('node:20-alpine'));
	});

	test('secrets in package.json are redacted from the profile', () => {
		const root = mkEmpty();
		fs.writeFileSync(root + '/package.json', JSON.stringify({ config: { api_token: 'secret123' }, name: 'x' }));
		const text = formatTechProfile(collectTechProfile(root));
		assert.ok(!text.includes('secret123'));
	});

	test('npm-lock v1 dependencies format also resolves', () => {
		const root = mkEmpty();
		fs.writeFileSync(root + '/package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
		fs.writeFileSync(root + '/package-lock.json', JSON.stringify({ dependencies: { react: { version: '18.3.1' } } }));
		assert.strictEqual(collectTechProfile(root).dependencies[0].resolved, '18.3.1');
	});
