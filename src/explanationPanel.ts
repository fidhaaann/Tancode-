import * as vscode from 'vscode';
import { explain, isSupported, FileExplanation } from './analysis';

// Escape anything derived from the workspace before inserting it into
// the webview: file contents and names are untrusted input.
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const PANEL_VIEW_TYPE = 'tancode.explanation';

export class ExplanationPanel {
	private static current: ExplanationPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private lastAnalyzed: { uri: string; version: number } | undefined;

	static createOrShow(context: vscode.ExtensionContext): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		if (ExplanationPanel.current) {
			ExplanationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			ExplanationPanel.current.update(vscode.window.activeTextEditor?.document);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			PANEL_VIEW_TYPE,
			'Tancode',
			vscode.ViewColumn.Beside,
			{
				enableScripts: false,
				localResourceRoots: [],
				retainContextWhenHidden: true,
			}
		);

		ExplanationPanel.current = new ExplanationPanel(panel, context);
		ExplanationPanel.current.update(vscode.window.activeTextEditor?.document);
		void column;
	}

	private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
		this.panel = panel;

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				this.update(editor?.document);
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (this.lastAnalyzed && event.document.uri.toString() === this.lastAnalyzed.uri) {
					this.update(event.document);
				}
			})
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	private update(document: vscode.TextDocument | undefined): void {
		// Skip re-analysis when nothing relevant changed.
		if (document
			&& this.lastAnalyzed
			&& document.uri.toString() === this.lastAnalyzed.uri
			&& document.version === this.lastAnalyzed.version) {
			return;
		}

		let explanation: FileExplanation | undefined;
		if (document) {
			explanation = explain(document);
		}

		if (document && explanation) {
			this.lastAnalyzed = { uri: document.uri.toString(), version: document.version };
		} else {
			this.lastAnalyzed = document
				? { uri: document.uri.toString(), version: document.version }
				: undefined;
		}

		this.panel.webview.html = this.render(document, explanation);
	}

	private render(document: vscode.TextDocument | undefined, explanation: FileExplanation | undefined): string {
		let body: string;
		if (!document) {
			body = `<div class="empty">
				<h2>No active editor</h2>
				<p>Open a source file to see a Tancode explanation of what it does.</p>
			</div>`;
		} else if (!isSupported(document)) {
			const name = escapeHtml(document.fileName.split(/[\\/]/).pop() ?? 'untitled');
			const lang = escapeHtml(document.languageId);
			body = `<div class="empty">
				<h2>Unsupported file</h2>
				<p><code>${name}</code> uses language <code>${lang}</code>, which Tancode does not explain yet.</p>
				<p>Open a supported source file (TypeScript, JavaScript, Python, Java, Go, Rust, and similar) to see an explanation.</p>
			</div>`;
		} else if (!explanation) {
			const name = escapeHtml(document.fileName.split(/[\\/]/).pop() ?? 'untitled');
			body = `<div class="empty">
				<h2>Nothing to explain</h2>
				<p><code>${name}</code> is empty or too large to explain quickly.</p>
			</div>`;
		} else {
			const symbols = explanation.symbols.length
				? `<ul class="symbols">${explanation.symbols.map(s =>
					`<li><span class="kind">${escapeHtml(s.kind)}</span> <code>${escapeHtml(s.name)}</code> <span class="loc">line ${s.line}</span></li>`
				).join('')}</ul>`
				: '<p class="muted">No top-level declarations detected.</p>';

			const details = `<details class="details">
				<summary>More detail</summary>
				<ul>${explanation.details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
			</details>`;

			const imports = explanation.imports.length
				? `<p class="muted">Imports: ${explanation.imports.map(i => `<code>${escapeHtml(i)}</code>`).join(', ')}</p>`
				: '';

			body = `<header>
				<h2>${escapeHtml(explanation.fileName)}</h2>
				<p class="muted">${escapeHtml(explanation.languageName)} · ${explanation.nonBlankLineCount} lines</p>
			</header>
			<section>
				<h3>What this file does</h3>
				<p>${escapeHtml(explanation.summary)}</p>
			</section>
			<section>
				<h3>Key declarations</h3>
				${symbols}
				${imports}
			</section>
			${details}`;
		}

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tancode</title>
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-panel-background, transparent);
		padding: 16px 20px;
		line-height: 1.5;
	}
	h2 { font-size: 1.1em; margin: 0 0 2px; }
	h3 { font-size: 0.95em; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
	section { margin-bottom: 4px; }
	.muted { color: var(--vscode-descriptionForeground); margin: 2px 0; }
	.empty { text-align: center; padding: 40px 12px; color: var(--vscode-descriptionForeground); }
	.empty h2 { color: var(--vscode-foreground); }
	ul.symbols { list-style: none; padding: 0; margin: 6px 0; }
	ul.symbols li { padding: 2px 0; }
	.kind {
		display: inline-block; min-width: 5.5em;
		color: var(--vscode-textLink-foreground);
		font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em;
	}
	.loc { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
	details.details { margin-top: 14px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); padding-top: 10px; }
	details.details summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
	details.details ul { margin: 8px 0 0; padding-left: 20px; white-space: pre-wrap; }
	code { font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
${body}
</body>
</html>`;
	}

	dispose(): void {
		ExplanationPanel.current = undefined;
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
