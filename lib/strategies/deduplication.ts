/**
 * Deduplication strategy.
 *
 * Walks tool results newest-first. When we see a (toolName + canonical-args)
 * signature we have already kept, we replace the older tool result's content
 * with a placeholder. Newest result for each signature is preserved verbatim.
 *
 * Protected tools are NEVER deduplicated — repeated writes, todo updates,
 * compress invocations etc. are real changes, not redundant lookups.
 *
 * The pipeline passes us a working array of CLONED messages (see pipeline.ts
 * for cloning policy). We mutate that array in place; never the originals.
 */
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	isAssistant,
	isToolResult,
	placeholderToolResult,
	toolCallKey,
	toolCallsOf,
} from "../messages.ts";
import type { SessionState } from "../state.ts";

export interface DedupResult {
	prunedCount: number;
	tokensSaved: number;
}

export function applyDeduplication(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protectedByTurn: Set<string> = new Set(),
): DedupResult {
	if (!config.strategies.deduplication.enabled) {
		return { prunedCount: 0, tokensSaved: 0 };
	}
	const protectedTools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.strategies.deduplication.protectedTools,
		...config.compress.protectedTools,
	]);

	// 1. Map every toolCallId -> dedup-key. Walking the assistant messages is the
	//    only way to recover a call's *arguments* — the tool result alone only
	//    has its name + output, not the input that produced it.
	const callIdToKey = new Map<string, string>();
	for (const m of messages) {
		if (!isAssistant(m)) continue;
		for (const call of toolCallsOf(m)) {
			if (protectedTools.has(call.name)) continue;
			callIdToKey.set(call.id, toolCallKey(call));
		}
	}

	// 2. Walk results newest -> oldest. Keep the first occurrence per key,
	//    placeholder the rest. Idempotent via state.dedupedCallIds.
	const seenKeys = new Set<string>();
	let prunedCount = 0;
	let tokensSaved = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isToolResult(m)) continue;
		if (protectedTools.has(m.toolName)) continue;
		if (protectedByTurn.has(m.toolCallId)) continue;
		const key = callIdToKey.get(m.toolCallId);
		if (!key) continue;
		if (!seenKeys.has(key)) {
			seenKeys.add(key);
			continue; // newest of its signature — keep
		}
		const saved = placeholderToolResult(m, `duplicate ${m.toolName} call`);
		// Even if placeholderToolResult already returned 0 (idempotent re-run),
		// counting once per call-id keeps stats stable.
		if (!state.dedupedCallIds.has(m.toolCallId)) {
			state.dedupedCallIds.add(m.toolCallId);
			prunedCount++;
			tokensSaved += saved;
		}
	}

	state.stats.dedupPruned += prunedCount;
	state.stats.tokensSaved += tokensSaved;
	return { prunedCount, tokensSaved };
}
