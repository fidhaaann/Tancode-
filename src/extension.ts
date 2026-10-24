import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const helloWorld = vscode.commands.registerCommand('tancode.helloWorld', () => {
		vscode.window.showInformationMessage('Tancode is running.');
	});

	context.subscriptions.push(helloWorld);
}

export function deactivate() {}
