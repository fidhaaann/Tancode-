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
