/**
 * Token counting utilities.
 *
 * Try the official Anthropic tokenizer first. That gives exact counts for
 * Claude models — the only models currently deployed in pi. Fall back to
 * the classic ~4-chars-per-token heuristic when the tokenizer is unavailable
 * (npm not installed, offline, or non-Anthropic model).
 *
 * Kept in a dedicated module so pipeline.ts, strategies, and nudges.ts all
 * use the same path and the fallback is only written in one place.
 */

type CountFn = (text: string) => number;

let _countFn: CountFn | null = null;
let _tried = false;

function getCountFn(): CountFn {
	if (_countFn) return _countFn;
	if (_tried) return charFallback;
	_tried = true;

	// Dynamic import guard — @anthropic-ai/tokenizer is an optional dep.
	// We try to load it synchronously via require() first (CJS compat shim);
	// if that fails we stay with charFallback for the rest of this session.
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("@anthropic-ai/tokenizer");
		const fn: CountFn | undefined =
			typeof mod?.countTokens === "function"
				? mod.countTokens
				: typeof mod?.default?.countTokens === "function"
					? mod.default.countTokens
					: undefined;
		if (fn) {
			_countFn = fn;
			return fn;
		}
	} catch {
		// Not installed — fall through to charFallback.
	}

	return charFallback;
}

function charFallback(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Count tokens in a string. Uses the Anthropic tokenizer when available,
 * otherwise falls back to the ~4-chars-per-token heuristic.
 */
export function countTokens(text: string): number {
	if (!text) return 0;
	try {
		return getCountFn()(text);
	} catch {
		return charFallback(text);
	}
}

/**
 * Estimate tokens for a batch of texts. Joining with a space is close
 * enough for budgeting purposes (avoids N separate tokenizer calls).
 */
export function estimateTokensBatch(texts: string[]): number {
	if (texts.length === 0) return 0;
	return countTokens(texts.join(" "));
}

/**
 * Approximate token count for a ToolResultMessage's content payload.
 * Kept in messages.ts for interface reasons; real counting goes through here.
 */
export function approxTokens(text: string): number {
	return countTokens(text);
}
