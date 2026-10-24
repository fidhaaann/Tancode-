import type { FileExplanation } from './analysis';
import { ExplainMode } from './model/prompt';

// Every string rendered in the webview that derives from the workspace or
// the model passes through this escape — both are untrusted input.
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export type ViewState =
	| { kind: 'noEditor' }
	| { kind: 'unsupported'; fileName: string; languageId: string }
	| { kind: 'empty'; fileName: string }
	| { kind: 'tooLarge'; fileName: string; bytes: number; limit: number }
	| { kind: 'loading'; fileName: string; languageName: string; model: string; mode: ExplainMode }
	| { kind: 'model'; fileName: string; languageName: string; model: string; mode: ExplainMode; text: string; fromCache: boolean }
	| { kind: 'rules'; fileName: string; languageName: string; explanation: FileExplanation; notice?: string }
	| { kind: 'error'; fileName: string; languageName: string; model: string; message: string; hint: string; fallback?: FileExplanation };

function rulesBody(explanation: FileExplanation): string {
	const symbols = explanation.symbols.length
		? `<ul class="symbols">${explanation.symbols.map(s =>
			`<li><span class="kind">${escapeHtml(s.kind)}</span> <code>${escapeHtml(s.name)}</code> <span class="loc">line ${s.line}</span></li>`
		).join('')}</ul>`
		: '<p class="muted">No top-level declarations detected.</p>';

	const imports = explanation.imports.length
		? `<p class="muted">Imports: ${explanation.imports.map(i => `<code>${escapeHtml(i)}</code>`).join(', ')}</p>`
		: '';

	const details = `<details class="details">
		<summary>More detail</summary>
		<ul>${explanation.details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
	</details>`;

	return `<section>
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

function header(fileName: string, languageName: string, extra = ''): string {
	return `<header>
		<h2>${escapeHtml(fileName)}</h2>
		<p class="muted">${escapeHtml(languageName)}${extra}</p>
	</header>`;
}

const DETAIL_BUTTON = '<button class="btn" data-action="detail">Explain in more detail</button>';
const RETRY_BUTTON = '<button class="btn" data-action="retry">Retry</button>';

function modelText(text: string): string {
	return escapeHtml(text)
		.split(/\n{2,}/)
		.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
		.join('');
}

export function renderBody(state: ViewState): string {
	switch (state.kind) {
		case 'noEditor':
			return `<div class="empty">
				<h2>No active editor</h2>
				<p>Open a source file to see a Tancode explanation of what it does.</p>
			</div>`;

		case 'unsupported':
			return `<div class="empty">
				<h2>Unsupported file</h2>
				<p><code>${escapeHtml(state.fileName)}</code> uses language <code>${escapeHtml(state.languageId)}</code>, which Tancode does not explain yet.</p>
				<p>Open a supported source file (TypeScript, JavaScript, Python, Java, Go, Rust, and similar) to see an explanation.</p>
			</div>`;

		case 'empty':
			return `<div class="empty">
				<h2>Nothing to explain</h2>
				<p><code>${escapeHtml(state.fileName)}</code> is empty.</p>
			</div>`;

		case 'tooLarge':
			return `<div class="empty">
				<h2>File too large</h2>
				<p><code>${escapeHtml(state.fileName)}</code> is ${Math.round(state.bytes / 1024)} KB, over the ${Math.round(state.limit / 1024)} KB limit.</p>
				<p>Raise the <code>tancode.maxSourceBytes</code> setting to analyze larger files.</p>
			</div>`;

		case 'loading':
			return `${header(state.fileName, state.languageName)}
			<div class="loading">
				<div class="spinner"></div>
				<p>Asking <code>${escapeHtml(state.model)}</code> via local Ollama for a ${state.mode === 'detail' ? 'detailed' : 'short'} explanation&hellip;</p>
			</div>`;

		case 'model':
			return `${header(state.fileName, state.languageName, ` · <span class="badge">AI</span> ${escapeHtml(state.model)}${state.fromCache ? ' · cached' : ''}`)}
			<section>
				<h3>What this file does</h3>
				${modelText(state.text)}
			</section>
			<div class="actions">${state.mode === 'summary' ? DETAIL_BUTTON : ''} ${RETRY_BUTTON}</div>
			<p class="muted foot">Generated locally by ${escapeHtml(state.model)} — never sent off your machine. Verify before relying on it.</p>`;

		case 'rules': {
			const notice = state.notice ? `<p class="notice">${escapeHtml(state.notice)}</p>` : '';
			return `${header(state.fileName, state.languageName)}
			${notice}
			<p class="badge rules">Rule-based fallback — not AI-generated</p>
			${rulesBody(state.explanation)}`;
		}

		case 'error': {
			const fallback = state.fallback
				? `<p class="badge rules">Rule-based fallback — not AI-generated</p>${rulesBody(state.fallback)}`
				: '';
			return `${header(state.fileName, state.languageName)}
			<div class="error">
				<h3>Explanation failed</h3>
				<p>${escapeHtml(state.message)}</p>
				<p class="muted">${escapeHtml(state.hint)}</p>
				<div class="actions">${RETRY_BUTTON}</div>
			</div>
			${fallback}`;
		}
	}
}

const CSS = `
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
	.foot { margin-top: 14px; font-size: 0.85em; }
	.empty { text-align: center; padding: 40px 12px; color: var(--vscode-descriptionForeground); }
	.empty h2 { color: var(--vscode-foreground); }
	.loading { display: flex; align-items: center; gap: 12px; margin-top: 24px; color: var(--vscode-descriptionForeground); }
	.spinner {
		width: 16px; height: 16px; flex-shrink: 0;
		border: 2px solid var(--vscode-descriptionForeground);
		border-top-color: transparent; border-radius: 50%;
		animation: tancode-spin 0.9s linear infinite;
	}
	@keyframes tancode-spin { to { transform: rotate(360deg); } }
	ul.symbols { list-style: none; padding: 0; margin: 6px 0; }
	ul.symbols li { padding: 2px 0; }
	.kind {
		display: inline-block; min-width: 5.5em;
		color: var(--vscode-textLink-foreground);
		font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em;
	}
	.loc { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
	.badge {
		display: inline-block; padding: 1px 6px; border-radius: 3px;
		font-size: 0.8em;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
	}
	.badge.rules { background: var(--vscode-descriptionForeground); opacity: 0.9; }
	.notice { color: var(--vscode-editorWarning-foreground, #cca700); }
	.error {
		margin-top: 16px; padding: 10px 14px;
		border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
		background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.08));
	}
	.error h3 { margin-top: 0; color: var(--vscode-editorError-foreground, #f14c4c); }
	.actions { margin-top: 14px; }
	.btn {
		font: inherit; cursor: pointer; margin-right: 8px; padding: 4px 12px;
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 2px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.btn:hover { background: var(--vscode-button-hoverBackground); }
	details.details { margin-top: 14px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); padding-top: 10px; }
	details.details summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
	details.details ul { margin: 8px 0 0; padding-left: 20px; white-space: pre-wrap; }
	code { font-family: var(--vscode-editor-font-family, monospace); }
`;

const SCRIPT = `
	const vscode = acquireVsCodeApi();
	document.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-action]');
		if (btn) vscode.postMessage({ type: btn.dataset.action });
	});
`;

export function renderDocument(state: ViewState, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tancode</title>
<style>${CSS}</style>
</head>
<body>
${renderBody(state)}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
