import type { FileExplanation } from '../analysis';
import { ExplanationCache } from './cache';
import { OllamaClient, OllamaError, OllamaErrorKind } from './ollama';
import type { GenerateOptions } from './ollama';
import {
	buildAssessmentPrompt,
	buildPrompt,
	buildQuestionPrompt,
	buildSelectionPrompt,
	CodeSelection,
	ExplainMode,
	parseResponse,
	SelectionMode,
} from './prompt';

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
		case 'cancelled':
			return 'A newer update replaced this request. Nothing is wrong — retry if this was unexpected.';
	}
}

// Per-mode output caps (num_predict). Short modes get short budgets —
// generation time scales almost linearly with output length on a local
// model, so an unbounded default wastes seconds on padded answers.
const NUM_PREDICT: Record<string, number> = {
	summary: 200,
	detail: 500,
	'sel-explain': 300,
	'sel-learn': 500,
	question: 180,
	assess: 500,
};

// Optional streaming/cancellation channel from the panel. `signal` aborts
// requests a newer update has made stale; `onToken` receives accumulated
// text for progressive rendering.
export interface RequestUi {
	signal?: AbortSignal;
	onToken?: (accumulated: string) => void;
}

// Optional logger — receives operational metadata only (URIs never logged,
// only file names; never source text or prompts).
export interface ServiceLogger {
	info(message: string): void;
}

function baseName(fileName: string): string {
	return fileName.split(/[\\/]/).pop() ?? fileName;
}

export class ExplanationService {
	private readonly inflight = new Map<string, Promise<ExplanationResult>>();

	constructor(
		private readonly client: OllamaClient,
		private readonly cache: ExplanationCache<ExplanationResult>,
		private readonly rulesExplain: (doc: DocLike) => FileExplanation | undefined,
		private readonly isSupportedLang: (languageId: string) => boolean,
		private readonly options: ServiceOptions,
		private readonly logger?: ServiceLogger,
	) {}

