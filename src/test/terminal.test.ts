import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanTerminalOutput, formatTerminalErrorContext } from '../terminal';

test('terminal capture strips control sequences and bounds output', () => {
	assert.equal(cleanTerminalOutput('\u001b[31mError\u001b[0m\r\nnext'), 'Error\nnext');
	assert.equal(cleanTerminalOutput('x'.repeat(13000)).length, 12000);
});

test('terminal context preserves command, exit code, and observed output', () => {
	const context = formatTerminalErrorContext({
		command: 'npm test',
		cwd: 'C:\\project',
		exitCode: 1,
		output: 'Error: test failed',
	});
	assert.match(context, /Command: npm test/);
	assert.match(context, /Exit code: 1/);
	assert.match(context, /Error: test failed/);
	assert.match(context, /untrusted terminal execution evidence/i);
});
