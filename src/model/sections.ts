// Sectioning for large-file analysis (vscode-free, unit-testable).
//
// The model has a real context budget; a file larger than it must not be
// silently truncated or rejected — it is split into meaningful sections and
// analyzed sequentially (see ExplanationService.explainSectioned).

// Top-level-ish declaration boundaries: prefer splitting a section BEFORE a
// line that starts a new class/function/etc so each chunk carries semantic
// meaning. Fallback is a plain line-boundary split.
const DECL_BOUNDARY = /^(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|static\s+|async\s+)*(?:class|interface|enum|namespace|module|struct|trait|impl|function|def|type|fn|const|let|var)\s/;

export interface FileSection {
	index: number;
	/** 1-based inclusive line range in the original document. */
	startLine: number;
	endLine: number;
	text: string;
}

// Split text into sections of roughly <= maxChars each, preferring to break
// just before a declaration line (or at a blank line) so sections align with
// code structure. Never drops content — every line lands in exactly one
// section.
export function splitSections(text: string, maxChars: number): FileSection[] {
	if (text.length === 0) {
		return [];
	}
	const lines = text.split('\n');
	const sections: FileSection[] = [];
	let start = 0;
	let size = 0;
	// Last boundary we saw since `start` — a good cut point if we overflow.
	let lastBoundary = -1;

	const flush = (endExclusive: number): void => {
		if (endExclusive <= start) {
			return;
		}
		const slice = lines.slice(start, endExclusive);
		sections.push({
			index: sections.length,
			startLine: start + 1,
			endLine: endExclusive,
			text: slice.join('\n'),
		});
		start = endExclusive;
		size = 0;
		lastBoundary = -1;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i > start && size > maxChars * 0.5 && (DECL_BOUNDARY.test(line) || line.trim() === '')) {
			lastBoundary = i;
		}
		size += line.length + 1;
		if (size > maxChars) {
			// Cut at the last good boundary, else hard cut at this line — but
			// always advance at least one line, or a single line bigger than
			// the budget would loop forever.
			flush(lastBoundary > start ? lastBoundary : Math.max(i, start + 1));
			i = start - 1; // reprocess from the new section's first line
			continue;
		}
	}
	flush(lines.length);
	return sections;
}

// Rough declaration inventory for a section — feeds the combine prompt's
// symbol map so cross-section relationships survive. Not a parser: it lists
// plausible declarations, which is all the prompt needs.
export function declarationsOf(text: string): string[] {
	const out: string[] = [];
	const re = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|abstract\s+|static\s+|async\s+)*(?:class|interface|enum|struct|trait|function|type|fn|def)\s+([A-Za-z_][\w]*)/;
	for (const line of text.split('\n')) {
		const m = re.exec(line);
		if (m && out.length < 40) {
			out.push(m[1]);
		}
	}
	return out;
}
