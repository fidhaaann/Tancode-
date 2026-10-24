import * as vscode from 'vscode';
import { explain as rulesExplain, isSupported } from './analysis';
import { ExplanationCache } from './model/cache';
import { OllamaClient } from './model/ollama';
import { ExplainMode } from './model/prompt';
import { ExplanationResult, ExplanationService } from './model/service';
import { getSettings, TancodeSettings } from './settings';
import { getLogger } from './log';
import { renderDocument, ViewState } from './view';

const PANEL_VIEW_TYPE = 'tancode.explanation';
const DEBOUNCE_MS = 350;

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

export class ExplanationPanel {
	private static current: ExplanationPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cache = new ExplanationCache<ExplanationResult>();
	private settings: TancodeSettings;
	private service: ExplanationService;
	private mode: ExplainMode = 'summary';
	private debounceTimer: NodeJS.Timeout | undefined;
	private lastDoc: { uri: string; version: number; mode: ExplainMode } | undefined;
	private updateSeq = 0;

	static createOrShow(context: vscode.ExtensionContext): void {
		if (ExplanationPanel.current) {
			ExplanationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			ExplanationPanel.current.scheduleUpdate(0);
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
				this.scheduleUpdate();
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (this.lastDoc && event.document.uri.toString() === this.lastDoc.uri) {
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
				if (message?.type === 'detail') {
					this.mode = 'detail';
					this.scheduleUpdate(0);
				} else if (message?.type === 'summary') {
					this.mode = 'summary';
					this.scheduleUpdate(0);
				} else if (message?.type === 'retry') {
					this.scheduleUpdate(0, true);
				}
			})
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
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

	private async update(force = false): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const document = editor?.document;

		if (!document) {
			// Same guard for update()s triggered by other listeners while the
			// webview itself is focused.
			if (this.panel.active && this.lastDoc) {
				return;
			}
			this.lastDoc = undefined;
			this.render({ kind: 'noEditor' });
			return;
		}

		if (!force
			&& this.lastDoc
			&& document.uri.toString() === this.lastDoc.uri
			&& document.version === this.lastDoc.version
			&& this.mode === this.lastDoc.mode) {
			return;
		}
		this.lastDoc = { uri: document.uri.toString(), version: document.version, mode: this.mode };

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
		const key = ExplanationCache.key(document.uri.toString(), document.version, this.settings.ollamaModel, this.mode);
		if (force || !this.cache.get(key)) {
			this.render({ kind: 'loading', fileName, languageName, model: this.settings.ollamaModel, mode: this.mode });
		}

		// Guard against stale results landing after a newer update started
		// (another editor switch, an edit, or a mode/force change on the same
		// file). Any later update() entry bumps updateSeq, invalidating this one.
		const seq = ++this.updateSeq;
		const result = await this.service.explain(document, this.mode, force);
		if (seq !== this.updateSeq || this.lastDoc?.uri !== document.uri.toString()) {
			return;
		}

		switch (result.status) {
			case 'ok':
				if (result.source === 'model') {
					this.render({
						kind: 'model', fileName, languageName,
						model: this.settings.ollamaModel, mode: this.mode,
						text: result.text, fromCache: result.fromCache,
					});
				} else {
					this.render({ kind: 'rules', fileName, languageName, explanation: result.explanation });
				}
				break;
			case 'empty':
				this.render({ kind: 'empty', fileName });
				break;
			case 'unsupported':
				this.render({ kind: 'unsupported', fileName, languageId: document.languageId });
				break;
			case 'tooLarge':
				this.render({ kind: 'tooLarge', fileName, bytes: result.bytes, limit: result.limit });
				break;
			case 'error':
				this.render({
					kind: 'error', fileName, languageName,
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
