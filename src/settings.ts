import * as vscode from 'vscode';
import type { MentoringFrequency } from './proactive';

export type ProactiveLevel = 'all' | 'errors-only';
export type ExplanationDepth = 'concise' | 'detailed';

export interface TancodeSettings {
	ollamaBaseUrl: string;
	ollamaModel: string;
	maxSourceBytes: number;
	requestTimeoutMs: number;
	fallbackToRules: boolean;
	proactiveEnabled: boolean;
	proactiveLevel: ProactiveLevel;
	proactiveFrequency: MentoringFrequency;
	proactiveCooldownSeconds: number;
	proactiveMaxPerSession: number;
	explanationDepth: ExplanationDepth;
	simplifiedExplanations: boolean;
	interactiveQuestions: boolean;
}

export function getSettings(): TancodeSettings {
	const cfg = vscode.workspace.getConfiguration('tancode');
	return {
		ollamaBaseUrl: cfg.get<string>('ollama.baseUrl', 'http://127.0.0.1:11434'),
		ollamaModel: cfg.get<string>('ollama.model', 'qwen3:8b'),
		maxSourceBytes: cfg.get<number>('maxSourceBytes', 65536),
		requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 120000),
		fallbackToRules: cfg.get<boolean>('fallbackToRuleBased', true),
		proactiveEnabled: cfg.get<boolean>('proactive.enabled', true),
		proactiveLevel: cfg.get<ProactiveLevel>('proactive.level', 'all'),
		proactiveFrequency: cfg.get<MentoringFrequency>('proactive.frequency', 'balanced'),
		proactiveCooldownSeconds: cfg.get<number>('proactive.cooldownSeconds', 90),
		proactiveMaxPerSession: cfg.get<number>('proactive.maxPerSession', 12),
		explanationDepth: cfg.get<ExplanationDepth>('explanation.depth', 'concise'),
		simplifiedExplanations: cfg.get<boolean>('explanation.simplified', true),
		interactiveQuestions: cfg.get<boolean>('explanation.interactiveQuestions', true),
	};
}
