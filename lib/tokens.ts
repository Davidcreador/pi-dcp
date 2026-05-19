/**
 * Token counting backed by @anthropic-ai/tokenizer.
 *
 * Uses the official Anthropic tokenizer for accurate token counts on Claude
 * models. Falls back to the ~4-chars-per-token heuristic if the tokenizer
 * throws (malformed input, non-text content, etc.).
 */
import * as _anthropicTokenizer from "@anthropic-ai/tokenizer";

const countFn: ((text: string) => number) | undefined =
	(_anthropicTokenizer as any).countTokens ??
	(_anthropicTokenizer as any).default?.countTokens;

function charFallback(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Count tokens in a string using the Anthropic tokenizer,
 * falling back to the char-count heuristic on error.
 */
export function countTokens(text: string): number {
	if (!text) return 0;
	try {
		if (countFn) return countFn(text);
	} catch {
		// fall through
	}
	return charFallback(text);
}

/**
 * Estimate tokens for a batch of texts. Joining is close enough for
 * budgeting and avoids N separate tokenizer calls.
 */
export function estimateTokensBatch(texts: string[]): number {
	if (texts.length === 0) return 0;
	return countTokens(texts.join(" "));
}

/** Alias used by messages.ts and strategies. */
export function approxTokens(text: string): number {
	return countTokens(text);
}
