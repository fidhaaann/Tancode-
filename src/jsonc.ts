// Tolerant JSONC handling (vscode-free, unit-testable).
//
// The VS Code JSON language service already reports real syntax diagnostics —
// this module only gives Tancode a *best-effort* structured view for prompts
// and rules-based summaries. It is deliberately conservative: comments and
// trailing commas are stripped before JSON.parse, and a parse failure is a
// failure — we never pretend incomplete or invalid JSON is valid.

export interface JsoncResult {
	ok: boolean;
	/** Parsed value when ok. */
	value?: unknown;
	/** Human-readable reason when not ok. */
	error?: string;
}

// Strips // and /* */ comments and trailing commas without touching string
// literals — the classic JSONC pre-parser, kept tiny on purpose.
function stripJsonc(text: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1];
		if (inString) {
			out += c;
			if (escaped) {
				escaped = false;
			} else if (c === '\\') {
				escaped = true;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			out += '\n';
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				i++;
			}
			i++; // skip the closing /
			continue;
		}
		out += c;
	}
	// Trailing commas: ",\s*}" or ",\s*]" → drop the comma. Safe post-strip
	// because no comment commas remain and strings are untouched inside them.
	return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(text: string): JsoncResult {
	if (text.trim().length === 0) {
		return { ok: false, error: 'empty file' };
	}
	try {
		return { ok: true, value: JSON.parse(stripJsonc(text)) };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

// How deep a JSON value nests — feeds "deeply nested" summaries so the panel
// can talk about structure without sending the whole document to the model.
function depthOf(value: unknown, depth = 0): number {
	if (Array.isArray(value)) {
		return value.length === 0 ? depth : Math.max(...value.map(v => depthOf(v, depth + 1)));
	}
	if (value !== null && typeof value === 'object') {
		const vals = Object.values(value);
		return vals.length === 0 ? depth : Math.max(...vals.map(v => depthOf(v, depth + 1)));
	}
	return depth;
}

export interface JsonSummary {
	ok: boolean;
	error?: string;
	/** e.g. 'object' | 'array' | 'string' */
	kind?: string;
	topLevelKeys?: string[];
	maxDepth?: number;
	/** Bounded pretty-printed excerpt for prompts — never the full file. */
	excerpt?: string;
}

const MAX_TOP_KEYS = 30;
const MAX_EXCERPT_CHARS = 1600;
const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|apikey|auth|credential|private[-_]?key|access[-_]?key|session|bearer)/i;
const REDACTED = '"[redacted]"';

// Redact values whose KEY looks secret-bearing. Applied to anything of ours
// that goes into a prompt — project facts and JSON excerpts alike.
export function redactSecrets(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactSecrets);
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = SENSITIVE_KEY.test(k) ? JSON.parse(REDACTED) : redactSecrets(v);
		}
		return out;
	}
	return value;
}

// A structural summary of a JSON document for prompts and the rules fallback.
export function summarizeJson(text: string): JsonSummary {
	const parsed = parseJsonc(text);
	if (!parsed.ok) {
		return { ok: false, error: parsed.error };
	}
	const v = parsed.value;
	const summary: JsonSummary = {
		ok: true,
		kind: Array.isArray(v) ? 'array' : typeof v,
		maxDepth: depthOf(v),
	};
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
		const keys = Object.keys(v);
		summary.topLevelKeys = keys.slice(0, MAX_TOP_KEYS);
		if (keys.length > MAX_TOP_KEYS) {
			summary.topLevelKeys.push(`…(+${keys.length - MAX_TOP_KEYS} more)`);
		}
	}
	try {
		// Excerpt goes through redaction BEFORE stringifying.
		summary.excerpt = JSON.stringify(redactSecrets(v), null, 2).slice(0, MAX_EXCERPT_CHARS);
	} catch {
		summary.excerpt = undefined;
	}
	return summary;
}
