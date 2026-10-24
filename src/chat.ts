// Natural-language router for the chat input (vscode-free). Classifies the
// user's typed message into an intent the panel can act on. Deliberately
// conservative: anything unrecognized is a direct question.

export type ChatIntent =
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'why' }
	| { type: 'wrap-up' }
	| { type: 'clear' }
	| { type: 'quiz-answer' }
	| { type: 'direct' };

// Generic stop words only pause when they clearly target proactive
// messages — "stop teaching and just answer my question" is a request for a
// direct answer, not a settings change. A bare "pause" also pauses.
const PAUSE_RE = /\bpause\b|\b(stop|disable|mute|quiet)\b[^.?!]*\bproactiv/i;
const RESUME_RE = /\b(resume|start|enable|unpause|restart)\b[^.?!]*\b(proactiv|assistant|teaching|insights|notifications?)/i;
const WHY_RE = /why (are you|did you|do you keep) (telling|showing|saying|explaining|messaging)/i;
// Explicit finish signals only — per spec, never infer a feature is done
// from saves alone.
const WRAPUP_RE = /\b(wrap ?up|recap|summari[sz]e (the )?(project|session|what (i|we) built)|i'?m done|i'?m finished|we'?re done)\b/i;
const CLEAR_RE = /\b(clear|reset|empty)\b[^.?!]*\b(chat|conversation|history)\b/i;

export function routeMessage(text: string, hasPendingQuestion: boolean): ChatIntent {
	const t = text.trim();
	if (PAUSE_RE.test(t)) {
		return { type: 'pause' };
	}
	if (RESUME_RE.test(t)) {
		return { type: 'resume' };
	}
	if (WHY_RE.test(t)) {
		return { type: 'why' };
	}
	if (CLEAR_RE.test(t)) {
		return { type: 'clear' };
	}
	if (WRAPUP_RE.test(t)) {
		return { type: 'wrap-up' };
	}
	if (hasPendingQuestion) {
		return { type: 'quiz-answer' };
	}
	return { type: 'direct' };
}
