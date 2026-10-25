import * as vscode from 'vscode';
import { explain as rulesExplain, isSupported } from './analysis';
import { ExplanationCache } from './model/cache';
import { OllamaClient } from './model/ollama';
import { CodeSelection, ExplainMode, parseSections, SelectionMode } from './model/prompt';
import { DocLike, ExplanationResult, ExplanationService } from './model/service';
import { dispatchWebviewMessage } from './messages';
import { getSettings, TancodeSettings } from './settings';
import { getLogger } from './log';
import { renderConversationDocument, ViewState } from './view';
import { assistantMessage, ChatEntry, pushTurn, HistoryTurn, stateEntry, userMessage } from './conversation';
import { routeMessage } from './chat';
import { diagKey, DiagLike, effectiveCooldownSeconds, hashContent, pickDiagnostic, ProactiveBudget } from './proactive';
import { collectProjectFacts, collectTechProfile, formatFacts, formatTechProfile, ProjectFacts, TechProfile } from './project';
import { execFileSync } from 'node:child_process';

const PANEL_VIEW_TYPE = 'tancode.explanation';
const DEBOUNCE_MS = 350;
const CONTEXT_LINES = 8;
const MAX_CONTEXT_CHARS = 2000;
const MAX_ANSWER_CHARS = 4000;
const MAX_CHAT_CHARS = 2000;
const DIAG_DEBOUNCE_MS = 800;
const INSIGHT_DEBOUNCE_MS = 1500;
const MAX_FEED_ENTRIES = 100;
const MAX_TOUCHED_FILES = 40;
// A diagnostic insight looks at the reported line plus this much context
// on each side — enough to explain, small enough to stay fast.
const DIAG_CONTEXT_LINES = 3;
// Streamed chunks can arrive many times per second — re-render at most
// this often so the webview stays responsive while text accumulates.
const STREAM_PAINT_MS = 120;

function fileNameOf(document: vscode.TextDocument): string {
	return document.fileName.split(/[\\/]/).pop() ?? 'untitled';
}

// Manifests/configs worth a proactive note or a profile refresh — matched by
// basename so they fire from any directory depth.
const MANIFEST_FILES = new Set([
	'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
	'tsconfig.json', 'jsconfig.json', 'launch.json', 'tasks.json', 'settings.json',
	'.nvmrc', '.node-version', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Pipfile.lock',
	'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'pom.xml',
	'build.gradle', 'build.gradle.kts', 'composer.json', 'composer.lock',
	'Gemfile', 'Gemfile.lock', 'Dockerfile', 'docker-compose.yml',
]);

