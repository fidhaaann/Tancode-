import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileTypeFor, languageIdFor, FileCategory } from './fileTypes';

export interface ProjectFile {
	relativePath: string;
	absolutePath: string;
	languageId: string;
	category: FileCategory;
	size: number;
}

export interface ScanOptions {
	excludeDirs?: readonly string[];
	includeGenerated?: boolean;
	maxFileBytes?: number;
}

export interface ProjectScan {
	discovered: ProjectFile[];
	skipped: Array<{ relativePath: string; reason: string }>;
	failed: Array<{ relativePath: string; reason: string }>;
}

const DEFAULT_EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor'];
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.woff', '.woff2', '.ttf', '.eot', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm']);
const MAX_DEFAULT_BYTES = 2 * 1024 * 1024;

function ignoredByGit(root: string, relativePath: string): boolean {
	try {
		const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
		return gitignore.split(/\r?\n/).some(line => {
			const pattern = line.trim().replace(/^\//, '').replace(/\/$/, '');
			return pattern.length > 0 && !pattern.startsWith('#') && (relativePath === pattern || relativePath.startsWith(`${pattern}/`));
		});
	} catch {
		return false;
	}
}

function looksBinary(filePath: string): boolean {
	const extension = path.extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(extension)) return true;
	try {
		const bytes = fs.readFileSync(filePath).subarray(0, 4096);
		return bytes.includes(0);
	} catch {
		return false;
	}
}

export function scanProjectFiles(root: string, options: ScanOptions = {}): ProjectScan {
	const excluded = new Set(options.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
	const maxBytes = options.maxFileBytes ?? MAX_DEFAULT_BYTES;
	const result: ProjectScan = { discovered: [], skipped: [], failed: [] };
	const visit = (directory: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			result.failed.push({ relativePath: path.relative(root, directory), reason: `read directory: ${(error as Error).message}` });
			return;
		}
		for (const entry of entries) {
			const absolutePath = path.join(directory, entry.name);
			const relativePath = path.relative(root, absolutePath);
			if (entry.isDirectory()) {
				if (!options.includeGenerated && excluded.has(entry.name)) {
					result.skipped.push({ relativePath, reason: 'excluded directory' });
				} else {
					visit(absolutePath);
				}
				continue;
			}
			if (!entry.isFile()) continue;
			if (ignoredByGit(root, relativePath)) {
				result.skipped.push({ relativePath, reason: '.gitignore' });
				continue;
			}
			if (looksBinary(absolutePath)) {
				result.skipped.push({ relativePath, reason: 'binary file' });
				continue;
			}
			const type = fileTypeFor(entry.name);
			if (!type) {
				result.skipped.push({ relativePath, reason: 'unsupported file type' });
				continue;
			}
			try {
				const size = fs.statSync(absolutePath).size;
				if (size > maxBytes) {
					result.discovered.push({ relativePath, absolutePath, languageId: languageIdFor(entry.name) ?? 'plaintext', category: type.category, size });
				} else {
					result.discovered.push({ relativePath, absolutePath, languageId: languageIdFor(entry.name) ?? 'plaintext', category: type.category, size });
				}
			} catch (error) {
				result.failed.push({ relativePath, reason: `stat: ${(error as Error).message}` });
			}
		}
	};
	try {
		visit(root);
	} catch (error) {
		result.failed.push({ relativePath: '', reason: (error as Error).message });
	}
	return result;
}

export function readProjectFile(file: ProjectFile): string {
	return fs.readFileSync(file.absolutePath, 'utf8');
}

export function findProjectFile(root: string, query: string, options: ScanOptions = {}): ProjectFile | undefined {
	const normalized = query.replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
	const scan = scanProjectFiles(root, options);
	const exact = scan.discovered.find(file => file.relativePath.replace(/\\/g, '/') === normalized);
	if (exact) return exact;
	const matches = scan.discovered.filter(file => path.basename(file.relativePath).toLowerCase() === path.basename(normalized).toLowerCase());
	return matches.length === 1 ? matches[0] : undefined;
}
