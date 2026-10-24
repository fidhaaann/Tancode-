import * as vscode from 'vscode';
import { explain as rulesExplain, isSupported } from './analysis';
import { ExplanationCache } from './model/cache';
import { OllamaClient } from './model/ollama';
import { CodeSelection, ExplainMode, parseSections, SelectionMode } from './model/prompt';
import { DocLike, ExplanationResult, ExplanationService } from './model/service';
import { dispatchWebviewMessage } from './messages';
import { getSettings, TancodeSettings } from './settings';
import { getLogger } from './log';
import { renderDocument, ViewState } from './view';

const PANEL_VIEW_TYPE = 'tancode.explanation';
const DEBOUNCE_MS = 350;
const CONTEXT_LINES = 8;
const MAX_CONTEXT_CHARS = 2000;
const MAX_ANSWER_CHARS = 4000;

function fileNameOf(document: vscode.TextDocument): string {
	return document.fileName.split(/[\\/]/).pop() ?? 'untitled';
}

function makeNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

type SelectionTarget = {
	kind: 'selection';
	uri: string;
	version: number;
	fileName: string;
	languageId: string;
	languageName: string;
	sel: CodeSelection;
};

type Target = { kind: 'file' } | SelectionTarget;

// What a Retry press re-attempts — depends on which flow ran last.
type RetryTarget = 'explanation' | 'question' | 'assessment';

export class ExplanationPanel {
	private static current: ExplanationPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cache = new ExplanationCache<ExplanationResult>();
	private settings: TancodeSettings;
	private service: ExplanationService;
	private target: Target = { kind: 'file' };
	private fileMode: ExplainMode = 'summary';
	private selMode: SelectionMode = 'explain';
	private retryTarget: RetryTarget = 'explanation';
	private quizQuestion: string | undefined;
	private quizAnswer: string | undefined;
	private debounceTimer: NodeJS.Timeout | undefined;
	private lastKey: string | undefined;
	private updateSeq = 0;

	static createOrShow(context: vscode.ExtensionContext): void {
		if (ExplanationPanel.current) {
			ExplanationPanel.current.useFileTarget();
			ExplanationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			PANEL_VIEW_TYPE,
			'Tancode',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				localResourceRoots: [],
				retainContextWhenHidden: true,
			}
		);

