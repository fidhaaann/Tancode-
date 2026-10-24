import * as vscode from 'vscode';

// Single output channel for diagnostics. Never log source code, file
// contents, prompts, or model output — only operational metadata.
export interface Logger {
	info(message: string): void;
}

let channel: vscode.OutputChannel | undefined;

export function getLogger(): Logger {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Tancode');
	}
	return {
		info: (message: string) => channel!.appendLine(`[${new Date().toISOString()}] ${message}`),
	};
}
