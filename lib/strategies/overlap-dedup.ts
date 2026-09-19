/**
 * Overlap dedup strategy.
 *
 * Exact dedup removes identical repeated calls; this strategy removes a read
 * whose requested line range is FULLY CONTAINED in a newer read of the same
 * file — the newer result already carries everything the older one showed,
 * so omitting it is lossless. Bash read-alikes (cat/head/tail/sed -n 'a,bp')
 * count as reads of their path.
 *
 * Overlap alone is NOT enough — containment is what makes it lossless.
 * Tail ranges (negative sentinel start) only dedup against identical tails.
 *
 * The pipeline passes us a working array of CLONED messages (see pipeline.ts
 * for cloning policy). We mutate that array in place; never the originals.
 */
import { basename, resolve } from "node:path";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	isAlreadyPlaceholder,
	isAssistant,
	isToolResult,
	placeholderToolResult,
	toolCallsOf,
} from "../messages.ts";
import type { SessionState } from "../state.ts";

export interface OverlapDedupResult {
	prunedCount: number;
	tokensSaved: number;
}

export interface ReadRange {
	path: string;
	/** First line covered. Negative = tail sentinel: -N means the last N lines. */
	start: number;
	/** Last line covered; Infinity = through EOF. Negative = tail sentinel end (-1). */
	end: number;
}

/** Path tokens carrying whitespace or glob characters are never treated as a single file. */
const SAFE_PATH = /^[^\s*?\[]+$/;

function fileRange(rawPath: string, start: number, end: number): ReadRange | undefined {
	if (!SAFE_PATH.test(rawPath)) return;
	return { path: resolve(rawPath), start, end };
}

/** Reduce a tool call to the file line range it reads; undefined when it is not a simple read. */
export function readRange(call: { name: string; arguments: Record<string, unknown> }): ReadRange | undefined {
	const args = call.arguments;
	if (call.name === "read") {
		if (typeof args.path !== "string") return;
		const start = typeof args.offset === "number" ? args.offset : 1;
		const end = typeof args.limit === "number" ? start + args.limit - 1 : Infinity;
		return fileRange(args.path, start, end);
	}
	if (call.name !== "bash" || typeof args.command !== "string") return;
	const command = args.command.trim();
	if (/[|;&>]/.test(command)) return;
	let m: RegExpMatchArray | null;
	if ((m = command.match(/^cat\s+(\S+)$/))) return fileRange(m[1], 1, Infinity);
	if ((m = command.match(/^head\s+-n\s+(\d+)\s+(\S+)$/)) || (m = command.match(/^head\s+-(\d+)\s+(\S+)$/)))
		return fileRange(m[2], 1, Number(m[1]));
	if ((m = command.match(/^tail\s+-n\s+(\d+)\s+(\S+)$/))) return fileRange(m[2], -Number(m[1]), -1);
	if ((m = command.match(/^sed\s+-n\s+["']?(\d+),(\d+)p["']?\s+(\S+)$/)))
		return fileRange(m[3], Number(m[1]), Number(m[2]));
}

/** True when `outer` fully covers `inner`. Tail ranges only match identical tails. */
function contains(outer: ReadRange, inner: ReadRange): boolean {
	if (inner.start < 0) return outer.start === inner.start && outer.end === inner.end;
	return outer.start <= inner.start && outer.end >= inner.end;
}

export function applyOverlapDedup(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protectedByTurn: Set<string> = new Set(),
): OverlapDedupResult {
	if (!config.strategies.overlapDedup.enabled) {
		return { prunedCount: 0, tokensSaved: 0 };
	}
	const protectedTools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.strategies.overlapDedup.protectedTools,
		...config.compress.protectedTools,
	]);

	// 1. Map every toolCallId -> read range. Walking the assistant messages is
	//    the only way to recover a call's *arguments* — the tool result alone
	//    only has its name + output, not the input that produced it.
	const callIdToRead = new Map<string, ReadRange>();
	for (const m of messages) {
		if (!isAssistant(m)) continue;
		for (const call of toolCallsOf(m)) {
			if (protectedTools.has(call.name)) continue;
			const range = readRange(call);
			if (range) callIdToRead.set(call.id, range);
		}
	}
	if (!callIdToRead.size) return { prunedCount: 0, tokensSaved: 0 };

	// 2. Walk results newest -> oldest. Keep a read unless an already-kept
	//    newer range fully contains it. Idempotent via state.overlapPrunedCallIds.
	const kept = new Map<string, ReadRange[]>();
	let prunedCount = 0;
	let tokensSaved = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isToolResult(m)) continue;
		if (m.isError) continue;
		if (protectedTools.has(m.toolName)) continue;
		if (protectedByTurn.has(m.toolCallId)) continue;
		if (isAlreadyPlaceholder(m)) continue;
		const range = callIdToRead.get(m.toolCallId);
		if (!range) continue;
		const covering = kept.get(range.path) ?? [];
		const keeper = covering.find(k => contains(k, range));
		if (!keeper) {
			covering.push(range);
			kept.set(range.path, covering);
			continue;
		}
		const end = keeper.end === Infinity ? "end" : keeper.end;
		const saved = placeholderToolResult(m, `superseded by newer read of ${basename(range.path)} covering lines ${keeper.start}-${end}`);
		// Even if placeholderToolResult already returned 0 (idempotent re-run),
		// counting once per call-id keeps stats stable.
		if (!state.overlapPrunedCallIds.has(m.toolCallId)) {
			state.overlapPrunedCallIds.add(m.toolCallId);
			prunedCount++;
			tokensSaved += saved;
		}
	}

	state.stats.overlapPruned += prunedCount;
	state.stats.tokensSaved += tokensSaved;
	return { prunedCount, tokensSaved };
}
