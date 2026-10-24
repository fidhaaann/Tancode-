import * as vscode from 'vscode';
import { ExplanationPanel } from './explanationPanel';

export function activate(context: vscode.ExtensionContext) {
	const helloWorld = vscode.commands.registerCommand('tancode.helloWorld', () => {
		vscode.window.showInformationMessage('Tancode is running.');
	});

	const explainCurrentFile = vscode.commands.registerCommand('tancode.explainCurrentFile', () => {
		ExplanationPanel.createOrShow(context);
	});

	context.subscriptions.push(helloWorld, explainCurrentFile);
}

export function deactivate() {}
