import type { FileExplanation } from '../analysis';
import { ExplanationCache } from './cache';
import { OllamaClient, OllamaError, OllamaErrorKind } from './ollama';
import { buildPrompt, parseResponse, ExplainMode } from './prompt';

// Minimal document shape — satisfied by vscode.TextDocument, but keeping
// this module free of the vscode import so it can run in plain Node tests.
export interface DocLike {
	languageId: string;
	fileName: string;
	uri: { fsPath: string; toString(): string };
	version: number;
	getText(): string;
}

export interface ServiceOptions {
	model: string;
	maxSourceBytes: number;
	fallbackToRules: boolean;
}

export type ExplanationResult =
	| { status: 'ok'; source: 'model'; text: string; fromCache: boolean }
	| { status: 'ok'; source: 'rules'; explanation: FileExplanation }
	| { status: 'unsupported' }
	| { status: 'empty' }
	| { status: 'tooLarge'; bytes: number; limit: number }
	| { status: 'error'; kind: OllamaErrorKind; message: string; hint: string; fallback?: FileExplanation };

export function hintFor(kind: OllamaErrorKind, model: string, baseUrl: string): string {
	switch (kind) {
		case 'unavailable':
			return `Start Ollama (run "ollama serve" or launch the app), or fix the "tancode.ollama.baseUrl" setting (currently ${baseUrl}).`;
		case 'modelMissing':
			return `Pull it with "ollama pull ${model}", pick an installed model via "ollama list", or change the "tancode.ollama.model" setting.`;
		case 'timeout':
			return 'The model took too long. Increase "tancode.requestTimeoutMs" or configure a smaller/faster model.';
		case 'httpError':
			return 'Check that Ollama is healthy ("ollama list") and that the base URL points at the Ollama API port.';
		case 'malformed':
			return 'The endpoint answered but not as an Ollama server. Check the "tancode.ollama.baseUrl" setting.';
	}
}

export class ExplanationService {
	private readonly inflight = new Map<string, Promise<ExplanationResult>>();

	constructor(
		private readonly client: OllamaClient,
		private readonly cache: ExplanationCache<ExplanationResult>,
		private readonly rulesExplain: (doc: DocLike) => FileExplanation | undefined,
		private readonly isSupportedLang: (languageId: string) => boolean,
		private readonly options: ServiceOptions,
	) {}

	async explain(doc: DocLike, mode: ExplainMode, force = false): Promise<ExplanationResult> {
		if (!this.isSupportedLang(doc.languageId)) {
			return { status: 'unsupported' };
		}
		const text = doc.getText();
		if (text.trim().length === 0) {
			return { status: 'empty' };
		}
		if (text.length > this.options.maxSourceBytes) {
			return { status: 'tooLarge', bytes: text.length, limit: this.options.maxSourceBytes };
		}

		const key = ExplanationCache.key(doc.uri.toString(), doc.version, this.options.model, mode);
		if (!force) {
			const hit = this.cache.get(key);
			if (hit) {
				return hit.status === 'ok' && hit.source === 'model'
					? { ...hit, fromCache: true }
					: hit;
			}
			const pending = this.inflight.get(key);
			if (pending) {
				return pending;
			}
		}

		const work = this.runInference(doc, mode, key).finally(() => {
			this.inflight.delete(key);
		});
		this.inflight.set(key, work);
		return work;
	}

	private async runInference(doc: DocLike, mode: ExplainMode, key: string): Promise<ExplanationResult> {
		const { system, prompt } = buildPrompt(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			mode,
		);

		let result: ExplanationResult;
		try {
			const raw = await this.client.generate(this.options.model, system, prompt);
			const text = parseResponse(raw);
			if (text.length === 0) {
				result = this.errorResult(doc, 'malformed', 'The model returned an empty explanation.');
			} else {
				result = { status: 'ok', source: 'model', text, fromCache: false };
			}
		} catch (err) {
			if (err instanceof OllamaError) {
				result = this.errorResult(doc, err.kind, err.message);
			} else {
				result = this.errorResult(doc, 'unavailable', `Unexpected error: ${(err as Error)?.message ?? String(err)}`);
			}
		}

		if (result.status === 'ok') {
			this.cache.set(key, result);
		}
		return result;
	}

	private errorResult(doc: DocLike, kind: OllamaErrorKind, message: string): ExplanationResult {
		return {
			status: 'error',
			kind,
			message,
			hint: hintFor(kind, this.options.model, this.client.baseUrl),
			fallback: this.options.fallbackToRules ? this.rulesExplain(doc) : undefined,
		};
	}
}
