// Webview message contract — kept in a vscode-free module so the dispatch
// table is directly unit-testable. The webview script posts
// { type: <one of these> } (plus a `text` payload for submit-answer); the
// extension maps each type to exactly one handler here.
export type WebviewMessageType =
	| 'detail'
	| 'summary'
	| 'retry'
	| 'explain'
	| 'learn'
	| 'practice'
	| 'new-question'
	| 'submit-answer'
	| 'file';

export interface WebviewActions {
	detail(): void;
	summary(): void;
	retry(): void;
	explain(): void;
	learn(): void;
	practice(): void;
	newQuestion(): void;
	submitAnswer(text: string): void;
	backToFile(): void;
}

export const WEBVIEW_MESSAGE_TYPES: readonly WebviewMessageType[] = [
	'detail', 'summary', 'retry', 'explain', 'learn', 'practice',
	'new-question', 'submit-answer', 'file',
];

// Returns true when the message was recognized and dispatched. Anything
// malformed — non-object, unknown type, or a submit without a string
// payload — is ignored so a bad message can never throw inside the
// extension host.
export function dispatchWebviewMessage(message: unknown, actions: WebviewActions): boolean {
	if (typeof message !== 'object' || message === null) {
		return false;
	}
	const type = (message as { type?: unknown }).type;
	switch (type) {
		case 'detail':
			actions.detail();
			return true;
		case 'summary':
			actions.summary();
			return true;
		case 'retry':
			actions.retry();
			return true;
		case 'explain':
			actions.explain();
			return true;
		case 'learn':
			actions.learn();
			return true;
		case 'practice':
			actions.practice();
			return true;
		case 'new-question':
			actions.newQuestion();
			return true;
		case 'submit-answer': {
			const text = (message as { text?: unknown }).text;
			if (typeof text !== 'string') {
				return false;
			}
			actions.submitAnswer(text);
			return true;
		}
		case 'file':
			actions.backToFile();
			return true;
		default:
			return false;
	}
}
