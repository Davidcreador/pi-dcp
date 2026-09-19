/**
 * `recall` tool.
 *
 * Read-only inverse of every pi-dcp prune: session entries are never mutated
 * by the pipeline, so the persisted toolResult on the current branch still
 * holds the verbatim original. The model passes the toolCallId printed in a
 * placeholder or excerpt marker and gets the full output back.
 *
 * Registered unconditionally — unlike `compress` it can only ADD context,
 * never remove it, so compress.permission does not apply.
 */
import * as t from "typebox";
import {
	type ExtensionContext,
	type ToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { toolResultTokens } from "../messages.ts";
import { type CompressToolContext, reply } from "./shared.ts";

const Schema = t.Object({
	toolCallId: t.String({
		description: "The toolCallId shown in a pi-dcp placeholder or excerpt marker.",
	}),
});

export function createRecallTool(_ctx: CompressToolContext): ToolDefinition<typeof Schema> {
	return defineTool({
		name: "recall",
		label: "Recall",
		description:
			"Restore the verbatim output of an earlier tool call that pi-dcp pruned, excerpted, or compressed. Pass the toolCallId shown in the placeholder. Use when you need the exact original content again.",
		parameters: Schema,
		executionMode: "sequential",
		async execute(_toolCallId, params: { toolCallId: string }, _signal, _onUpdate, ext: ExtensionContext) {
			const entry = ext.sessionManager.getBranch().find(e =>
				e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === params.toolCallId);
			if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
				return reply("recall refused: toolCallId not found on the current branch.", {
					refused: true,
					reason: "not_found",
				});
			}
			const original = entry.message;
			let droppedImages = false;
			const content = original.content.filter(block => {
				if (block.type === "text") return true;
				droppedImages = true;
				return false;
			});
			if (droppedImages) content.push({ type: "text", text: "[image omitted]" });
			return {
				content,
				details: {
					recalledToolCallId: original.toolCallId,
					toolName: original.toolName,
					tokens: toolResultTokens(original),
				},
			};
		},
	});
}
