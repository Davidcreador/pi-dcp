/**
 * Context pipeline.
 *
 * Heart of pi-dcp. Runs on every `context` event — just before pi sends a
 * request to the model. We receive `event.messages` whose entries share
 * object identity with the persisted session entries; mutating them in place
 * would corrupt the on-disk session. We therefore:
 *
 *   1. Build a working array, swapping any message we plan to touch with a
 *      cloned copy (cloneForMutation). Untouched messages keep their original
 *      reference.
 *   2. Apply stored compressions, then deduplication, then errored-input
 *      purge — each step mutates only the cloned copies.
 *   3. Return the working array so pi can hand it to the provider.
 *
 * Order matters: compressions first (cheapest + most aggressive), then dedup
 * (keeps newest of each signature), then purge (independent of the others).
 *
 * Every step is idempotent so re-running on the same conversation is safe.
 */
import type { Logger } from "./logger.ts";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "./config.ts";
import {
	type AnyMessage,
	cloneForMutation,
	compressionPlaceholderToolResult,
	isAlreadyPlaceholder,
	isAssistant,
	isToolCall,
	isToolResult,
} from "./messages.ts";
import { applyDeduplication } from "./strategies/deduplication.ts";
import { applyPurgeErrors } from "./strategies/purge-errors.ts";
import type { CompressionRecord, SessionState } from "./state.ts";
import { bumpLifetime } from "./stats.ts";

export interface PipelineResult {
	/** New messages array to hand back to pi. Same shape as input, mutation-safe. */
	messages: AnyMessage[];
	dedupPruned: number;
	errorInputsPurged: number;
	compressionsApplied: number;
	tokensSaved: number;
}

/**
 * Decide whether a message needs to be cloned for this pass. We clone tool
 * results that may be overwritten and assistant messages whose tool-call
 * arguments may be rewritten. Everything else stays a shared reference.
 */
function needsClone(
	m: AnyMessage,
	config: DcpConfig,
	state: SessionState,
	compressionTargets: Set<string>,
): boolean {
	const protectedTools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.compress.protectedTools,
	]);
	if (isToolResult(m)) {
		if (protectedTools.has(m.toolName)) return false;
		if (compressionTargets.has(m.toolCallId)) return true;
		// Could become a dedup placeholder or be left alone; clone to be safe.
		return true;
	}
	if (isAssistant(m)) {
		// Only assistant messages with tool calls are subject to purge mutation.
		for (const c of m.content) {
			if (isToolCall(c) && !protectedTools.has(c.name)) return true;
		}
		return false;
	}
	return false;
}

function compressionsByToolCallId(state: SessionState): Map<string, CompressionRecord> {
	const out = new Map<string, CompressionRecord>();
	for (const rec of state.compressions.values()) {
		if (rec.suspended) continue;
		for (const id of rec.toolCallIds) out.set(id, rec);
	}
	return out;
}

export function runPipeline(
	originalMessages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	logger: Logger,
): PipelineResult {
	const summaries = compressionsByToolCallId(state);
	const compressionTargets = new Set(summaries.keys());

	// Build a fresh working array. Each entry is either the original message
	// (when nothing in this pipeline will touch it) or a clone we can mutate.
	const messages: AnyMessage[] = new Array(originalMessages.length);
	for (let i = 0; i < originalMessages.length; i++) {
		const m = originalMessages[i];
		messages[i] = needsClone(m, config, state, compressionTargets) ? cloneForMutation(m) : m;
	}

	const result: PipelineResult = {
		messages,
		dedupPruned: 0,
		errorInputsPurged: 0,
		compressionsApplied: 0,
		tokensSaved: 0,
	};

	// 1. Apply stored compressions. The placeholder rewrite runs every pass
	//    (each pass starts from un-mutated session-owned originals) but we only
	//    count one application per (toolCallId) for stats — that's the
	//    user-meaningful number.
	if (summaries.size > 0) {
		const protectedTools = new Set([
			...ALWAYS_PROTECTED_TOOLS,
			...config.compress.protectedTools,
		]);
		for (const m of messages) {
			if (!isToolResult(m)) continue;
			if (protectedTools.has(m.toolName)) continue;
			const rec = summaries.get(m.toolCallId);
			if (!rec || rec.suspended) continue;
			if (isAlreadyPlaceholder(m)) continue;
			const saved = compressionPlaceholderToolResult(m, rec.id, rec.topic);
			if (!state.appliedCompressionTargets.has(m.toolCallId)) {
				state.appliedCompressionTargets.add(m.toolCallId);
				result.compressionsApplied++;
				result.tokensSaved += saved;
			}
		}
	}

	// 2. Deduplication.
	const dedup = applyDeduplication(messages, config, state);
	result.dedupPruned = dedup.prunedCount;
	result.tokensSaved += dedup.tokensSaved;

	// 3. Purge errored tool inputs.
	const purged = applyPurgeErrors(messages, config, state);
	result.errorInputsPurged = purged.purgedCount;
	result.tokensSaved += purged.tokensSaved;

	if (result.dedupPruned || result.errorInputsPurged || result.compressionsApplied) {
		state.stats.compressionsApplied += result.compressionsApplied;
		logger.info("pipeline applied", {
			dedupPruned: result.dedupPruned,
			errorInputsPurged: result.errorInputsPurged,
			compressionsApplied: result.compressionsApplied,
			tokensSaved: result.tokensSaved,
		});
		bumpLifetime({
			dedupPruned: result.dedupPruned,
			errorInputsPurged: result.errorInputsPurged,
			compressionsApplied: result.compressionsApplied,
			tokensSaved: result.tokensSaved,
		});
	}

	return result;
}
