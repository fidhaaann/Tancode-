// Proactive-policy module (vscode-free so it is unit-testable): decides when
// an assistant-initiated message is allowed, dedupes repeats, and picks the
// most useful diagnostic to explain. The panel owns the timers; this module
// owns the rules.

export function hashContent(text: string): string {
	// FNV-1a — stable content hash for dedupe keys.
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

export interface DiagLike {
	severity: number; // vscode.DiagnosticSeverity: 0=Error,1=Warning,2=Info,3=Hint
	message: string;
	line: number;
	code?: string | number;
}

export function diagKey(uri: string, d: DiagLike): string {
	const code = d.code === undefined || d.code === '' ? '' : String(d.code);
	return hashContent(`diag|${uri}|${d.line}|${code}|${d.message}`);
}

// Pick the single most useful diagnostic to explain: errors first, then
// warnings; anything lower priority is noise for a mentor.
export function pickDiagnostic(diags: DiagLike[], errorsOnly: boolean): DiagLike | undefined {
	const maxSeverity = errorsOnly ? 0 : 1;
	return diags
		.filter(d => d.severity <= maxSeverity)
		.sort((a, b) => a.severity - b.severity || a.line - b.line)[0];
}

export type ProactiveVerdict = 'allow' | 'seen' | 'cooldown' | 'limit';

// Budget gate for assistant-initiated messages: dedupe by key, rate-limit by
// cooldown, and cap the total per session. check() does not mutate — call
// commit() only when a message actually posts, so a blocked or failed
// insight can still appear later.
export class ProactiveBudget {
	// -Infinity = no post yet, so the first message is always allowed.
	private lastPost = Number.NEGATIVE_INFINITY;
	private count = 0;
	private readonly seen = new Set<string>();

	constructor(
		private readonly cooldownMs: number,
		private readonly maxPerSession: number,
		private readonly now: () => number = Date.now,
	) {}

	check(key: string): ProactiveVerdict {
		if (this.seen.has(key)) {
			return 'seen';
		}
		if (this.count >= this.maxPerSession) {
			return 'limit';
		}
		if (this.now() - this.lastPost < this.cooldownMs) {
			return 'cooldown';
		}
		return 'allow';
	}

	commit(key: string): void {
		this.seen.add(key);
		this.lastPost = this.now();
		this.count++;
	}

	get messagesPosted(): number {
		return this.count;
	}

	get cooldownRemainingMs(): number {
		return Math.max(0, this.cooldownMs - (this.now() - this.lastPost));
	}
}
