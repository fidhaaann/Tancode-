import * as vscode from 'vscode';
import { ExplanationPanel } from './explanationPanel';

export function activate(context: vscode.ExtensionContext) {
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

	context.subscriptions.push(helloWorld, explainCurrentFile, explainSelectedCode, clearConversation);
}

export function deactivate() {}