		ExplanationPanel.current = new ExplanationPanel(panel);
		ExplanationPanel.current.scheduleUpdate(0);
	}

	// Called by the Explain Selected Code command. The command checks for a
	// non-empty selection before invoking this.
	static explainSelection(context: vscode.ExtensionContext, editor: vscode.TextEditor): void {
		ExplanationPanel.createOrShow(context);
		ExplanationPanel.current?.setSelectionTarget(editor);
	}

	private setSelectionTarget(editor: vscode.TextEditor): void {
		const document = editor.document;
		const range = editor.selection;
		const startLine = range.start.line + 1; // display is 1-based
		const endLine = range.end.line + 1;
		const text = document.getText(range);

		const grab = (from: number, to: number): string | undefined => {
			if (to <= from) {
				return undefined;
			}
			const r = new vscode.Range(from, 0, to, Number.MAX_SAFE_INTEGER);
			const t = document.getText(r);
			return t.length > MAX_CONTEXT_CHARS ? t.slice(0, MAX_CONTEXT_CHARS) : t;
		};
		const before = grab(Math.max(0, range.start.line - CONTEXT_LINES), range.start.line);
		const after = grab(range.end.line + 1, Math.min(document.lineCount - 1, range.end.line + CONTEXT_LINES));

		this.target = {
			kind: 'selection',
			uri: document.uri.toString(),
			version: document.version,
			fileName: fileNameOf(document),
			languageId: document.languageId,
			languageName: document.languageId,
			sel: { startLine, endLine, text, before, after },
		};
		this.selMode = 'explain';
		this.retryTarget = 'explanation';
		this.quizQuestion = undefined;
		this.quizAnswer = undefined;
		this.scheduleUpdate(0);
	}

	private useFileTarget(): void {
		this.target = { kind: 'file' };
		this.fileMode = 'summary';
		this.retryTarget = 'explanation';
		this.quizQuestion = undefined;
		this.quizAnswer = undefined;
		this.scheduleUpdate(0);
	}

	private constructor(panel: vscode.WebviewPanel) {
		this.panel = panel;
		this.settings = getSettings();
		this.service = this.buildService();

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				// Clicking into this webview makes VS Code report no active text
				// editor while our panel holds focus — that is not a file switch,
				// so keep the current explanation instead of clearing to the
				// "no editor" state.
				if (!editor && this.panel.active) {
					return;
				}
				// Selection/quiz views describe captured code, not the active
				// editor — file switches don't disturb them.
				if (this.target.kind !== 'file') {
					return;
				}
				this.scheduleUpdate();
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (this.target.kind === 'file' && this.lastKey?.startsWith(`file:${event.document.uri.toString()}:`)) {
					this.scheduleUpdate();
				}
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('tancode')) {
					this.settings = getSettings();
					this.service = this.buildService();
					this.scheduleUpdate(0);
				}
			}),
			this.panel.webview.onDidReceiveMessage(message => {
				// Log every click that reaches the extension — distinguishes a
				// dead webview script/stale build from a dispatch problem.
				getLogger().info(`webview message: type=${String((message as { type?: unknown })?.type)}`);
				dispatchWebviewMessage(message, {
					detail: () => this.setFileMode('detail'),
					summary: () => this.setFileMode('summary'),
					retry: () => this.retryLast(),
					explain: () => this.setSelectionMode('explain'),
					learn: () => this.setSelectionMode('learn'),
					practice: () => this.startQuiz(),
					newQuestion: () => this.startQuiz(),
					submitAnswer: text => this.submitAnswer(text),
					backToFile: () => this.useFileTarget(),
				});
			})
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	private setFileMode(mode: ExplainMode): void {
		if (this.target.kind !== 'file') {
			return;
		}
		this.fileMode = mode;
		this.retryTarget = 'explanation';
		this.scheduleUpdate(0);
	}

	private setSelectionMode(mode: SelectionMode): void {
		if (this.target.kind !== 'selection') {
			return;
		}
		this.selMode = mode;
		this.retryTarget = 'explanation';
		this.quizQuestion = undefined;
		this.quizAnswer = undefined;
		this.scheduleUpdate(0);
	}

	private retryLast(): void {
		switch (this.retryTarget) {
			case 'question':
				this.startQuiz();
				return;
			case 'assessment':
				if (this.quizQuestion !== undefined && this.quizAnswer !== undefined) {
					void this.runAssessment(this.quizQuestion, this.quizAnswer);
					return;
				}
				this.retryTarget = 'question';
				this.startQuiz();
				return;
			default:
				this.scheduleUpdate(0, true);
		}
	}

	private buildService(): ExplanationService {
		const client = new OllamaClient(this.settings.ollamaBaseUrl, this.settings.requestTimeoutMs);
		// Report Ollama reachability + installed models to the output channel
		// every time the service is (re)built — the first thing to check when
		// the panel keeps falling back to rules.
		const log = getLogger();
		const probe = new OllamaClient(this.settings.ollamaBaseUrl, 4000);
		void probe.checkHealth().then(health => {
			if (health.reachable) {
				log.info(`ollama health: reachable at ${client.baseUrl}, models=[${health.models.join(', ')}]`);
			} else {
				log.info(`ollama health: unreachable at ${client.baseUrl}, kind=${health.error?.kind ?? 'unknown'} message=${health.error?.message ?? ''}`);
			}
		});
		return new ExplanationService(
			client,
			this.cache,
			doc => rulesExplain(doc as vscode.TextDocument),
			languageId => isSupported({ languageId }),
			{
				model: this.settings.ollamaModel,
				maxSourceBytes: this.settings.maxSourceBytes,
				fallbackToRules: this.settings.fallbackToRules,
			},
			log,
		);
	}

	private scheduleUpdate(delay = DEBOUNCE_MS, force = false): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			void this.update(force);
		}, delay);
	}

	private selectionDoc(t: SelectionTarget): DocLike {
		return {
			languageId: t.languageId,
			fileName: t.fileName,
			uri: { fsPath: t.uri, toString: () => t.uri },
			version: t.version,
			getText: () => t.sel.text,
		};
	}

	private linesLabel(t: SelectionTarget): string {
		return t.sel.startLine === t.sel.endLine
			? `line ${t.sel.startLine}`
			: `lines ${t.sel.startLine}–${t.sel.endLine}`;
	}

	private async update(force = false): Promise<void> {
		if (this.target.kind === 'selection') {
			return this.updateSelection(force);
		}
		return this.updateFile(force);
	}

	private async updateFile(force = false): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const document = editor?.document;

		if (!document) {
			// Same guard for update()s triggered by other listeners while the
			// webview itself is focused.
			if (this.panel.active && this.lastKey) {
				return;
			}
			this.lastKey = undefined;
			this.render({ kind: 'noEditor' });
			return;
		}

		const key = `file:${document.uri.toString()}:${document.version}:${this.fileMode}`;
		if (!force && this.lastKey === key) {
			return;
		}
		this.lastKey = key;
		this.retryTarget = 'explanation';

		const fileName = fileNameOf(document);
		const languageName = document.languageId;

		// Cheap states render immediately without a model call.
		if (!isSupported(document)) {
			this.render({ kind: 'unsupported', fileName, languageId: document.languageId });
			return;
		}
		if (document.getText().trim().length === 0) {
			this.render({ kind: 'empty', fileName });
			return;
		}

		// Cached results skip the loading flash; forced retries always show it
		// (and the loading render removes the buttons, preventing double-clicks).
		const cacheKey = ExplanationCache.key(document.uri.toString(), document.version, this.settings.ollamaModel, this.fileMode);
		if (force || !this.cache.get(cacheKey)) {
			this.render({
				kind: 'loading', fileName, languageName, model: this.settings.ollamaModel,
				label: this.fileMode === 'detail' ? 'a detailed explanation' : 'a short explanation',
			});
		}

		// Guard against stale results landing after a newer update started
		// (another editor switch, an edit, or a mode/force change on the same
		// file). Any later update() entry bumps updateSeq, invalidating this one.
		const seq = ++this.updateSeq;
		const result = await this.service.explain(document, this.fileMode, force);
		if (seq !== this.updateSeq || !this.lastKey?.startsWith(`file:${document.uri.toString()}:`)) {
			return;
		}

		this.renderResult(result, { fileName, languageName, target: 'file', mode: this.fileMode });
	}

	private async updateSelection(force = false): Promise<void> {
		if (this.target.kind !== 'selection') {
			return;
		}
		const t = this.target;
		const key = `sel:${t.uri}:${t.sel.startLine}-${t.sel.endLine}:${this.selMode}`;
		if (!force && this.lastKey === key) {
			return;
		}
		this.lastKey = key;
		this.retryTarget = 'explanation';

		const lines = this.linesLabel(t);
		const selDoc = this.selectionDoc(t);

		if (!isSupported({ languageId: t.languageId })) {
			this.render({ kind: 'unsupported', fileName: t.fileName, languageId: t.languageId, lines });
			return;
		}
		if (t.sel.text.trim().length === 0) {
			this.render({ kind: 'empty', fileName: t.fileName, lines });
			return;
		}

		const cacheKey = ExplanationCache.key(t.uri, t.version, this.settings.ollamaModel, `sel:${this.selMode}:${t.sel.startLine}-${t.sel.endLine}`);
		if (force || !this.cache.get(cacheKey)) {
			this.render({
				kind: 'loading', fileName: t.fileName, languageName: t.languageName, lines,
				model: this.settings.ollamaModel,
				label: this.selMode === 'learn' ? 'a learning breakdown' : 'an explanation of the selection',
			});
		}

		const seq = ++this.updateSeq;
		const result = await this.service.explainSelection(selDoc, t.sel, this.selMode, force);
		if (seq !== this.updateSeq || this.lastKey !== key) {
			return;
		}

		this.renderResult(result, { fileName: t.fileName, languageName: t.languageName, target: 'selection', mode: this.selMode, lines });
	}

	private startQuiz(): void {
		if (this.target.kind !== 'selection') {
			return;
		}
		this.retryTarget = 'question';
		this.quizQuestion = undefined;
		this.quizAnswer = undefined;
		void this.runQuiz();
	}

	private async runQuiz(): Promise<void> {
		if (this.target.kind !== 'selection') {
			return;
		}
		const t = this.target;
		const lines = this.linesLabel(t);
		const seq = ++this.updateSeq;
		this.render({
			kind: 'loading', fileName: t.fileName, languageName: t.languageName, lines,
			model: this.settings.ollamaModel, label: 'a practice question',
		});

		const result = await this.service.generateQuestion(this.selectionDoc(t), t.sel);
		if (seq !== this.updateSeq) {
			return;
		}
		if (result.status === 'ok' && result.source === 'model') {
			this.quizQuestion = result.text;
			this.render({
				kind: 'quiz', fileName: t.fileName, languageName: t.languageName, lines,
				model: this.settings.ollamaModel, question: result.text,
			});
			return;
		}
		this.renderResult(result, { fileName: t.fileName, languageName: t.languageName, target: 'selection', mode: 'explain', lines });
	}

	private submitAnswer(text: string): void {
		if (this.target.kind !== 'selection' || this.quizQuestion === undefined) {
			return;
		}
		const answer = text.trim().slice(0, MAX_ANSWER_CHARS);
		if (answer.length === 0) {
			// Re-render the question with a nudge rather than dispatching a
			// wasted model call on an empty answer.
			this.render({
				kind: 'quiz',
				fileName: this.target.fileName, languageName: this.target.languageName,
				lines: this.linesLabel(this.target), model: this.settings.ollamaModel,
				question: this.quizQuestion,
			});
			return;
		}
		this.retryTarget = 'assessment';
		this.quizAnswer = answer;
		void this.runAssessment(this.quizQuestion, answer);
	}

	private async runAssessment(question: string, answer: string): Promise<void> {
		if (this.target.kind !== 'selection') {
			return;
		}
		const t = this.target;
		const lines = this.linesLabel(t);
		const seq = ++this.updateSeq;
		this.render({
			kind: 'loading', fileName: t.fileName, languageName: t.languageName, lines,
			model: this.settings.ollamaModel, label: 'feedback on your answer',
		});

		const result = await this.service.assessAnswer(this.selectionDoc(t), t.sel, question, answer);
		if (seq !== this.updateSeq) {
			return;
		}
		if (result.status === 'ok' && result.source === 'model') {
			this.render({
				kind: 'quizResult', fileName: t.fileName, languageName: t.languageName, lines,
				model: this.settings.ollamaModel, question, answer,
				text: result.text, sections: parseSections(result.text),
			});
			return;
		}
		this.renderResult(result, { fileName: t.fileName, languageName: t.languageName, target: 'selection', mode: 'explain', lines });
	}

	private renderResult(
		result: ExplanationResult,
		ctx: {
			fileName: string;
			languageName: string;
			target: 'file' | 'selection';
			mode: 'summary' | 'detail' | 'explain' | 'learn';
			lines?: string;
		},
	): void {
		switch (result.status) {
			case 'ok':
				if (result.source === 'model') {
					this.render({
						kind: 'model', fileName: ctx.fileName, languageName: ctx.languageName, lines: ctx.lines,
						model: this.settings.ollamaModel, target: ctx.target, mode: ctx.mode,
						text: result.text,
						sections: ctx.mode === 'learn' ? parseSections(result.text) : undefined,
						fromCache: result.fromCache,
					});
				} else {
					this.render({ kind: 'rules', fileName: ctx.fileName, languageName: ctx.languageName, explanation: result.explanation, lines: ctx.lines });
				}
				break;
			case 'empty':
				this.render({ kind: 'empty', fileName: ctx.fileName, lines: ctx.lines });
				break;
			case 'unsupported':
				this.render({ kind: 'unsupported', fileName: ctx.fileName, languageId: ctx.languageName, lines: ctx.lines });
				break;
			case 'tooLarge':
				this.render({ kind: 'tooLarge', fileName: ctx.fileName, bytes: result.bytes, limit: result.limit, lines: ctx.lines });
				break;
			case 'error':
				this.render({
					kind: 'error', fileName: ctx.fileName, languageName: ctx.languageName, lines: ctx.lines,
					model: this.settings.ollamaModel,
					message: result.message, hint: result.hint,
					fallback: result.fallback,
				});
				break;
		}
	}

	private render(state: ViewState): void {
		this.panel.webview.html = renderDocument(state, makeNonce());
	}

	dispose(): void {
		ExplanationPanel.current = undefined;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
