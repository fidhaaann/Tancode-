import * as vscode from 'vscode';

export interface TancodeSettings {
	ollamaBaseUrl: string;
	ollamaModel: string;
	maxSourceBytes: number;
	requestTimeoutMs: number;
	fallbackToRules: boolean;
}

export function getSettings(): TancodeSettings {
	const cfg = vscode.workspace.getConfiguration('tancode');
	return {
		ollamaBaseUrl: cfg.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
		ollamaModel: cfg.get<string>('ollama.model', 'qwen3:8b'),
		maxSourceBytes: cfg.get<number>('maxSourceBytes', 65536),
		requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 30000),
		fallbackToRules: cfg.get<boolean>('fallbackToRuleBased', true),
	};
}
