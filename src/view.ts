import type { FileExplanation } from './analysis';
import type { ParsedSection } from './model/prompt';
import type { ChatEntry, EntryTag } from './conversation';

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
	| { kind: 'unsupported'; fileName: string; languageId: string; lines?: string }
	| { kind: 'empty'; fileName: string; lines?: string }
	| { kind: 'tooLarge'; fileName: string; bytes: number; limit: number; lines?: string }
	| { kind: 'loading'; fileName: string; languageName: string; model: string; label: string; lines?: string }
	| {
		kind: 'model'; fileName: string; languageName: string; model: string;
		target: 'file' | 'selection'; mode: 'summary' | 'detail' | 'explain' | 'learn';
		text: string; sections?: ParsedSection[]; fromCache: boolean; lines?: string;
		// True while streamed chunks are still arriving: partial text renders
		// (escaped, same as final) with no action buttons — controls return
		// when generation completes, which also prevents double-clicks.
		partial?: boolean;
	}
	| {
		kind: 'quiz'; fileName: string; languageName: string; model: string;
		question: string; lines: string;
	}
	| {
		kind: 'quizResult'; fileName: string; languageName: string; model: string;
		question: string; answer: string; text: string; sections?: ParsedSection[]; lines: string;
	}
	| { kind: 'rules'; fileName: string; languageName: string; explanation: FileExplanation; notice?: string; lines?: string }
	| { kind: 'error'; fileName: string; languageName: string; model: string; message: string; hint: string; fallback?: FileExplanation; lines?: string };

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

function header(fileName: string, languageName: string, lines?: string): string {
	const extra = lines ? ` &middot; ${escapeHtml(lines)}` : '';
	return `<header>
		<h2>${escapeHtml(fileName)}</h2>
		<p class="muted">${escapeHtml(languageName)}${extra}</p>
	</header>`;
}

// One constant per button so message names stay in sync with messages.ts —
// view tests assert every emitted data-action has a dispatcher entry.
const BTN = {
	detail: '<button class="btn" data-action="detail">Explain in more detail</button>',
	summary: '<button class="btn" data-action="summary">Back to summary</button>',
	retry: '<button class="btn" data-action="retry">Retry</button>',
	explain: '<button class="btn" data-action="explain">Explain</button>',
	learn: '<button class="btn" data-action="learn">Learn</button>',
	practice: '<button class="btn" data-action="practice">Test My Understanding</button>',
	newQuestion: '<button class="btn" data-action="new-question">Try another question</button>',
	submitAnswer: '<button class="btn primary" data-action="submit-answer">Submit answer</button>',
	file: '<button class="btn" data-action="file">Back to file explanation</button>',
};

function modelText(text: string): string {
	return escapeHtml(text)
		.split(/\n{2,}/)
		.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
		.join('');
}

function sectionsHtml(sections: ParsedSection[]): string {
	return sections.map((s, i) => `<details class="learn"${i === 0 ? ' open' : ''}>
		<summary>${escapeHtml(s.heading)}</summary>
		<div class="learn-body">${modelText(s.body)}</div>
	</details>`).join('');
}

function modelActions(state: { target: 'file' | 'selection'; mode: string }): string {
	if (state.target === 'file') {
		return `${state.mode === 'summary' ? BTN.detail : BTN.summary} ${BTN.retry}`;
	}
	// Selection target: the three learning actions plus retry and a way back.
	const modeButtons = state.mode === 'explain'
		? `${BTN.learn} ${BTN.practice}`
		: `${BTN.explain} ${BTN.practice}`;
	return `${modeButtons} ${BTN.retry} ${BTN.file}`;
}