	async explain(doc: DocLike, mode: ExplainMode, force = false, ui?: RequestUi): Promise<ExplanationResult> {
		const preflight = this.preflight(doc.getText(), doc);
		if (preflight) {
			return preflight;
		}

		const tag = `file=${baseName(doc.fileName)} mode=${mode} bytes=${doc.getText().length}`;
		const key = ExplanationCache.key(doc.uri.toString(), doc.version, this.options.model, mode);
		if (!force) {
			const hit = this.cache.get(key);
			if (hit) {
				this.logger?.info(`explain cache hit: ${tag}`);
				return hit.status === 'ok' && hit.source === 'model'
					? { ...hit, fromCache: true }
					: hit;
			}
			const pending = this.inflight.get(key);
			if (pending) {
				this.logger?.info(`explain dedupe: ${tag}`);
				return pending;
			}
		}

		const parts = buildPrompt(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			mode,
		);
		const work = this.runInference(parts, tag, key, doc, NUM_PREDICT[mode], ui)
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, work);
		return work;
	}

	async explainSelection(
		doc: DocLike,
		sel: CodeSelection,
		mode: SelectionMode,
		force = false,
		ui?: RequestUi,
	): Promise<ExplanationResult> {
		// The fallback analyses just the selection, not the whole file.
		const selDoc: DocLike = { ...doc, getText: () => sel.text };
		const payload = sel.text.length + (sel.before?.length ?? 0) + (sel.after?.length ?? 0);
		const preflight = this.preflight(sel.text, selDoc, payload);
		if (preflight) {
			return preflight;
		}

		const tag = `file=${baseName(doc.fileName)} mode=sel-${mode} lines=${sel.startLine}-${sel.endLine} bytes=${payload}`;
		const key = ExplanationCache.key(
			doc.uri.toString(), doc.version, this.options.model,
			`sel:${mode}:${sel.startLine}-${sel.endLine}`,
		);
		if (!force) {
			const hit = this.cache.get(key);
			if (hit) {
				this.logger?.info(`explain cache hit: ${tag}`);
				return hit.status === 'ok' && hit.source === 'model'
					? { ...hit, fromCache: true }
					: hit;
			}
			const pending = this.inflight.get(key);
			if (pending) {
				this.logger?.info(`explain dedupe: ${tag}`);
				return pending;
			}
		}

		const parts = buildSelectionPrompt(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			sel,
			mode,
		);
		const work = this.runInference(parts, tag, key, selDoc, NUM_PREDICT[`sel-${mode}`], ui)
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, work);
		return work;
	}

	// Practice mode: fresh question every call — quizzes are not cached.
	async generateQuestion(doc: DocLike, sel: CodeSelection, ui?: RequestUi): Promise<ExplanationResult> {
		const selDoc: DocLike = { ...doc, getText: () => sel.text };
		if (sel.text.trim().length === 0) {
			return { status: 'empty' };
		}
		const parts = buildQuestionPrompt(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			sel,
		);
		return this.runInference(parts, `file=${baseName(doc.fileName)} mode=question lines=${sel.startLine}-${sel.endLine} bytes=${sel.text.length}`, undefined, selDoc, NUM_PREDICT.question, ui);
	}

	async assessAnswer(
		doc: DocLike,
		sel: CodeSelection,
		question: string,
		answer: string,
		ui?: RequestUi,
	): Promise<ExplanationResult> {
		const selDoc: DocLike = { ...doc, getText: () => sel.text };
		const parts = buildAssessmentPrompt(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			sel,
			question,
			answer,
		);
		return this.runInference(parts, `file=${baseName(doc.fileName)} mode=assess lines=${sel.startLine}-${sel.endLine} bytes=${sel.text.length}`, undefined, selDoc, NUM_PREDICT.assess, ui);
	}

	private preflight(text: string, doc: DocLike, payloadBytes?: number): ExplanationResult | undefined {
		if (!this.isSupportedLang(doc.languageId)) {
			return { status: 'unsupported' };
		}
		if (text.trim().length === 0) {
			return { status: 'empty' };
		}
		const bytes = payloadBytes ?? text.length;
		if (bytes > this.options.maxSourceBytes) {
			return { status: 'tooLarge', bytes, limit: this.options.maxSourceBytes };
		}
		return undefined;
	}

	private async runInference(
		parts: { system: string; prompt: string },
		logTag: string,
		key: string | undefined,
		fallbackDoc: DocLike,
		numPredict: number,
		ui?: RequestUi,
	): Promise<ExplanationResult> {
		let result: ExplanationResult;
		const startedAt = Date.now();
		const elapsed = () => `${Date.now() - startedAt}ms`;
		let firstTokenLogged = false;
		const gen: GenerateOptions = {
			numPredict,
			keepAlive: '10m',
			signal: ui?.signal,
			onToken: ui?.onToken
				? (text: string) => {
					if (!firstTokenLogged) {
						firstTokenLogged = true;
						this.logger?.info(`explain first token: ${logTag} ttfb=${elapsed()}`);
					}
					ui.onToken!(text);
				}
				: undefined,
		};
		this.logger?.info(`explain request: ${logTag} model=${this.options.model} endpoint=${this.client.baseUrl} num_predict=${numPredict}`);
		try {
			const raw = await this.client.generate(this.options.model, parts.system, parts.prompt, gen);
			const text = parseResponse(raw);
			if (text.length === 0) {
				result = this.errorResult(fallbackDoc, 'malformed', 'The model returned no explanation text (possibly reasoning-only output).');
			} else {
				this.logger?.info(`explain success: model=${this.options.model} ${logTag} status=200 duration=${elapsed()} chars=${text.length}`);
				result = { status: 'ok', source: 'model', text, fromCache: false };
			}
		} catch (err) {
			if (err instanceof OllamaError) {
				this.logger?.info(`explain failed: kind=${err.kind}${err.status ? ` status=${err.status}` : ''} duration=${elapsed()} message=${err.message}`);
				result = this.errorResult(fallbackDoc, err.kind, err.message);
			} else {
				this.logger?.info(`explain failed: kind=unavailable duration=${elapsed()} message=${(err as Error)?.message ?? String(err)}`);
				result = this.errorResult(fallbackDoc, 'unavailable', `Unexpected error: ${(err as Error)?.message ?? String(err)}`);
			}
		}

		if (key !== undefined && result.status === 'ok') {
			this.cache.set(key, result);
		}
		return result;
	}

	private errorResult(doc: DocLike, kind: OllamaErrorKind, message: string): ExplanationResult {
		const fallback = this.options.fallbackToRules ? this.rulesExplain(doc) : undefined;
		this.logger?.info(`explain outcome: error kind=${kind} fallback=${fallback ? 'rule-based' : 'none'}`);
		return {
			status: 'error',
			kind,
			message,
			hint: hintFor(kind, this.options.model, this.client.baseUrl),
			fallback,
		};
	}
}
