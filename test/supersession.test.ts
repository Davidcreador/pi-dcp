/**
 * Unit tests for the supersession strategy. Run with:
 *   node --experimental-strip-types --test test/*.test.ts
 *
 * Covers:
 *   - a read older than a successful edit/write of the same path is stale
 *   - failed modifications and different paths never supersede
 *   - a read newer than every modification stays
 *   - protectedByTurn and idempotency are honored; originals never mutate
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lenientConfig } from "./_helpers.ts";
import {
	type AnyMessage,
	type AssistantMessage,
	type ToolResultMessage,
} from "../lib/messages.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { applySupersession } from "../lib/strategies/supersession.ts";
import { createSessionState } from "../lib/state.ts";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as any;

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

test("a read older than a successful edit is placeholdered; the edit stays", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "old content"),
		mkAssistantWithCall("e1", "edit", { path: "/abs/f.ts", oldText: "a", newText: "b" }),
		mkToolResult("e1", "edit", "applied"),
	];
	const state = createSessionState();
	const r = applySupersession(msgs, lenientConfig(), state);
	assert.equal(r.supersededCount, 1);
	assert.match(text(msgs[1]).text, /^\[pruned by pi-dcp: stale read of f\.ts/);
	assert.equal(text(msgs[3]).text, "applied");
	assert.equal(state.stats.superseded, 1);
});

test("a failed edit does not supersede an earlier read", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "content"),
		mkAssistantWithCall("e1", "edit", { path: "/abs/f.ts" }),
		mkToolResult("e1", "edit", "edit failed", true),
	];
	const r = applySupersession(msgs, lenientConfig(), createSessionState());
	assert.equal(r.supersededCount, 0);
	assert.equal(text(msgs[1]).text, "content");
});

test("a read newer than the modification stays", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("e1", "edit", { path: "/abs/f.ts" }),
		mkToolResult("e1", "edit", "applied"),
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "fresh content"),
	];
	const r = applySupersession(msgs, lenientConfig(), createSessionState());
	assert.equal(r.supersededCount, 0);
	assert.equal(text(msgs[3]).text, "fresh content");
});

test("a modification of a different path does not supersede", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "content"),
		mkAssistantWithCall("e1", "edit", { path: "/abs/g.ts" }),
		mkToolResult("e1", "edit", "applied"),
	];
	const r = applySupersession(msgs, lenientConfig(), createSessionState());
	assert.equal(r.supersededCount, 0);
	assert.equal(text(msgs[1]).text, "content");
});

test("bash cat older than a write is superseded", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("b1", "bash", { command: "cat /abs/f.ts" }),
		mkToolResult("b1", "bash", "everything"),
		mkAssistantWithCall("w1", "write", { path: "/abs/f.ts", content: "new" }),
		mkToolResult("w1", "write", "written"),
	];
	const r = applySupersession(msgs, lenientConfig(), createSessionState());
	assert.equal(r.supersededCount, 1);
	assert.match(text(msgs[1]).text, /stale read of f\.ts/);
});

test("protectedByTurn reads are untouched", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "content"),
		mkAssistantWithCall("e1", "edit", { path: "/abs/f.ts" }),
		mkToolResult("e1", "edit", "applied"),
	];
	const r = applySupersession(msgs, lenientConfig(), createSessionState(), new Set(["r1"]));
	assert.equal(r.supersededCount, 0);
	assert.equal(text(msgs[1]).text, "content");
});

test("idempotent: a second run adds nothing to counts or stats", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "content"),
		mkAssistantWithCall("e1", "edit", { path: "/abs/f.ts" }),
		mkToolResult("e1", "edit", "applied"),
	];
	const state = createSessionState();
	const cfg = lenientConfig();
	const first = applySupersession(msgs, cfg, state);
	const second = applySupersession(msgs, cfg, state);
	assert.equal(first.supersededCount, 1);
	assert.equal(second.supersededCount, 0);
	assert.equal(second.tokensSaved, 0);
	assert.equal(state.stats.superseded, 1);
});

test("runPipeline does not mutate the original read result", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("r1", "read", { path: "/abs/f.ts" }),
		mkToolResult("r1", "read", "content"),
		mkAssistantWithCall("e1", "edit", { path: "/abs/f.ts" }),
		mkToolResult("e1", "edit", "applied"),
	];
	const snapshot = JSON.parse(JSON.stringify(msgs));
	const r = runPipeline(msgs, lenientConfig(), createSessionState(), silentLogger);
	assert.equal(r.superseded, 1);
	assert.deepEqual(msgs, snapshot);
	assert.match(text(r.messages[1]).text, /stale read of f\.ts/);
});
