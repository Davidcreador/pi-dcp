/**
 * `compress` tool, MESSAGE mode.
 *
 * The model picks individual tool-call IDs to summarize away. Most surgical
 * variant — useful when only some calls in a span are noise and the rest
 * should remain verbatim.
 */
import * as t from "typebox";
import {
	type ExtensionContext,
	type ToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { PROMPTS, type PromptStore } from "../prompts/index.ts";
import { type CompressToolContext, preflight, reply, storeCompression } from "./shared.ts";

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

type CompressMessageParams = {
	toolCallIds: string[];
	topic: string;
	summary: string;
};

export function createCompressMessageTool(
	ctx: CompressToolContext,
	prompts: PromptStore,
): ToolDefinition<typeof Schema> {
	return defineTool({
		name: "compress",
		label: "Compress",
		description: prompts.read(PROMPTS.compressMessage),
		promptSnippet:
			"compress(toolCallIds, topic, summary) — replace older tool outputs with a lossless technical summary to reclaim context.",
		parameters: Schema,
		executionMode: "sequential",
		async execute(_toolCallId, params: CompressMessageParams, _signal, _onUpdate, _ext: ExtensionContext) {
			const stop = preflight(ctx);
			if (stop) return stop;

			const ids = [...new Set(params.toolCallIds)].filter((s) => s && s.length > 0);
			if (ids.length === 0) {
				return reply("compress refused: toolCallIds was empty after deduplication.", {
					refused: true,
					reason: "empty_ids",
				});
			}
			return storeCompression(ctx, ids, params.topic, params.summary);
		},
	});
}
