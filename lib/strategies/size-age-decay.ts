/**
 * Size×age decay strategy.
 *
 * Large tool outputs that are old enough lose their verbatim body but keep a
 * head+tail excerpt, so the model retains the shape of the data and can
 * `recall` the full result if it turns out to matter. Age is measured in
 * assistant messages positioned AFTER the result — step-based, not
 * user-turn-based, so a single 200-tool-call turn still decays.
 *
 * Excerpts carry real content: the marker intentionally does NOT match
 * isAlreadyPlaceholder, so dedup and overlap logic still see the result.
 * Errored results are eligible — purgeErrors only strips call arguments,
 * leaving the bulky error output behind.
 *
 * The pipeline passes us a working array of CLONED messages (see pipeline.ts
 * for cloning policy). We mutate that array in place; never the originals.
 */
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	EXCERPT_MARKER_PREFIX,
	isAlreadyPlaceholder,
	isAssistant,
	isExcerpt,
	isToolResult,
	toolResultChars,
	type ToolResultMessage,
} from "../messages.ts";
import type { SessionState } from "../state.ts";

export interface SizeAgeDecayResult {
	decayedCount: number;
	tokensSaved: number;
}

function excerptMarker(m: ToolResultMessage, shown: string, total: string, omittedTokens: number): string {
	return `\n${EXCERPT_MARKER_PREFIX} showing ${shown} of ${total}, ~${omittedTokens} tokens omitted — recall toolCallId=${m.toolCallId} restores the full output]\n`;
}

/** Build the smallest sufficient excerpt, or undefined when nothing shrinks enough. */
function excerpt(m: ToolResultMessage, headLines: number, tailLines: number): string | undefined {
	const text = m.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
	const before = toolResultChars(m);
	const lines = text.split("\n");
	if (lines.length > headLines + tailLines) {
		const middle = lines.slice(headLines, lines.length - tailLines).join("\n");
		const candidate = lines.slice(0, headLines).join("\n")
			+ excerptMarker(m, `${headLines}+${tailLines}`, `${lines.length} lines`, Math.ceil(middle.length / 4))
			+ lines.slice(lines.length - tailLines).join("\n");
		if (candidate.length <= before * 0.6) return candidate;
	}
	// Long-line / minified content: a line excerpt can't shrink enough, so cut by characters.
	if (text.length > 4000) {
		const middle = text.slice(3000, text.length - 1000);
		const candidate = text.slice(0, 3000)
			+ excerptMarker(m, "3000+1000", `${text.length} chars`, Math.ceil(middle.length / 4))
			+ text.slice(-1000);
		if (candidate.length <= before * 0.6) return candidate;
	}
}

export function applySizeAgeDecay(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protectedByTurn: Set<string> = new Set(),
): SizeAgeDecayResult {
	const opts = config.strategies.sizeAgeDecay;
	if (!opts.enabled) {
		return { decayedCount: 0, tokensSaved: 0 };
	}
	const protectedTools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...opts.protectedTools,
		...config.compress.protectedTools,
	]);

	// Walk newest -> oldest, counting assistant messages seen so far; a
	// result's age is that count when we reach it.
	let age = 0;
	let decayedCount = 0;
	let tokensSaved = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isAssistant(m)) {
			age++;
			continue;
		}
		if (!isToolResult(m)) continue;
		if (age < opts.minAgeSteps) continue;
		if (protectedTools.has(m.toolName)) continue;
		if (protectedByTurn.has(m.toolCallId)) continue;
		if (isAlreadyPlaceholder(m) || isExcerpt(m)) continue;
		if (toolResultChars(m) / 4 < opts.minTokens) continue;
		const before = toolResultChars(m);
		const text = excerpt(m, opts.headLines, opts.tailLines);
		if (text === undefined) continue;
		m.content = [{ type: "text", text }];
		m.details = undefined;
		if (!state.decayedCallIds.has(m.toolCallId)) {
			state.decayedCallIds.add(m.toolCallId);
			decayedCount++;
			tokensSaved += Math.max(0, Math.ceil((before - toolResultChars(m)) / 4));
		}
	}

	state.stats.decayed += decayedCount;
	state.stats.tokensSaved += tokensSaved;
	return { decayedCount, tokensSaved };
}
