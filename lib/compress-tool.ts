/**
 * The `compress` tool — exposed to the LLM via pi.registerTool().
 *
 * The model decides when to compress. It calls compress with:
 *   - toolCallIds: tool-call IDs whose results should be summarized away
 *   - topic: a short heading for the compression
 *   - summary: high-fidelity natural-language summary preserving facts
 *
 * Validation enforced at submit time:
 *   - manualMode must be OFF (otherwise the tool refuses)
 *   - permission must not be "deny" (handled at registration, also re-checked)
 *   - toolCallIds may not target ALWAYS_PROTECTED_TOOLS or user-configured
 *     protectedTools — we cannot tell which is which without inspecting the
 *     conversation, so we trust the model AND log a warning for unknown ids
 *     on the next pipeline run
 *
 * The actual replacement happens later in runPipeline during the `context`
 * event, so the compression takes effect on the NEXT LLM call. The model's
 * current turn still sees the originals.
 */
import * as t from "typebox";
import {
	type AgentToolResult,
	type ExtensionContext,
	type ToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { CompressionRecord, SessionState } from "./state.ts";
import { approxTokens } from "./messages.ts";

const Schema = t.Object({
	toolCallIds: t.Array(t.String(), {
		description:
			"IDs of tool calls (visible in your conversation history) whose results should be replaced with the summary. At least one. Older / closed work-streams are best candidates. NEVER include calls from your most recent turn.",
		minItems: 1,
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

type CompressParams = {
	toolCallIds: string[];
	topic: string;
	summary: string;
};

export interface CompressToolContext {
	state: SessionState;
	logger: Logger;
	config: DcpConfig;
}

interface CompressDetails {
	compressionId?: number;
	topic?: string;
	refused?: boolean;
	reason?: string;
}

function reply(text: string, details: CompressDetails): AgentToolResult<CompressDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function createCompressTool(
	ctx: CompressToolContext,
): ToolDefinition<typeof Schema, CompressDetails> {
	return defineTool({
		name: "compress",
		label: "Compress",
		description:
			"Compress one or more older tool-call results into a high-fidelity summary. Use when the literal tool output is no longer needed but its facts still are (e.g. after finishing exploration, after a long failed retry loop). The replacement is applied on the next LLM request — your current turn sees the originals. NEVER compress tool calls from your most recent turn or work in progress.",
		promptSnippet:
			"compress(toolCallIds, topic, summary) — replace older tool outputs with a lossless technical summary to reclaim context.",
		parameters: Schema,
		executionMode: "sequential",
		async execute(_toolCallId, params: CompressParams, _signal, _onUpdate, _ext: ExtensionContext) {
			if (ctx.config.compress.permission === "deny") {
				return reply("compress is disabled by configuration.", {
					refused: true,
					reason: "permission_deny",
				});
			}
			if (ctx.state.manualMode) {
				return reply(
					"compress is disabled because pi-dcp manual mode is on. The user must run /dcp sweep or /dcp manual off to re-enable autonomous compression.",
					{ refused: true, reason: "manual_mode" },
				);
			}

			const ids = [...new Set(params.toolCallIds)].filter((s) => s && s.length > 0);
			if (ids.length === 0) {
				return reply("compress refused: toolCallIds was empty after deduplication.", {
					refused: true,
					reason: "empty_ids",
				});
			}

			const id = ctx.state.nextCompressionId++;
			const rec: CompressionRecord = {
				id,
				createdAt: Date.now(),
				toolCallIds: ids,
				summary: params.summary,
				topic: params.topic.slice(0, 120),
				// Real savings are computed by the pipeline; this is only a lower-bound
				// hint used by /dcp context when the pipeline hasn't run yet.
				tokensSaved: approxTokens(params.summary),
				suspended: false,
			};
			ctx.state.compressions.set(id, rec);
			ctx.logger.info("compression stored", {
				id,
				topic: rec.topic,
				calls: rec.toolCallIds.length,
			});
			return reply(
				`Compression #${id} stored ("${rec.topic}"). ${rec.toolCallIds.length} tool result(s) will be replaced with the summary on the next request. User can restore them with "/dcp decompress ${id}".`,
				{ compressionId: id, topic: rec.topic },
			);
		},
	});
}
