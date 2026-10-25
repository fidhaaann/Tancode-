import * as vscode from 'vscode';
import { ExplanationPanel } from './explanationPanel';
import { TerminalErrorCapture } from './terminal';

export function activate(context: vscode.ExtensionContext) {
	const terminalCaptures = new Map<vscode.TerminalShellExecution, Promise<string>>();
	const terminalStart = vscode.window.onDidStartTerminalShellExecution(event => {
		terminalCaptures.set(event.execution, (async () => {
			const chunks: string[] = [];
			try {
				for await (const chunk of event.execution.read()) {
					chunks.push(chunk);
				}
			} catch (error) {
				// Some terminals end without a readable stream. The exit code
				// and command metadata still provide useful evidence.
				chunks.push(`[Terminal output capture failed: ${error instanceof Error ? error.message : String(error)}]`);
			}
			return chunks.join('');
		})());
	});
	const terminalEnd = vscode.window.onDidEndTerminalShellExecution(event => {
		if (event.exitCode === undefined || event.exitCode === 0) {
			terminalCaptures.delete(event.execution);
			return;
		}
		const output = terminalCaptures.get(event.execution) ?? Promise.resolve('');
		void output.then(text => {
			const capture: TerminalErrorCapture = {
				command: event.execution.commandLine.value,
				cwd: event.execution.cwd?.fsPath,
				exitCode: event.exitCode ?? 1,
				output: text,
			};
			ExplanationPanel.explainTerminalError(context, capture);
		}).finally(() => terminalCaptures.delete(event.execution));
	});
	const helloWorld = vscode.commands.registerCommand('tancode.helloWorld', () => {
		vscode.window.showInformationMessage('Tancode is running.');
	});

	const explainCurrentFile = vscode.commands.registerCommand('tancode.explainCurrentFile', () => {
		ExplanationPanel.createOrShow(context);
	});

	const explainSelectedCode = vscode.commands.registerCommand('tancode.explainSelectedCode', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty || editor.document.getText(editor.selection).trim().length === 0) {
			void vscode.window.showInformationMessage('Select some code first, then run "Tancode: Explain Selected Code".');
			return;
		}
		ExplanationPanel.explainSelection(context, editor);
	});

	const clearConversation = vscode.commands.registerCommand('tancode.clearConversation', () => {
		ExplanationPanel.clearChat();
	});

	context.subscriptions.push(terminalStart, terminalEnd, helloWorld, explainCurrentFile, explainSelectedCode, clearConversation);
}

export function deactivate() {}
