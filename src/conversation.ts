import type { ViewState } from './view';

// Conversation feed entries. The panel keeps two zones: a pinned "context"
// card (the current file/selection explanation — same ViewState as before)
// and this chronological feed of proactive insights, user messages and
// assistant replies.
export type EntryTag = 'insight' | 'error' | 'question' | 'answer' | 'info';

export type ChatEntry =
	| { id: number; role: 'user'; kind: 'text'; text: string }
	| { id: number; role: 'assistant'; kind: 'message'; tag: EntryTag; text: string; model?: string; partial?: boolean; dismissed?: boolean; dismissible?: boolean }
	| { id: number; role: 'assistant'; kind: 'state'; tag?: EntryTag; state: ViewState };

export function userMessage(id: number, text: string): ChatEntry {
	return { id, role: 'user', kind: 'text', text };
}

export function assistantMessage(id: number, tag: EntryTag, text: string, extra: Partial<Extract<ChatEntry, { kind: 'message' }>> = {}): ChatEntry {
	return { id, role: 'assistant', kind: 'message', tag, text, ...extra };
}

export function stateEntry(id: number, state: ViewState, tag?: EntryTag): ChatEntry {
	return { id, role: 'assistant', kind: 'state', tag, state };
}

// Bounded short-term memory for prompts — in-memory only, never persisted.
export interface HistoryTurn {
	role: 'user' | 'assistant';
	text: string;
}

const MAX_HISTORY_TURNS = 12;
const MAX_TURN_CHARS = 600;

export function pushTurn(history: HistoryTurn[], turn: HistoryTurn): void {
	history.push({ role: turn.role, text: turn.text.slice(0, MAX_TURN_CHARS) });
	while (history.length > MAX_HISTORY_TURNS) {
		history.shift();
	}
}
