/**
 * `compress` tool, RANGE mode.
 *
 * The model gives two toolCallIds — the first and last call in a contiguous
 * closed work-stream — and we resolve the span by walking the current
 * session branch root→leaf. Every tool result strictly between (inclusive)
 * the two endpoints gets included, with protected tools filtered out.
 *
 * This is the easier shape for the LLM in long sessions: it doesn't have to
 * enumerate every call ID, just the bookends.
 */
import * as t from "typebox";
import {
	type ExtensionContext,
	type ToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { PROMPTS, type PromptStore } from "../prompts/index.ts";
import { protectedByRecency } from "../messages.ts";
import {
	type CompressToolContext,
	branchToolCallIds,
	preflight,
	reply,
	storeCompression,
} from "./shared.ts";

const Schema = t.Object({
	startToolCallId: t.String({
		description:
			"Tool-call ID of the FIRST call in the closed work-stream you want to compress. Must be visible in your conversation history.",
	}),
	endToolCallId: t.String({
		description:
			"Tool-call ID of the LAST call in the closed work-stream. Everything between start and end (inclusive) is compressed. NEVER pick a tool call from your most recent turn or in-flight work.",
	}),
	topic: t.String({
		description:
			"Short heading (max ~120 chars) describing what the compressed work was about. E.g. 'Initial repo scan' or 'Failed dependency install attempts'.",
		minLength: 3,
		maxLength: 120,
	}),
	summary: t.String({
		description:
			"High-fidelity technical summary of the compressed work. Include: 1) what was accomplished, 2) all concrete facts the model may need later (file paths, line numbers, error messages, decisions), 3) what is still open. Be terse but lossless on facts.",
		minLength: 30,
	}),
});

type CompressRangeParams = {
	startToolCallId: string;
	endToolCallId: string;
	topic: string;
	summary: string;
};

export function createCompressRangeTool(
	ctx: CompressToolContext,
	prompts: PromptStore,
): ToolDefinition<typeof Schema> {
	return defineTool({
		name: "compress",
		label: "Compress",
		description: prompts.read(PROMPTS.compressRange),
		promptSnippet:
			"compress(startToolCallId, endToolCallId, topic, summary) — replace a contiguous span of tool outputs with a lossless technical summary.",
		parameters: Schema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: CompressRangeParams,
			_signal,
			_onUpdate,
			ext: ExtensionContext,
		) {
			const stop = preflight(ctx);
			if (stop) return stop;

			if (!params.startToolCallId || !params.endToolCallId) {
				return reply("compress refused: startToolCallId/endToolCallId are required.", {
					refused: true,
					reason: "missing_endpoints",
				});
			}

			// Walk the current branch root→leaf and resolve the span to a list of
			// non-protected tool result IDs.
			let branch: unknown[];
			try {
				branch = ext.sessionManager.getBranch();
			} catch (e) {
				ctx.logger.error("compress range: failed to read branch", {
					error: e instanceof Error ? e.message : String(e),
				});
				return reply("compress refused: could not read session branch.", {
					refused: true,
					reason: "branch_read_failed",
				});
			}
			const orderedIds = branchToolCallIds(branch, ctx.config);
			const startIdx = orderedIds.findIndex((x) => x.id === params.startToolCallId);
			const endIdx = orderedIds.findIndex((x) => x.id === params.endToolCallId);

			if (startIdx === -1 || endIdx === -1) {
				return reply(
					`compress refused: ${startIdx === -1 ? "startToolCallId" : "endToolCallId"} not found in current session branch (or it points to a protected tool).`,
					{ refused: true, reason: "endpoint_not_found" },
				);
			}

			const lo = Math.min(startIdx, endIdx);
			const hi = Math.max(startIdx, endIdx);
			const ids = orderedIds.slice(lo, hi + 1).map((x) => x.id);

			if (ids.length === 0) {
				return reply("compress refused: resolved range was empty.", {
					refused: true,
					reason: "empty_range",
				});
			}

			// If turnProtection is on, any endpoints inside the protected window
			// would be silently no-op'd at pipeline time. Refuse upfront instead
			// so the model can pick older endpoints.
			if (ctx.config.turnProtection.enabled) {
				const protectedSet = protectedByRecency(
					// Convert branch -> minimal AnyMessage-shaped view for the helper.
					(branch as Array<{ type?: string; message?: unknown }>)
						.filter((e) => e?.type === "message" && e.message)
						.map((e) => e.message as any),
					ctx.config.turnProtection.turns,
				);
				const overlap = ids.filter((id) => protectedSet.has(id));
				if (overlap.length > 0) {
					return reply(
						`compress refused: ${overlap.length} of ${ids.length} tool call(s) in the range are inside the protected window (turnProtection.turns=${ctx.config.turnProtection.turns}). Pick endpoints older than the last ${ctx.config.turnProtection.turns} user message(s).`,
						{ refused: true, reason: "protected_window_overlap" },
					);
				}
			}

			return storeCompression(ctx, ids, params.topic, params.summary);
		},
	});
}
