/** Recall tool tests: verbatim restores from the persisted branch; no live sessions. */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createRecallTool } from "../lib/tools/recall.ts";
import { lenientConfig } from "./_helpers.ts";
import { resultEntries } from "./_jev-fixtures.ts";
import { createSessionState } from "../lib/state.ts";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as any;

function host(entries: SessionEntry[]) {
	const tool = createRecallTool({ state: createSessionState(), logger: silentLogger, config: lenientConfig() });
	const ext = { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
	return { tool, ext };
}

test("recall returns the persisted original text blocks verbatim", async () => {
	const entries = resultEntries("old", "the exact original payload");
	const { tool, ext } = host(entries);
	const result = await tool.execute("r1", { toolCallId: "old" }, undefined, undefined, ext);
	assert.deepEqual(result.details, { recalledToolCallId: "old", toolName: "read", tokens: result.details?.tokens });
	assert.deepEqual(result.content, [{ type: "text", text: "the exact original payload" }]);
});

test("unknown toolCallId is refused", async () => {
	const { tool, ext } = host(resultEntries("old", "payload"));
	const result = await tool.execute("r1", { toolCallId: "missing" }, undefined, undefined, ext);
	assert.match((result.content[0] as { text: string }).text, /recall refused: toolCallId not found/);
	assert.equal(result.details?.refused, true);
	assert.equal(result.details?.reason, "not_found");
});

test("image blocks are dropped with an omission note", async () => {
	const entries = resultEntries("old", "text before image");
	const result0 = entries[1];
	if (result0.type === "message" && result0.message.role === "toolResult") {
		(result0.message.content as unknown[]).push({ type: "image", data: "AAAA", mimeType: "image/png" });
	}
	const { tool, ext } = host(entries);
	const result = await tool.execute("r1", { toolCallId: "old" }, undefined, undefined, ext);
	assert.deepEqual(result.content, [
		{ type: "text", text: "text before image" },
		{ type: "text", text: "[image omitted]" },
	]);
});
