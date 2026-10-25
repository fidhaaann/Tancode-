import type { FileExplanation } from '../analysis';
import { ExplanationCache } from './cache';
import { OllamaClient, OllamaError, OllamaErrorKind } from './ollama';
import type { GenerateOptions } from './ollama';
import { declarationsOf, splitSections } from './sections';
import {
	buildAssessmentPrompt,
	buildChatRequest,
	buildDiagnosticPrompt,
	buildInsightPrompt,
	buildCombinePrompt,
	buildManifestInsightPrompt,
	buildOrientationPrompt,
	buildSectionPrompt,
	buildPrompt,
	buildQuestionPrompt,
	buildSelectionPrompt,
	buildWrapupPrompt,
	CodeSelection,
	DiagnosticContext,
	ExplainMode,
	parseResponse,
	SelectionMode,
	SessionRecapData,
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
	/** detailed → ~1.5x output budgets; concise → the base caps. */
	depth?: 'concise' | 'detailed';
	/** include plain-language explanations + analogies in teaching modes. */
	simplified?: boolean;
}

export type ExplanationResult =
	| { status: 'ok'; source: 'model'; text: string; fromCache: boolean }
	| { status: 'ok'; source: 'rules'; explanation: FileExplanation }
	| { status: 'unsupported' }
	| { status: 'empty' }
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
	chat: 300,
	insight: 150,
	diagnostic: 400,
	orientation: 350,
	recap: 600,
	section: 250,
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
		private readonly 		isSupportedLang: (languageId: string, fileName?: string) => boolean,
		private readonly options: ServiceOptions,
		private readonly logger?: ServiceLogger,
	) {}

	// Detailed depth gives the model ~50% more output room; concise stays at
	// the latency-tuned caps.
	private capFor(mode: string): number {
		const base = NUM_PREDICT[mode] ?? 300;
		return this.options.depth === 'detailed' ? Math.round(base * 1.5) : base;
	}

	private get simplified(): boolean {
		return this.options.simplified !== false;
	}

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

		// Files larger than the context budget are analyzed section-by-section
		// (sequential, cancellable) then combined — never truncated or rejected.
		const overBudget = doc.getText().length > this.options.maxSourceBytes;
		const parts = overBudget
			? undefined
			: buildPrompt(
				{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
				mode,
				this.simplified,
			);
		const work = (overBudget
			? this.explainSectioned(doc, mode, key, tag, ui)
			: this.runInference(parts!, tag, key, doc, this.capFor(mode), ui))
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, work);
		return work;
	}

	// Sectioned analysis for a file that doesn't fit the context budget:
	// summarize each section in order (bounded rolling context + declaration
	// carry-over), then a combine pass writes the final answer with honest
	// scope disclosure. Sequential — one request at a time, cancellable
	// between sections; failed sections are disclosed, not hidden.
	private async explainSectioned(
		doc: DocLike,
		mode: ExplainMode,
		key: string,
		tag: string,
		ui?: RequestUi,
	): Promise<ExplanationResult> {
		const text = doc.getText();
		const sections = splitSections(text, this.options.maxSourceBytes);
		if (sections.length <= 1) {
			// Boundary case: a single oversized line (minified file). Send it
			// as one request — the model handles its own context window.
			const parts = buildPrompt(
				{ fileName: doc.fileName, languageId: doc.languageId, text },
				mode, this.simplified,
			);
			return this.runInference(parts, tag, key, doc, this.capFor(mode), ui);
		}
		this.logger?.info(`explain sections: ${tag} sections=${sections.length}`);
		const summaries: string[] = [];
		const declarations: string[] = [];
		const failed: number[] = [];
		for (let i = 0; i < sections.length; i++) {
			if (ui?.signal?.aborted) {
				return { status: 'error', kind: 'cancelled', message: 'Cancelled', hint: hintFor('cancelled', this.options.model, '') };
			}
			const s = sections[i];
			ui?.onToken?.(`*Analyzing section ${i + 1} of ${sections.length} (lines ${s.startLine}–${s.endLine})…*`);
			const parts = buildSectionPrompt(
				{ fileName: doc.fileName, languageId: doc.languageId, text: s.text, startLine: s.startLine, endLine: s.endLine },
				i + 1, sections.length,
				summaries.slice(-3).join('\n'),
				declarations.slice(-15),
			);
			const r = await this.runInference(parts, `${tag} section=${i + 1}/${sections.length}`, undefined, doc, this.capFor('section'), { signal: ui?.signal });
			if (r.status === 'ok' && r.source === 'model') {
				summaries.push(r.text);
				declarations.push(...declarationsOf(s.text).slice(0, 5));
			} else {
				failed.push(i + 1);
			}
		}
		const parts = buildCombinePrompt(
			doc.fileName, doc.languageId, mode, summaries, declarations, failed, sections.length, this.simplified,
		);
		return this.runInference(parts, tag, key, doc, this.capFor(mode), ui);
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
		// No size rejection: the exact selection is prioritized. Only
		// unsupported-language and empty-selection states abort early.
		const preflight = this.preflight(sel.text, selDoc);
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
			this.simplified,
		);
		const work = this.runInference(parts, tag, key, selDoc, this.capFor(`sel-${mode}`), ui)
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
		return this.runInference(parts, `file=${baseName(doc.fileName)} mode=question lines=${sel.startLine}-${sel.endLine} bytes=${sel.text.length}`, undefined, selDoc, this.capFor('question'), ui);
	}

	// Explains a real editor diagnostic — dedupe/cache via the caller's key
	// (diag line+code hash); same doc mutation happens at the same location.
	async explainDiagnostic(
		doc: DocLike,
		sel: CodeSelection,
		diag: DiagnosticContext,
		cacheKey: string,
		ui?: RequestUi,
	): Promise<ExplanationResult> {
		const selDoc: DocLike = { ...doc, getText: () => sel.text };
		const tag = `file=${baseName(doc.fileName)} mode=diagnostic line=${diag.line}`;
		const hit = this.cache.get(cacheKey);
		if (hit) {
			this.logger?.info(`explain cache hit: ${tag}`);
			return hit.status === 'ok' && hit.source === 'model' ? { ...hit, fromCache: true } : hit;
		}
		const parts = buildDiagnosticPrompt(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			sel, diag, this.simplified,
		);
		return this.runInference(parts, tag, cacheKey, selDoc, this.capFor('diagnostic'), ui);
	}

	// Proactive scan of a saved file: returns the model's insight text or the
	// literal 'NONE' — the panel treats NONE as "stay quiet". Cached per
	// content so identical saves don't re-run inference.
	async findInsight(doc: DocLike, contentHash: string, ui?: RequestUi): Promise<ExplanationResult> {
		const tag = `file=${baseName(doc.fileName)} mode=insight bytes=${doc.getText().length}`;
		const key = ExplanationCache.key(doc.uri.toString(), 0, this.options.model, `insight:${contentHash}`);
		const hit = this.cache.get(key);
		if (hit) {
			this.logger?.info(`explain cache hit: ${tag}`);
			return hit.status === 'ok' && hit.source === 'model' ? { ...hit, fromCache: true } : hit;
		}
		const parts = buildInsightPrompt({ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() });
		return this.runInference(parts, tag, key, doc, this.capFor('insight'), ui);
	}

	// Conversational answers are never cached — they depend on live history.
	async chatAnswer(
		doc: DocLike,
		sel: CodeSelection | undefined,
		question: string,
		history: Array<{ role: 'user' | 'assistant'; text: string }>,
		ui?: RequestUi,
		projectContext?: string,
	): Promise<ExplanationResult> {
		const parts = buildChatRequest(
			{ fileName: doc.fileName, languageId: doc.languageId, text: doc.getText() },
			sel, question, history, projectContext,
		);
		return this.runChatInference(parts, `file=${baseName(doc.fileName)} mode=chat bytes=${question.length}`, doc, ui);
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
		return this.runInference(parts, `file=${baseName(doc.fileName)} mode=assess lines=${sel.startLine}-${sel.endLine} bytes=${sel.text.length}`, undefined, selDoc, this.capFor('assess'), ui);
	}

	private preflight(text: string, doc: DocLike): ExplanationResult | undefined {
		if (!this.isSupportedLang(doc.languageId, doc.fileName)) {
			return { status: 'unsupported' };
		}
		if (text.trim().length === 0) {
			return { status: 'empty' };
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

	private async runChatInference(
		parts: { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> },
		logTag: string,
		fallbackDoc: DocLike,
		ui?: RequestUi,
	): Promise<ExplanationResult> {
		let result: ExplanationResult;
		const startedAt = Date.now();
		const elapsed = () => `${Date.now() - startedAt}ms`;
		let firstTokenLogged = false;
		const gen: GenerateOptions = {
			numPredict: this.capFor('chat'),
			keepAlive: '10m',
			signal: ui?.signal,
			onToken: ui?.onToken
				? (text: string) => {
					if (!firstTokenLogged) {
						firstTokenLogged = true;
						this.logger?.info(`chat first token: ${logTag} ttfb=${elapsed()}`);
					}
					ui.onToken!(text);
				}
				: undefined,
		};
		this.logger?.info(`chat request: ${logTag} model=${this.options.model} endpoint=${this.client.baseUrl} num_predict=${this.capFor('chat')}`);
		try {
			const raw = await this.client.chat(this.options.model, [
				{ role: 'system', content: parts.system },
				...parts.messages,
			], gen);
			const text = parseResponse(raw);
			if (text.length === 0) {
				result = this.errorResult(fallbackDoc, 'malformed', 'The model returned no chat response text (possibly reasoning-only output).');
			} else {
				this.logger?.info(`chat success: model=${this.options.model} ${logTag} status=200 duration=${elapsed()} chars=${text.length}`);
				result = { status: 'ok', source: 'model', text, fromCache: false };
			}
		} catch (err) {
			if (err instanceof OllamaError) {
				this.logger?.info(`chat failed: kind=${err.kind}${err.status ? ` status=${err.status}` : ''} duration=${elapsed()} message=${err.message}`);
				result = this.errorResult(fallbackDoc, err.kind, err.message);
			} else {
				this.logger?.info(`chat failed: kind=unavailable duration=${elapsed()} message=${(err as Error)?.message ?? String(err)}`);
				result = this.errorResult(fallbackDoc, 'unavailable', `Unexpected error: ${(err as Error)?.message ?? String(err)}`);
			}
		}
		return result;
	}

	// Proactive note for an opened manifest, grounded only in the extracted
	// tech profile. Cached by the caller's profile key — the model may
	// answer 'NONE' and the panel stays quiet.
	async manifestInsight(fileName: string, profileText: string, cacheKey: string, ui?: RequestUi): Promise<ExplanationResult> {
		const hit = this.cache.get(cacheKey);
		if (hit) {
			this.logger?.info(`explain cache hit: mode=manifest file=${baseName(fileName)}`);
			return hit.status === 'ok' && hit.source === 'model' ? { ...hit, fromCache: true } : hit;
		}
		const parts = buildManifestInsightPrompt(baseName(fileName), profileText);
		const emptyDoc: DocLike = {
			languageId: 'json', fileName, version: 0,
			uri: { fsPath: '', toString: () => 'manifest://' },
			getText: () => '',
		};
		return this.runInference(parts, `mode=manifest file=${baseName(fileName)}`, cacheKey, emptyDoc, this.capFor('insight'), ui);
	}

	// One-shot project orientation from deterministic facts collected by
	// src/project.ts. Cached by caller's facts hash — the same project state
	// never re-runs inference.
	async projectOrientation(factsText: string, cacheKey: string, ui?: RequestUi): Promise<ExplanationResult> {
		const hit = this.cache.get(cacheKey);
		if (hit) {
			this.logger?.info('explain cache hit: mode=orientation');
			return hit.status === 'ok' && hit.source === 'model' ? { ...hit, fromCache: true } : hit;
		}
		const parts = buildOrientationPrompt(factsText);
		const emptyDoc: DocLike = {
			languageId: 'plaintext', fileName: 'project', version: 0,
			uri: { fsPath: '', toString: () => 'project://' },
			getText: () => '',
		};
		return this.runInference(parts, 'mode=orientation', cacheKey, emptyDoc, this.capFor('orientation'), ui);
	}

	// Session wrap-up: never cached — the recap reflects this exact session.
	async sessionRecap(data: SessionRecapData, ui?: RequestUi): Promise<ExplanationResult> {
		const parts = buildWrapupPrompt(data);
		const emptyDoc: DocLike = {
			languageId: 'plaintext', fileName: 'project', version: 0,
			uri: { fsPath: '', toString: () => 'project://' },
			getText: () => '',
		};
		return this.runInference(parts, 'mode=recap', undefined, emptyDoc, this.capFor('recap'), ui);
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
