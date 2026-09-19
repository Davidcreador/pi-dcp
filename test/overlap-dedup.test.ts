/**
 * Unit tests for the overlap-dedup strategy. Run with:
 *   node --experimental-strip-types --test test/*.test.ts
 *
 * Covers:
 *   - a newer read fully containing an older read's range placeholders it
 *   - containment (not overlap) is required — smaller or disjoint newer reads keep both
 *   - bash read-alikes (cat/head/tail/sed -n 'a,bp') count as reads of their path
 *   - compound shell commands are never treated as reads
 *   - protectedByTurn, errored results and idempotency are honored
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lenientConfig } from "./_helpers.ts";
import {
	type AnyMessage,
	type AssistantMessage,
	type ToolResultMessage,
} from "../lib/messages.ts";
import { applyOverlapDedup } from "../lib/strategies/overlap-dedup.ts";
import { createSessionState } from "../lib/state.ts";

function mkAssistantWithCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "" },
			{ type: "toolCall", id, name, arguments: args },
		],
		timestamp: 0,
	};
}
function mkToolResult(id: string, name: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}
const text = (m: AnyMessage) => (m as ToolResultMessage).content[0] as { text: string };

test("newer read containing the older range placeholders the older result", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts", offset: 1, limit: 200 }),
		mkToolResult("r1", "read", "old lines"),
		mkAssistantWithCall("r2", "read", { path: "/abs/f.ts", offset: 1, limit: 400 }),
		mkToolResult("r2", "read", "new lines"),
	];
	const state = createSessionState();
	const r = applyOverlapDedup(msgs, lenientConfig(), state);
	assert.equal(r.prunedCount, 1);
	assert.match(text(msgs[1]).text, /^\[pruned by pi-dcp: superseded by newer read of f\.ts covering lines 1-400\]/);
	assert.equal(text(msgs[3]).text, "new lines");
});

test("a smaller newer read keeps both (containment requires newer superset)", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts", offset: 1, limit: 400 }),
		mkToolResult("r1", "read", "old lines"),
		mkAssistantWithCall("r2", "read", { path: "/abs/f.ts", offset: 100, limit: 101 }),
		mkToolResult("r2", "read", "new lines"),
	];
	const state = createSessionState();
	const r = applyOverlapDedup(msgs, lenientConfig(), state);
	assert.equal(r.prunedCount, 0);
	assert.equal(text(msgs[1]).text, "old lines");
});

test("an unbounded newer read contains any older bounded range", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts", offset: 50, limit: 20 }),
		mkToolResult("r1", "read", "slice"),
		mkAssistantWithCall("r2", "read", { path: "/abs/f.ts" }),
		mkToolResult("r2", "read", "whole file"),
	];
	const state = createSessionState();
	const r = applyOverlapDedup(msgs, lenientConfig(), state);
	assert.equal(r.prunedCount, 1);
	assert.equal(text(msgs[3]).text, "whole file");
});

test("bash cat counts as a full-file read in both directions", () => {
	const pruned: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/file.ts", offset: 10, limit: 5 }),
		mkToolResult("r1", "read", "few lines"),
		mkAssistantWithCall("b1", "bash", { command: "cat /abs/file.ts" }),
		mkToolResult("b1", "bash", "everything"),
	];
	let state = createSessionState();
	assert.equal(applyOverlapDedup(pruned, lenientConfig(), state).prunedCount, 1);
	assert.match(text(pruned[1]).text, /superseded by newer read of file\.ts covering lines 1-end/);

	const kept: AnyMessage[] = [
		mkAssistantWithCall("b1", "bash", { command: "cat /abs/file.ts" }),
		mkToolResult("b1", "bash", "everything"),
		mkAssistantWithCall("r1", "read", { path: "/abs/file.ts", offset: 10, limit: 5 }),
		mkToolResult("r1", "read", "few lines"),
	];
	state = createSessionState();
	assert.equal(applyOverlapDedup(kept, lenientConfig(), state).prunedCount, 0);
});

test("compound bash commands are never treated as reads", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("b1", "bash", { command: "cat /abs/f.ts | grep foo" }),
		mkToolResult("b1", "bash", "matched"),
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "whole file"),
	];
	const state = createSessionState();
	assert.equal(applyOverlapDedup(msgs, lenientConfig(), state).prunedCount, 0);
	assert.equal(text(msgs[1]).text, "matched");
});

test("protectedByTurn ids and errored results are untouched", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts", offset: 1, limit: 10 }),
		mkToolResult("r1", "read", "recent"),
		mkAssistantWithCall("e1", "read", { path: "/abs/g.ts", offset: 1, limit: 5 }),
		mkToolResult("e1", "read", "ENOENT", true),
		mkAssistantWithCall("r2", "read", { path: "/abs/f.ts" }),
		mkToolResult("r2", "read", "whole"),
		mkAssistantWithCall("r3", "read", { path: "/abs/g.ts" }),
		mkToolResult("r3", "read", "whole g"),
	];
	const state = createSessionState();
	const r = applyOverlapDedup(msgs, lenientConfig(), state, new Set(["r1"]));
	assert.equal(r.prunedCount, 0);
	assert.equal(text(msgs[1]).text, "recent");
	assert.equal(text(msgs[3]).text, "ENOENT");
});

test("idempotent: a second run adds nothing to counts or stats", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts", offset: 1, limit: 10 }),
		mkToolResult("r1", "read", "slice"),
		mkAssistantWithCall("r2", "read", { path: "/abs/f.ts" }),
		mkToolResult("r2", "read", "whole"),
	];
	const state = createSessionState();
	const cfg = lenientConfig();
	const first = applyOverlapDedup(msgs, cfg, state);
	const second = applyOverlapDedup(msgs, cfg, state);
	assert.equal(first.prunedCount, 1);
	assert.equal(second.prunedCount, 0);
	assert.equal(second.tokensSaved, 0);
	assert.equal(state.stats.overlapPruned, 1);
});

test("sed -n '5,20p' contained by a newer full-range read is pruned", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("b1", "bash", { command: "sed -n '5,20p' /abs/f.ts" }),
		mkToolResult("b1", "bash", "lines 5-20"),
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts", offset: 1, limit: 100 }),
		mkToolResult("r1", "read", "lines 1-100"),
	];
	const state = createSessionState();
	assert.equal(applyOverlapDedup(msgs, lenientConfig(), state).prunedCount, 1);
	assert.equal(text(msgs[3]).text, "lines 1-100");
});
