/**
 * Purge errored tool inputs.
 *
 * When a tool call returns isError=true we keep the error message (the LLM
 * may need it to recover) but strip the tool *arguments* (bash command body,
 * file contents the LLM tried to write, etc.) from the matching assistant
 * message once the failure is N turns old. The arguments are replaced with a
 * single-key marker object.
 *
 * Most tool retries copy a long failing payload many times; this strategy is
 * the single biggest token win in long agentic loops.
 *
 * Aging is by *turn count*, not by message-index distance. The first time we
 * see an errored call we record `state.erroredAt[callId] = state.turnIndex`.
 * Subsequent pipeline runs purge once `(currentTurn - erroredTurn) >= turns`.
 *
 * The pipeline passes us a working array of CLONED messages. We rewrite
 * ToolCall.arguments on those clones; never the originals.
 */
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	PURGE_ARGS_MARKER,
	approxTokens,
	canonicalJson,
	isAssistant,
	isToolCall,
	isToolResult,
} from "../messages.ts";
import type { SessionState } from "../state.ts";

export interface PurgeResult {
	purgedCount: number;
	tokensSaved: number;
}

export function applyPurgeErrors(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
): PurgeResult {
	const cfg = config.strategies.purgeErrors;
	if (!cfg.enabled) return { purgedCount: 0, tokensSaved: 0 };

	const protectedTools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...cfg.protectedTools,
		...config.compress.protectedTools,
	]);

	// 1. Find errored tool-call ids and record the turnIndex of first observation.
	const erroredCallIds = new Set<string>();
	for (const m of messages) {
		if (!isToolResult(m)) continue;
		if (!m.isError) continue;
		if (protectedTools.has(m.toolName)) continue;
		erroredCallIds.add(m.toolCallId);
		if (!state.erroredAt.has(m.toolCallId)) {
			state.erroredAt.set(m.toolCallId, state.turnIndex);
		}
	}
	if (erroredCallIds.size === 0) return { purgedCount: 0, tokensSaved: 0 };

	// 2. Walk assistant tool calls. Purge arguments for any matching errored
	//    call that is at least `turns` turns old. Idempotent via
	//    state.purgedErrorCallIds.
	let purgedCount = 0;
	let tokensSaved = 0;

	for (const m of messages) {
		if (!isAssistant(m)) continue;
		for (const c of m.content) {
			if (!isToolCall(c)) continue;
			if (protectedTools.has(c.name)) continue;
			if (!erroredCallIds.has(c.id)) continue;
			if (state.purgedErrorCallIds.has(c.id)) continue;

			const seenAt = state.erroredAt.get(c.id);
			if (seenAt === undefined) continue;
			if (state.turnIndex - seenAt < cfg.turns) continue;

			let beforeTokens = 0;
			try {
				beforeTokens = approxTokens(canonicalJson(c.arguments));
			} catch {
				beforeTokens = 0;
			}
			c.arguments = { __purged: PURGE_ARGS_MARKER };
			const afterTokens = approxTokens(canonicalJson(c.arguments));
			state.purgedErrorCallIds.add(c.id);
			purgedCount++;
			tokensSaved += Math.max(0, beforeTokens - afterTokens);
		}
	}

	state.stats.errorInputsPurged += purgedCount;
	state.stats.tokensSaved += tokensSaved;
	return { purgedCount, tokensSaved };
}
