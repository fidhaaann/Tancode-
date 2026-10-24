#!/usr/bin/env node
// Fails with a clear message when the build prerequisites are missing,
// so npm run compile/watch/typecheck don't die on an obscure
// "'tsc' is not recognized" / "tsc: not found" error.

const { existsSync } = require('node:fs');
const { join } = require('node:path');

const tsc = join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tsc)) {
	console.error('[tancode] Dependencies are missing: TypeScript was not found in node_modules.');
	console.error('[tancode] Run "npm ci" from the repository root, then retry the command.');
	process.exit(1);
}
