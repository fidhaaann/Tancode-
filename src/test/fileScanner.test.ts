import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findProjectFile, readProjectFile, scanProjectFiles } from '../fileScanner';
import { fileTypeFor, isSupportedFile, languageIdFor } from '../fileTypes';

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tancode-scan-'));
	fs.mkdirSync(path.join(root, 'packages', 'web', 'src'), { recursive: true });
	fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
	fs.writeFileSync(path.join(root, 'packages', 'web', 'src', 'app.css'), ':root { --brand: red; }');
	fs.writeFileSync(path.join(root, 'packages', 'web', 'src', 'page.html'), '<main>Hello</main>');
	fs.writeFileSync(path.join(root, 'packages', 'web', 'src', 'app.tsx'), 'export const App = () => <main />;');
	fs.writeFileSync(path.join(root, '.env.example'), 'API_URL=http://localhost');
	fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:20');
	fs.writeFileSync(path.join(root, 'README.md'), '# Demo');
	fs.writeFileSync(path.join(root, 'node_modules', 'ignored.css'), 'body {}');
	fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0, 1, 2]));
	fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
	fs.writeFileSync(path.join(root, 'ignored.txt'), 'not included');
	return root;
}

test('registry recognizes extensions and special hidden/config filenames', () => {
	assert.equal(fileTypeFor('styles.scss')?.id, 'css');
	assert.equal(languageIdFor('.env.example'), 'ini');
	assert.equal(fileTypeFor('Dockerfile')?.id, 'docker');
	assert.equal(isSupportedFile('component.tsx'), true);
	assert.equal(isSupportedFile('unknown.bin'), false);
});

test('scanner recursively discovers nested files and reports exclusions', () => {
	const root = fixture();
	try {
		const scan = scanProjectFiles(root);
		const paths = scan.discovered.map(f => f.relativePath.replace(/\\/g, '/'));
		assert.ok(paths.includes('packages/web/src/app.css'));
		assert.ok(paths.includes('packages/web/src/page.html'));
		assert.ok(paths.includes('.env.example'));
		assert.ok(paths.includes('Dockerfile'));
		assert.ok(scan.skipped.some(f => f.relativePath.includes('node_modules') && f.reason === 'excluded directory'));
		assert.ok(scan.skipped.some(f => f.reason === 'binary file'));
		assert.ok(scan.skipped.some(f => f.relativePath === 'ignored.txt' && f.reason === '.gitignore'));
		const css = findProjectFile(root, 'packages/web/src/app.css');
		assert.ok(css);
		assert.match(readProjectFile(css!), /--brand/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('scanner can include generated directories when configured', () => {
	const root = fixture();
	try {
		const scan = scanProjectFiles(root, { includeGenerated: true });
		assert.ok(scan.discovered.some(f => f.relativePath.includes('node_modules')));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