function isManifestFile(name: string): boolean {
	return MANIFEST_FILES.has(name);
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
	// Aborts the in-flight model request when a newer update starts —
	// frees the GPU instead of letting a stale generation run to
	// completion for a result nobody will see. User-driven flows
	// (context explanations, chat, quiz) share this controller;
	// proactive flows use their own so a user action can't kill an
	// insight mid-generation (and vice versa).
	private currentAbort: AbortController | undefined;
	private proactiveAbort: AbortController | undefined;

	// --- Conversation state ---
	private contextState: ViewState | undefined;
	private entries: ChatEntry[] = [];
	private nextId = 0;
	private history: HistoryTurn[] = [];
	private inflightCount = 0;
	private budget: ProactiveBudget | undefined;
	private pendingQuestion: { question: string; sel: CodeSelection; selDoc: DocLike } | undefined;
	private knowledgeCheckDone = new Set<string>();
	private quizEntryId: number | undefined;
	private diagSeen = new Set<string>();
	private diagBusy = false;
	private diagTimer: NodeJS.Timeout | undefined;
	private lastInsightHash: string | undefined;
	private insightBusy = false;
	private insightTimer: NodeJS.Timeout | undefined;
	// JARVIS context: orientation runs once per panel session; touchedFiles
	// feeds the session wrap-up; projectFacts is collected lazily and shared
	// by the orientation and recap prompts.
	private orientationDone = false;
	private orientationBusy = false;
	private projectFacts: ProjectFacts | undefined;
	private touchedFiles: string[] = [];
	private techProfile: TechProfile | undefined;
	private manifestBusy = false;
	private manifestSeen = new Set<string>();

	// `Tancode: Clear Conversation` command path — no-op when no panel exists.
	static clearChat(): void {
		ExplanationPanel.current?.clearConversation();
	}

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

	private get proactiveBudget(): ProactiveBudget {
		if (!this.budget) {
			this.budget = new ProactiveBudget(
				effectiveCooldownSeconds(this.settings.proactiveFrequency, this.settings.proactiveCooldownSeconds) * 1000,
				this.settings.proactiveMaxPerSession,
			);
		}
		return this.budget;
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
					chat: text => void this.onChat(text),
					stop: () => this.stopGeneration(),
					pause: () => this.setProactiveEnabled(false),
					resume: () => this.setProactiveEnabled(true),
					dismiss: id => this.dismissEntry(id),
					clear: () => this.clearConversation(),
				});
			}),
			// Proactive trigger 1: editor diagnostics — debounced; only the
			// active file's diagnostics are ever considered.
			vscode.languages.onDidChangeDiagnostics(event => {
				const editor = vscode.window.activeTextEditor;
				if (!editor || !this.settings.proactiveEnabled) {
					return;
				}
				if (!event.uris.some(u => u.toString() === editor.document.uri.toString())) {
					return;
				}
				this.scheduleDiagCheck();
			}),
			// Proactive trigger 2: a meaningful change saved in the active file.
			vscode.workspace.onDidSaveTextDocument(document => {
				if (!this.settings.proactiveEnabled || this.settings.proactiveLevel === 'errors-only') {
					return;
				}
				if (document !== vscode.window.activeTextEditor?.document || !isSupported(document)) {
					return;
				}
				this.noteTouchedFile(document);
				// A manifest edit invalidates the tech profile — deps, engines,
				// and resolved versions may have changed.
				if (isManifestFile(fileNameOf(document))) {
					this.techProfile = undefined;
				}
				this.scheduleInsight();
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
				depth: this.settings.explanationDepth,
				simplified: this.settings.simplifiedExplanations,
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

	private beginRequest(): AbortController {
		this.currentAbort?.abort();
		this.currentAbort = new AbortController();
		return this.currentAbort;
	}

	private beginProactive(): AbortController {
		this.proactiveAbort?.abort();
		this.proactiveAbort = new AbortController();
		return this.proactiveAbort;
	}

	// inflightCount drives the Stop button and the "generating" state.
	private beginInflight(): void {
		this.inflightCount++;
		this.renderAll();
	}

	private endInflight(): void {
		this.inflightCount = Math.max(0, this.inflightCount - 1);
		this.renderAll();
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
		this.noteTouchedFile(document);

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
		const abort = this.beginRequest();
		let lastPaint = 0;
		const onToken = (text: string): void => {
			const now = Date.now();
			if (seq !== this.updateSeq || now - lastPaint < STREAM_PAINT_MS) {
				return;
			}
			lastPaint = now;
			this.render({
				kind: 'model', fileName, languageName,
				model: this.settings.ollamaModel, target: 'file', mode: this.fileMode,
				text, fromCache: false, partial: true,
			});
		};
		let result: ExplanationResult;
		this.beginInflight();
		try {
			result = await this.service.explain(document, this.fileMode, force, { signal: abort.signal, onToken });
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq || !this.lastKey?.startsWith(`file:${document.uri.toString()}:`)) {
			return;
		}

		this.renderResult(result, { fileName, languageName, target: 'file', mode: this.fileMode });
		this.maybeOrientation();
		this.maybeManifestInsight(document);
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
		const abort = this.beginRequest();
		let lastPaint = 0;
		const onToken = (text: string): void => {
			const now = Date.now();
			if (seq !== this.updateSeq || now - lastPaint < STREAM_PAINT_MS) {
				return;
			}
			lastPaint = now;
			this.render({
				kind: 'model', fileName: t.fileName, languageName: t.languageName, lines,
				model: this.settings.ollamaModel, target: 'selection', mode: this.selMode,
				text, fromCache: false, partial: true,
			});
		};
		let result: ExplanationResult;
		this.beginInflight();
		try {
			result = await this.service.explainSelection(selDoc, t.sel, this.selMode, force, { signal: abort.signal, onToken });
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq || this.lastKey !== key) {
			return;
		}

		this.renderResult(result, { fileName: t.fileName, languageName: t.languageName, target: 'selection', mode: this.selMode, lines });
		if (this.selMode === 'learn' && result.status === 'ok' && result.source === 'model') {
			// After teaching a concept, offer one knowledge check — never
			// more than once per selection, budgeted like other proactive
			// messages so it can't spam.
			void this.maybeKnowledgeCheck(t, selDoc);
		}
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
		const selDoc = this.selectionDoc(t);
		const lines = this.linesLabel(t);
		const seq = ++this.updateSeq;
		const abort = this.beginRequest();
		// Quiz lives in the feed, not the pinned context card — the
		// conversation stays visible while the question generates.
		const entryId = ++this.nextId;
		this.quizEntryId = entryId;
		this.pushEntry(stateEntry(entryId, {
			kind: 'loading', fileName: t.fileName, languageName: t.languageName, lines,
			model: this.settings.ollamaModel, label: 'a practice question',
		}, 'question'));

		let result: ExplanationResult;
		this.beginInflight();
		try {
			result = await this.service.generateQuestion(selDoc, t.sel, { signal: abort.signal });
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq) {
			return;
		}
		if (result.status === 'ok' && result.source === 'model') {
			this.quizQuestion = result.text;
			this.pendingQuestion = { question: result.text, sel: t.sel, selDoc };
			this.updateEntryState(entryId, {
				kind: 'quiz', fileName: t.fileName, languageName: t.languageName, lines,
				model: this.settings.ollamaModel, question: result.text,
			});
			return;
		}
		this.updateEntryState(entryId, this.resultToState(result, { fileName: t.fileName, languageName: t.languageName, target: 'selection', mode: 'explain', lines }));
	}

	private updateEntryState(id: number, state: ViewState): void {
		const entry = this.entries.find(e => e.id === id && e.kind === 'state');
		if (entry && entry.kind === 'state') {
			entry.state = state;
		}
		this.renderAll();
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
		const abort = this.beginRequest();
		const entryId = this.quizEntryId ?? ++this.nextId;
		this.quizEntryId = entryId;
		this.pushEntry(stateEntry(entryId, {
			kind: 'loading', fileName: t.fileName, languageName: t.languageName, lines,
			model: this.settings.ollamaModel, label: 'feedback on your answer',
		}, 'answer'));

		let result: ExplanationResult;
		this.beginInflight();
		try {
			result = await this.service.assessAnswer(this.selectionDoc(t), t.sel, question, answer, { signal: abort.signal });
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq) {
			return;
		}
		this.pendingQuestion = undefined;
		if (result.status === 'ok' && result.source === 'model') {
			this.updateEntryState(entryId, {
				kind: 'quizResult', fileName: t.fileName, languageName: t.languageName, lines,
				model: this.settings.ollamaModel, question, answer,
				text: result.text, sections: parseSections(result.text),
			});
			return;
		}
		this.updateEntryState(entryId, this.resultToState(result, { fileName: t.fileName, languageName: t.languageName, target: 'selection', mode: 'explain', lines }));
	}

	private resultToState(
		result: ExplanationResult,
		ctx: {
			fileName: string;
			languageName: string;
			target: 'file' | 'selection';
			mode: 'summary' | 'detail' | 'explain' | 'learn';
			lines?: string;
		},
	): ViewState {
		switch (result.status) {
			case 'ok':
				return result.source === 'model'
					? {
						kind: 'model', fileName: ctx.fileName, languageName: ctx.languageName, lines: ctx.lines,
						model: this.settings.ollamaModel, target: ctx.target, mode: ctx.mode,
						text: result.text,
						sections: ctx.mode === 'learn' ? parseSections(result.text) : undefined,
						fromCache: result.fromCache,
					}
					: { kind: 'rules', fileName: ctx.fileName, languageName: ctx.languageName, explanation: result.explanation, lines: ctx.lines };
			case 'empty':
				return { kind: 'empty', fileName: ctx.fileName, lines: ctx.lines };
			case 'unsupported':
				return { kind: 'unsupported', fileName: ctx.fileName, languageId: ctx.languageName, lines: ctx.lines };
			case 'tooLarge':
				return { kind: 'tooLarge', fileName: ctx.fileName, bytes: result.bytes, limit: result.limit, lines: ctx.lines };
			case 'error':
				return {
					kind: 'error', fileName: ctx.fileName, languageName: ctx.languageName, lines: ctx.lines,
					model: this.settings.ollamaModel,
					message: result.message, hint: result.hint,
					fallback: result.fallback,
				};
		}
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
		// A user-stopped or superseded request is not an error worth a red
		// banner — note it quietly in the feed and keep the context card.
		if (result.status === 'error' && result.kind === 'cancelled') {
			this.pushEntry(assistantMessage(++this.nextId, 'info', 'Generation stopped.'));
			return;
		}
		this.render(this.resultToState(result, ctx));
	}

	// --- Chat ---

	private async onChat(text: string): Promise<void> {
		const trimmed = text.trim().slice(0, MAX_CHAT_CHARS);
		if (trimmed.length === 0) {
			return;
		}
		this.pushEntry(userMessage(++this.nextId, trimmed));
		pushTurn(this.history, { role: 'user', text: trimmed });
		const intent = routeMessage(trimmed, this.pendingQuestion !== undefined);
		switch (intent.type) {
			case 'pause':
				this.setProactiveEnabled(false);
				this.pushEntry(assistantMessage(++this.nextId, 'info',
					'Proactive assistance is paused — I\u2019ll only respond when you ask. Say "resume proactive" to turn it back on.'));
				return;
			case 'resume':
				this.setProactiveEnabled(true);
				this.pushEntry(assistantMessage(++this.nextId, 'info', 'Proactive assistance is on again.'));
				return;
			case 'why':
				this.pushEntry(assistantMessage(++this.nextId, 'info',
					'I proactively explain editor errors and occasionally flag a learning moment in code you save — never more than a few at a time. ' +
					'You can pause me from the toolbar, say "pause proactive", or tune tancode.proactive.* in Settings.'));
				return;
			case 'wrap-up':
				return this.runWrapup();
			case 'clear':
				this.clearConversation();
				return;
			case 'quiz-answer':
				return this.answerPendingQuestion(trimmed);
			default:
				return this.answerDirect(trimmed);
		}
	}

	private currentDoc(): vscode.TextDocument | DocLike | undefined {
		if (this.target.kind === 'selection') {
			return this.selectionDoc(this.target);
		}
		return vscode.window.activeTextEditor?.document;
	}

	private async answerDirect(text: string): Promise<void> {
		const doc = this.currentDoc();
		if (!doc) {
			this.pushEntry(assistantMessage(++this.nextId, 'info', 'Open a source file or select some code, then ask again.'));
			return;
		}
		const seq = ++this.updateSeq;
		const abort = this.beginRequest();
		const entryId = ++this.nextId;
		this.pushEntry(assistantMessage(entryId, 'answer', '', { partial: true, model: this.settings.ollamaModel }));

		const entry = this.entries.find(e => e.id === entryId);
		let lastPaint = 0;
		const onToken = (accumulated: string): void => {
			const now = Date.now();
			if (seq !== this.updateSeq || now - lastPaint < STREAM_PAINT_MS || !entry || entry.kind !== 'message') {
				return;
			}
			lastPaint = now;
			entry.text = accumulated;
			this.renderAll();
		};

		const sel = this.target.kind === 'selection' ? this.target.sel : undefined;
		this.beginInflight();
		let result: ExplanationResult;
		try {
			result = await this.service.chatAnswer(doc, sel, text, this.history, { signal: abort.signal, onToken }, this.techProfileText());
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq) {
			return;
		}
		this.finishChatEntry(entryId, result);
	}

	private async answerPendingQuestion(answer: string): Promise<void> {
		const p = this.pendingQuestion;
		this.pendingQuestion = undefined;
		if (!p) {
			return this.answerDirect(answer);
		}
		const seq = ++this.updateSeq;
		const abort = this.beginRequest();
		const entryId = ++this.nextId;
		this.pushEntry(assistantMessage(entryId, 'answer', '', { partial: true, model: this.settings.ollamaModel }));
		this.beginInflight();
		let result: ExplanationResult;
		try {
			result = await this.service.assessAnswer(p.selDoc, p.sel, p.question, answer.slice(0, MAX_ANSWER_CHARS), { signal: abort.signal });
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq) {
			return;
		}
		this.finishChatEntry(entryId, result);
	}

	// Landing spot for chat answers and assessments: stream text becomes the
	// message, failures become an honest error note instead of a hang.
	private finishChatEntry(entryId: number, result: ExplanationResult): void {
		const entry = this.entries.find(e => e.id === entryId);
		if (!entry || entry.kind !== 'message') {
			return;
		}
		entry.partial = false;
		if (result.status === 'ok' && result.source === 'model') {
			entry.text = result.text;
			pushTurn(this.history, { role: 'assistant', text: result.text });
		} else if (result.status === 'ok' && result.source === 'rules') {
			entry.text = result.explanation.summary;
		} else if (result.status === 'error' && result.kind === 'cancelled') {
			entry.tag = 'info';
			entry.text = 'Generation stopped.';
		} else if (result.status === 'error') {
			entry.tag = 'error';
			entry.text = `${result.message} ${result.hint}`;
		} else {
			entry.tag = 'info';
			entry.text = 'I could not generate an answer for that — try again?';
		}
		this.renderAll();
	}

	private stopGeneration(): void {
		this.currentAbort?.abort();
		this.proactiveAbort?.abort();
	}

	private dismissEntry(id: number): void {
		const entry = this.entries.find(e => e.id === id);
		if (entry && entry.kind === 'message') {
			entry.dismissed = true;
			this.renderAll();
		}
	}

	// Wipe the conversation (feed + bounded history) — session memory only,
	// nothing is persisted either way. Command + chat phrase both land here.
	clearConversation(): void {
		this.entries = [];
		this.history = [];
		this.pendingQuestion = undefined;
		this.pushEntry(assistantMessage(++this.nextId, 'info', 'Conversation cleared — what should we look at next?'));
	}

	private noteTouchedFile(document: vscode.TextDocument): void {
		const name = fileNameOf(document);
		if (this.touchedFiles[this.touchedFiles.length - 1] !== name) {
			this.touchedFiles.push(name);
			if (this.touchedFiles.length > MAX_TOUCHED_FILES) {
				this.touchedFiles.shift();
			}
		}
	}

	private getProjectFacts(): ProjectFacts | undefined {
		if (this.projectFacts) {
			return this.projectFacts;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return undefined;
		}
		try {
			this.projectFacts = collectProjectFacts(folder.uri.fsPath);
			return this.projectFacts;
		} catch {
			return undefined;
		}
	}

	// Project tech profile — collected lazily, refreshed when a manifest is
	// saved. Runtime detection is a real probe (node --version), reported as
	// "detected local runtime" — never conflated with declared/resolved.
	private getTechProfile(): TechProfile | undefined {
		if (this.techProfile) {
			return this.techProfile;
		}
		const editor = vscode.window.activeTextEditor;
		const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
		const root = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return undefined;
		}
		try {
			this.techProfile = collectTechProfile(root, () => {
				try {
					const v = execFileSync('node', ['--version'], { timeout: 3000 }).toString().trim();
					return v ? { tool: 'node', version: v } : undefined;
				} catch {
					return undefined;
				}
			});
			return this.techProfile;
		} catch {
			return undefined;
		}
	}

	private techProfileText(): string | undefined {
		const p = this.getTechProfile();
		if (!p) {
			return undefined;
		}
		const text = formatTechProfile(p);
		return text.length > 0 ? text : undefined;
	}

	// Proactive note when a project manifest (package.json, tsconfig, …) is
	// opened — one grounded remark from the extracted profile, or NONE.
	private maybeManifestInsight(document: vscode.TextDocument): void {
		const fileName = fileNameOf(document);
		if (!isManifestFile(fileName) || this.manifestBusy || !this.settings.proactiveEnabled || this.settings.proactiveLevel === 'errors-only') {
			return;
		}
		const profileText = this.techProfileText();
		if (!profileText) {
			return;
		}
		const key = `manifest:${fileName}:${hashContent(profileText)}`;
		if (this.manifestSeen.has(key) || this.proactiveBudget.check(key) !== 'allow') {
			return;
		}
		this.manifestBusy = true;
		this.beginInflight();
		const abort = this.beginProactive();
		void this.service.manifestInsight(fileName, profileText, key, { signal: abort.signal })
			.then(result => {
				this.manifestSeen.add(key);
				if (result.status === 'ok' && result.source === 'model' && result.text.trim() !== 'NONE' && result.text.trim().length > 0) {
					this.proactiveBudget.commit(key);
					this.pushEntry(assistantMessage(++this.nextId, 'insight', result.text, {
						model: this.settings.ollamaModel, dismissible: true,
					}));
				}
			})
			.finally(() => {
				this.manifestBusy = false;
				this.endInflight();
			});
	}

	// Stage A: once per panel session, post a project orientation built only
	// from deterministic local facts. Counts as a proactive message.
	private maybeOrientation(): void {
		if (this.orientationDone || this.orientationBusy || !this.settings.proactiveEnabled) {
			return;
		}
		const facts = this.getProjectFacts();
		if (!facts) {
			this.orientationDone = true;
			return;
		}
		const factsText = formatFacts(facts);
		const key = `orientation:${facts.root}:${hashContent(factsText)}`;
		if (this.proactiveBudget.check('orientation') !== 'allow') {
			this.orientationDone = true; // budget spent — don't nag later
			return;
		}
		this.orientationDone = true;
		this.orientationBusy = true;
		this.beginInflight();
		const abort = this.beginProactive();
		void this.service.projectOrientation(factsText, key, { signal: abort.signal })
			.then(result => {
				if (result.status === 'ok' && result.source === 'model') {
					this.proactiveBudget.commit('orientation');
					this.pushEntry(assistantMessage(++this.nextId, 'insight', result.text, {
						model: this.settings.ollamaModel, dismissible: true,
					}));
				}
			})
			.finally(() => {
				this.orientationBusy = false;
				this.endInflight();
			});
	}

	// Stage: wrap-up — user asked for a recap; ground it in this session's
	// touched files, project facts, and conversation history.
	private async runWrapup(): Promise<void> {
		const seq = ++this.updateSeq;
		const abort = this.beginRequest();
		const entryId = ++this.nextId;
		this.pushEntry(assistantMessage(entryId, 'answer', '', { partial: true, model: this.settings.ollamaModel }));
		const facts = this.getProjectFacts();
		this.beginInflight();
		let result: ExplanationResult;
		try {
			result = await this.service.sessionRecap({
				projectFacts: facts ? formatFacts(facts) : 'No project facts collected this session.',
				touchedFiles: this.touchedFiles,
				history: this.history,
			}, { signal: abort.signal });
		} finally {
			this.endInflight();
		}
		if (seq !== this.updateSeq) {
			return;
		}
		this.finishChatEntry(entryId, result);
	}

	private setProactiveEnabled(on: boolean): void {
		this.settings = { ...this.settings, proactiveEnabled: on };
		void vscode.workspace.getConfiguration('tancode').update('proactive.enabled', on, true);
		this.renderAll();
	}

	// --- Proactive observation ---

	private scheduleDiagCheck(delay = DIAG_DEBOUNCE_MS): void {
		if (this.diagTimer) {
			clearTimeout(this.diagTimer);
		}
		this.diagTimer = setTimeout(() => {
			this.diagTimer = undefined;
			void this.evaluateDiagnostics();
		}, delay);
	}

	private async evaluateDiagnostics(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || this.diagBusy || !this.settings.proactiveEnabled) {
			return;
		}
		const uri = editor.document.uri.toString();
		const diags: DiagLike[] = vscode.languages.getDiagnostics(editor.document.uri).map(d => ({
			severity: d.severity,
			message: d.message,
			line: d.range.start.line + 1,
			code: d.code === undefined ? undefined : typeof d.code === 'object' ? String(d.code.value) : String(d.code),
		}));
		const unseen = diags.filter(d => !this.diagSeen.has(diagKey(uri, d)));
		const diag = pickDiagnostic(unseen, this.settings.proactiveLevel === 'errors-only');
		if (!diag) {
			return;
		}
		const hash = diagKey(uri, diag);
		const verdict = this.proactiveBudget.check(`diag:${hash}`);
		if (verdict === 'seen' || verdict === 'limit') {
			this.diagSeen.add(hash);
			return;
		}
		if (verdict === 'cooldown') {
			// Hold it — try again when the cooldown expires rather than
			// dropping the error explanation entirely.
			this.scheduleDiagCheck(this.proactiveBudget.cooldownRemainingMs + 100);
			return;
		}

		this.diagBusy = true;
		this.beginInflight();
		const abort = this.beginProactive();
		try {
			const doc = editor.document;
			const line = Math.min(diag.line, doc.lineCount);
			const from = Math.max(1, line - DIAG_CONTEXT_LINES);
			const to = Math.min(doc.lineCount, line + DIAG_CONTEXT_LINES);
			const sel: CodeSelection = {
				startLine: line,
				endLine: line,
				text: doc.getText(new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER)),
				before: from < line ? doc.getText(new vscode.Range(from - 1, 0, line - 1, 0)) : undefined,
				after: to > line ? doc.getText(new vscode.Range(line, 0, to, Number.MAX_SAFE_INTEGER)) : undefined,
			};
			const result = await this.service.explainDiagnostic(
				doc, sel,
				{ message: diag.message, severity: diag.severity === 0 ? 'error' : 'warning', line, code: diag.code === undefined ? undefined : String(diag.code) },
				`diag:${uri}:${hash}`,
				{ signal: abort.signal },
			);
			if (result.status === 'ok' && result.source === 'model') {
				this.diagSeen.add(hash);
				this.proactiveBudget.commit(`diag:${hash}`);
				this.pushEntry(assistantMessage(++this.nextId, 'error', result.text, {
					model: this.settings.ollamaModel, dismissible: true,
				}));
			} else if (result.status === 'error' && result.kind !== 'cancelled') {
				// Model trouble should not spam: mark seen so we don't retry a
				// flood of identical explanations, and log it for diagnosis.
				this.diagSeen.add(hash);
				getLogger().info(`proactive diag: failed kind=${result.kind}`);
			}
		} finally {
			this.diagBusy = false;
			this.endInflight();
		}
	}

	private scheduleInsight(delay = INSIGHT_DEBOUNCE_MS): void {
		if (this.insightTimer) {
			clearTimeout(this.insightTimer);
		}
		this.insightTimer = setTimeout(() => {
			this.insightTimer = undefined;
			void this.evaluateInsight();
		}, delay);
	}

	private async evaluateInsight(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const document = editor?.document;
		if (!document || this.insightBusy || !this.settings.proactiveEnabled || this.settings.proactiveLevel === 'errors-only') {
			return;
		}
		const hash = hashContent(document.getText());
		if (hash === this.lastInsightHash) {
			return; // identical content already asked — save a wasted request
		}
		const key = `insight:${document.uri.toString()}:${hash}`;
		const verdict = this.proactiveBudget.check(key);
		if (verdict !== 'allow') {
			if (verdict === 'cooldown') {
				this.scheduleInsight(this.proactiveBudget.cooldownRemainingMs + 100);
			}
			return;
		}
		this.lastInsightHash = hash;

		this.insightBusy = true;
		this.beginInflight();
		const abort = this.beginProactive();
		try {
			const result = await this.service.findInsight(document, hash, { signal: abort.signal });
			if (result.status === 'ok' && result.source === 'model' && result.text.trim().toUpperCase() !== 'NONE') {
				this.proactiveBudget.commit(key);
				this.pushEntry(assistantMessage(++this.nextId, 'insight', result.text, {
					model: this.settings.ollamaModel, dismissible: true,
				}));
			}
		} finally {
			this.insightBusy = false;
			this.endInflight();
		}
	}

	// After a Learn explanation lands, ask at most one understanding check
	// per selection — gated by the same proactive budget.
	private async maybeKnowledgeCheck(t: SelectionTarget, selDoc: DocLike): Promise<void> {
		if (!this.settings.proactiveEnabled || !this.settings.interactiveQuestions) {
			return;
		}
		const doneKey = `check:${t.uri}:${t.sel.startLine}-${t.sel.endLine}`;
		if (this.knowledgeCheckDone.has(doneKey) || this.pendingQuestion) {
			return;
		}
		const key = `kcheck:${t.uri}:${t.sel.startLine}-${t.sel.endLine}`;
		if (this.proactiveBudget.check(key) !== 'allow') {
			return;
		}
		this.knowledgeCheckDone.add(doneKey);
		this.beginInflight();
		const abort = this.beginProactive();
		try {
			const result = await this.service.generateQuestion(selDoc, t.sel, { signal: abort.signal });
			if (result.status === 'ok' && result.source === 'model') {
				this.proactiveBudget.commit(key);
				this.pendingQuestion = { question: result.text, sel: t.sel, selDoc };
				this.pushEntry(assistantMessage(++this.nextId, 'question', result.text, {
					model: this.settings.ollamaModel, dismissible: true,
				}));
			}
		} finally {
			this.endInflight();
		}
	}

	// --- Conversation rendering ---

	private pushEntry(entry: ChatEntry): void {
		this.entries.push(entry);
		while (this.entries.length > MAX_FEED_ENTRIES) {
			this.entries.shift();
		}
		this.renderAll();
	}

	private watchingLabel(): string {
		if (this.target.kind === 'selection') {
			return `${this.target.fileName} · ${this.linesLabel(this.target)}`;
		}
		const editor = vscode.window.activeTextEditor;
		return editor ? fileNameOf(editor.document) : '';
	}

	private render(state: ViewState): void {
		// The state renders as the pinned context card above the feed.
		this.contextState = state;
		this.renderAll();
	}

	private renderAll(): void {
		this.panel.webview.html = renderConversationDocument({
			context: this.contextState,
			entries: this.entries,
			watching: this.watchingLabel(),
			model: this.settings.ollamaModel,
			paused: !this.settings.proactiveEnabled,
			generating: this.inflightCount > 0,
			proactiveCount: this.proactiveBudget.messagesPosted,
			proactiveMax: this.settings.proactiveMaxPerSession,
		}, makeNonce());
	}

	dispose(): void {
		ExplanationPanel.current = undefined;
		this.currentAbort?.abort();
		this.proactiveAbort?.abort();
		if (this.diagTimer) {
			clearTimeout(this.diagTimer);
		}
		if (this.insightTimer) {
			clearTimeout(this.insightTimer);
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