export function renderBody(state: ViewState): string {
	switch (state.kind) {
		case 'noEditor':
			return `<div class="empty">
				<h2>No active editor</h2>
				<p>Open a source file to see a Tancode explanation of what it does, or select code and run <code>Tancode: Explain Selected Code</code>.</p>
			</div>`;

		case 'unsupported':
			return `<div class="empty">
				<h2>Unsupported file</h2>
				<p><code>${escapeHtml(state.fileName)}</code>${state.lines ? ` ${escapeHtml(state.lines)}` : ''} uses language <code>${escapeHtml(state.languageId)}</code>, which Tancode does not explain yet.</p>
				<p>Open a supported source file (TypeScript, JavaScript, Python, Java, Go, Rust, and similar) to see an explanation.</p>
			</div>`;

		case 'empty':
			return `<div class="empty">
				<h2>Nothing to explain</h2>
				<p><code>${escapeHtml(state.fileName)}</code>${state.lines ? ` ${escapeHtml(state.lines)}` : ''} is empty.</p>
			</div>`;

		case 'tooLarge':
			return `<div class="empty">
				<h2>Too large to explain</h2>
				<p><code>${escapeHtml(state.fileName)}</code>${state.lines ? ` ${escapeHtml(state.lines)}` : ''} is ${Math.round(state.bytes / 1024)} KB, over the ${Math.round(state.limit / 1024)} KB limit.</p>
				<p>Select a smaller range, or raise the <code>tancode.maxSourceBytes</code> setting.</p>
			</div>`;

		case 'loading':
			return `${header(state.fileName, state.languageName, state.lines)}
			<div class="loading">
				<div class="spinner"></div>
				<p>Asking <code>${escapeHtml(state.model)}</code> via local Ollama for ${escapeHtml(state.label)}&hellip;</p>
			</div>`;

		case 'model': {
			const subject = state.target === 'selection' ? 'this selection' : 'this file';
			const body = state.sections
				? sectionsHtml(state.sections)
				: `<section>
					<h3>${state.mode === 'learn' ? 'Learn' : `What ${subject} does`}</h3>
					${modelText(state.text)}
				</section>`;
			const actions = state.partial
				? '<p class="muted">Generating&hellip;</p>'
				: `<div class="actions">${modelActions(state)}</div>`;
			return `${header(state.fileName, state.languageName, state.lines)}
			<p class="source-badge model">Generated by local model: <code>${escapeHtml(state.model)}</code>${state.fromCache ? ' (cached result)' : ''}</p>
			${body}
			${actions}
			<p class="muted foot">Generated locally on your machine — the code only went to ${escapeHtml(state.model)} via Ollama at your configured local endpoint. Verify before relying on it.</p>`;
		}

		case 'quiz':
			return `${header(state.fileName, state.languageName, state.lines)}
			<p class="source-badge model">Practice question — generated by local model: <code>${escapeHtml(state.model)}</code></p>
			<section>
				<h3>Test my understanding</h3>
				${modelText(state.question)}
			</section>
			<label class="answer-label" for="tancode-answer">Your answer</label>
			<textarea id="tancode-answer" rows="4" placeholder="Type what you think the code does or what the result would be&hellip;"></textarea>
			<div class="actions">${BTN.submitAnswer} ${BTN.newQuestion} ${BTN.explain} ${BTN.file}</div>
			<p class="muted foot">This is for learning, not grading. The reference answer appears only after you submit.</p>`;

		case 'quizResult': {
			const body = state.sections ? sectionsHtml(state.sections) : modelText(state.text);
			return `${header(state.fileName, state.languageName, state.lines)}
			<p class="source-badge model">Feedback — generated by local model: <code>${escapeHtml(state.model)}</code></p>
			<section>
				<h3>Question</h3>
				${modelText(state.question)}
				<h3>Your answer</h3>
				${modelText(state.answer)}
				<h3>Assessment</h3>
				${body}
			</section>
			<div class="actions">${BTN.newQuestion} ${BTN.explain} ${BTN.learn} ${BTN.file}</div>
			<p class="muted foot">Generated locally on your machine. Verify before relying on it.</p>`;
		}

		case 'rules': {
			const notice = state.notice ? `<p class="notice">${escapeHtml(state.notice)}</p>` : '';
			return `${header(state.fileName, state.languageName, state.lines)}
			${notice}
			<p class="source-badge rules">Rule-based fallback — the model did not generate this</p>
			${rulesBody(state.explanation)}`;
		}

		case 'error': {
			const fallback = state.fallback
				? `<p class="source-badge rules">Rule-based fallback — the model did not generate this</p>${rulesBody(state.fallback)}`
				: '';
			return `${header(state.fileName, state.languageName, state.lines)}
			<div class="error">
				<h3>Explanation failed</h3>
				<p>${escapeHtml(state.message)}</p>
				<p class="muted">${escapeHtml(state.hint)}</p>
				<div class="actions">${BTN.retry}${state.lines ? ` ${BTN.file}` : ''}</div>
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
	.source-badge {
		display: inline-block; margin-top: 6px; padding: 3px 8px; border-radius: 3px;
		font-size: 0.85em; font-weight: 600;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
	}
	.source-badge.rules { background: var(--vscode-descriptionForeground); }
	.notice { color: var(--vscode-editorWarning-foreground, #cca700); }
	.error {
		margin-top: 16px; padding: 10px 14px;
		border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
		background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.08));
	}
	.error h3 { margin-top: 0; color: var(--vscode-editorError-foreground, #f14c4c); }
	.actions { margin-top: 14px; }
	.btn {
		font: inherit; cursor: pointer; margin-right: 8px; margin-bottom: 4px; padding: 4px 12px;
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 2px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.btn:hover { background: var(--vscode-button-hoverBackground); }
	.btn.primary { font-weight: 600; }
	details.details { margin-top: 14px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); padding-top: 10px; }
	details.details summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
	details.details ul { margin: 8px 0 0; padding-left: 20px; white-space: pre-wrap; }
	details.learn { margin: 8px 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 3px; padding: 6px 10px; }
	details.learn summary { cursor: pointer; font-weight: 600; }
	details.learn .learn-body { margin-top: 6px; }
	// --- Conversation feed ---
	.toolbar {
		display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
		padding-bottom: 10px; margin-bottom: 10px;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
	}
	.toolbar h2 { margin: 0; flex: 0 0 auto; }
	.toolbar .watching { flex: 1 1 auto; }
	.feed { margin: 10px 0; }
	.msg { margin: 8px 0; }
	.msg.user {
		margin-left: 18%; padding: 8px 12px; border-radius: 6px;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.5));
		white-space: pre-wrap;
	}
	.msg.user p { margin: 0; }
	.feed-card {
		margin: 8px 0; padding: 10px 12px; border-radius: 6px;
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
		background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08));
	}
	.tag {
		display: inline-block; padding: 1px 7px; margin-bottom: 4px;
		font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
		border-radius: 3px; color: var(--vscode-badge-foreground);
		background: var(--vscode-badge-background);
	}
	.tag.insight { background: var(--vscode-charts-blue, #3794ff); }
	.tag.error { background: var(--vscode-editorError-foreground, #f14c4c); }
	.tag.question { background: var(--vscode-charts-purple, #b180d7); }
	.tag.answer { background: var(--vscode-charts-green, #89d185); color: #1f1f1f; }
	.dismiss {
		float: right; cursor: pointer; border: none; background: none;
		color: var(--vscode-descriptionForeground); font-size: 1em; padding: 0 2px;
	}
	.dismiss:hover { color: var(--vscode-foreground); }
	.composer {
		position: sticky; bottom: 0; margin-top: 12px; padding-top: 8px;
		border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
		background: var(--vscode-panel-background, transparent);
	}
	textarea#tancode-chat {
		width: 100%; box-sizing: border-box; padding: 6px 8px; min-height: 34px;
		font: inherit; resize: vertical;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.5));
		border-radius: 2px;
	}
	textarea#tancode-chat:focus { outline: 1px solid var(--vscode-focusBorder); }
	.answer-label { display: block; margin-top: 14px; font-weight: 600; }
	textarea#tancode-answer {
		width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px;
		font: inherit; resize: vertical;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.5));
		border-radius: 2px;
	}
	textarea#tancode-answer:focus { outline: 1px solid var(--vscode-focusBorder); }
	code { font-family: var(--vscode-editor-font-family, monospace); }
`;

const SCRIPT = `
	const vscode = acquireVsCodeApi();
	const sendChat = () => {
		const ta = document.getElementById('tancode-chat');
		if (ta && ta.value.trim().length > 0) {
			vscode.postMessage({ type: 'chat', text: ta.value });
			ta.value = '';
		}
	};
	document.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		const action = btn.dataset.action;
		if (action === 'submit-answer') {
			const ta = document.getElementById('tancode-answer');
			vscode.postMessage({ type: action, text: ta ? ta.value : '' });
		} else if (action === 'send-chat') {
			sendChat();
		} else if (action === 'dismiss') {
			vscode.postMessage({ type: 'dismiss', id: Number(btn.dataset.id) });
		} else {
			vscode.postMessage({ type: action });
		}
	});
	document.addEventListener('keydown', (e) => {
		const ta = document.getElementById('tancode-chat');
		if (ta && e.target === ta && e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendChat();
		}
	});
	window.scrollTo(0, document.body.scrollHeight);
`;

export function renderDocument(state: ViewState, nonce: string): string {
	return renderPage(renderBody(state), nonce);
}

function renderPage(body: string, nonce: string): string {
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
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

// --- Conversation view ---

const TAG_LABEL: Record<EntryTag, string> = {
	insight: 'Learning moment',
	error: 'Error',
	question: 'Question for you',
	answer: 'Feedback',
	info: 'Note',
};

export interface ConversationView {
	context?: ViewState;          // pinned card: the current explanation state
	entries: ChatEntry[];          // chronological feed below the context card
	watching?: string;             // e.g. 'app.ts' or 'app.ts · lines 3–9'
	model: string;
	paused: boolean;               // proactive assistance paused
	generating: boolean;           // a streamed response is in flight
	proactiveCount: number;
	proactiveMax: number;
}

function entryHtml(entry: ChatEntry): string {
	if (entry.kind === 'text') {
		return `<div class="msg user"><p>${escapeHtml(entry.text)}</p></div>`;
	}
	if (entry.kind === 'state') {
		return `<div class="feed-card">${entry.tag ? `<span class="tag ${entry.tag}">${TAG_LABEL[entry.tag]}</span>` : ''}${renderBody(entry.state)}</div>`;
	}
	if (entry.dismissed) {
		return '';
	}
	const dismiss = entry.dismissible
		? `<button class="dismiss" data-action="dismiss" data-id="${entry.id}" title="Dismiss" aria-label="Dismiss">&times;</button>`
		: '';
	const partial = entry.partial ? ' <span class="muted">&hellip;</span>' : '';
	const model = entry.model ? ` <span class="muted">\u00B7 ${escapeHtml(entry.model)}</span>` : '';
	return `<div class="feed-card">${dismiss}<span class="tag ${entry.tag}">${TAG_LABEL[entry.tag]}</span>${model}<div>${modelText(entry.text)}</div>${partial}</div>`;
}

export function renderConversation(v: ConversationView): string {
	const toggleBtn = v.paused
		? '<button class="btn" data-action="resume">Resume proactive</button>'
		: '<button class="btn" data-action="pause">Pause proactive</button>';
	const stopBtn = v.generating
		? '<button class="btn" data-action="stop">Stop</button>'
		: '';
	const pausedNote = v.paused ? ' \u00B7 proactive paused' : '';
	const feed = v.entries.map(entryHtml).join('');
	const context = v.context ? `<div class="feed-card">${renderBody(v.context)}</div>` : '';
	return `
	<div class="toolbar">
		<h2>Tancode</h2>
		<span class="watching muted">${v.watching ? `Watching ${escapeHtml(v.watching)}` : 'No file being watched'}${pausedNote}</span>
		${stopBtn}${toggleBtn}<button class="btn" data-action="clear">Clear</button>
	</div>
	${context}
	<div class="feed">${feed}</div>
	<div class="composer">
		<textarea id="tancode-chat" rows="2" placeholder="Ask about this code, answer a question, or say &quot;pause proactive&quot;&hellip;"></textarea>
		<div class="actions">
			<button class="btn primary" data-action="send-chat">Send</button>
			<span class="muted">Generated by ${escapeHtml(v.model)} locally &middot; proactive ${v.proactiveCount}/${v.proactiveMax} &middot; answers can be wrong — verify</span>
		</div>
	</div>`;
}

export function renderConversationDocument(v: ConversationView, nonce: string): string {
	return renderPage(renderConversation(v), nonce);
}
