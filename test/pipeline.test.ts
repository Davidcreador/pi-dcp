/**
 * Unit tests for the pipeline + strategies. Run with:
 *   node --experimental-strip-types --test test/*.test.ts
 *
 * Covers:
 *   - canonicalJson determinism (nested key order)
 *   - dedup keeps newest, replaces older, respects protected tools
 *   - purgeErrors waits for turn count, skips protected
 *   - pipeline does NOT mutate input message objects (session safety)
 *   - pipeline idempotency under repeated invocation
 *   - compression placeholder application
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../lib/config.ts";
import { lenientConfig } from "./_helpers.ts";
import {
	type AnyMessage,
	type AssistantMessage,
	type ToolResultMessage,
	canonicalJson,
	toolCallKey,
} from "../lib/messages.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { createSessionState } from "../lib/state.ts";

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
} as any;

function mkUser(text: string): AnyMessage {
	return { role: "user", content: text, timestamp: 0 };
}
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

test("canonicalJson sorts nested keys", () => {
	const a = { x: { b: 2, a: 1 }, y: [1, 2] };
	const b = { y: [1, 2], x: { a: 1, b: 2 } };
	assert.equal(canonicalJson(a), canonicalJson(b));
});

test("canonicalJson handles cycles", () => {
	const a: any = { x: 1 };
	a.self = a;
	assert.doesNotThrow(() => canonicalJson(a));
});

test("toolCallKey produces stable signature regardless of key order", () => {
	const k1 = toolCallKey({ name: "grep", arguments: { pattern: "foo", path: "src" } });
	const k2 = toolCallKey({ name: "grep", arguments: { path: "src", pattern: "foo" } });
	assert.equal(k1, k2);
});

test("dedup replaces older duplicates and keeps newest", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("c1", "grep", { pattern: "foo" }),
		mkToolResult("c1", "grep", "match line 1"),
		mkAssistantWithCall("c2", "grep", { pattern: "foo" }),
		mkToolResult("c2", "grep", "match line 1"),
	];
	const state = createSessionState();
	const r = runPipeline(msgs, lenientConfig(), state, silentLogger);
	assert.equal(r.dedupPruned, 1);
	const first = r.messages[1] as ToolResultMessage;
	const second = r.messages[3] as ToolResultMessage;
	assert.ok((first.content[0] as any).text.startsWith("[pruned by pi-dcp"));
	assert.equal((second.content[0] as any).text, "match line 1");
});

test("dedup never touches protected tools (write)", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("c1", "write", { path: "a.ts", content: "x" }),
		mkToolResult("c1", "write", "ok"),
		mkAssistantWithCall("c2", "write", { path: "a.ts", content: "x" }),
		mkToolResult("c2", "write", "ok"),
	];
	const state = createSessionState();
	const r = runPipeline(msgs, lenientConfig(), state, silentLogger);
	assert.equal(r.dedupPruned, 0);
});

test("pipeline does NOT mutate the input messages array or its members", () => {
	const orig: AnyMessage[] = [
		mkAssistantWithCall("c1", "grep", { pattern: "foo" }),
		mkToolResult("c1", "grep", "match"),
		mkAssistantWithCall("c2", "grep", { pattern: "foo" }),
		mkToolResult("c2", "grep", "match"),
	];
	// Capture deep snapshot of each entry's mutable surfaces.
	const snapshots = orig.map((m) => JSON.parse(JSON.stringify(m)));
	const state = createSessionState();
	runPipeline(orig, lenientConfig(), state, silentLogger);
	for (let i = 0; i < orig.length; i++) {
		assert.deepEqual(orig[i], snapshots[i], `message ${i} was mutated in place`);
	}
});

test("pipeline is idempotent: re-running yields stable stats", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("c1", "grep", { pattern: "foo" }),
		mkToolResult("c1", "grep", "x"),
		mkAssistantWithCall("c2", "grep", { pattern: "foo" }),
		mkToolResult("c2", "grep", "x"),
	];
	const state = createSessionState();
	const r1 = runPipeline(msgs, lenientConfig(), state, silentLogger);
	const r2 = runPipeline(msgs, lenientConfig(), state, silentLogger);
	assert.equal(r1.dedupPruned, 1);
	assert.equal(r2.dedupPruned, 0, "second run should not double-count");
});

test("purgeErrors waits for the configured number of turns", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("e1", "bash", { command: "rm -rf /tmp/non-existent && do-things" }),
		mkToolResult("e1", "bash", "ENOENT", /* isError */ true),
	];
	const state = createSessionState();
	const cfg = lenientConfig();
	cfg.strategies.purgeErrors.turns = 3;

	// Turn 0: error first seen, not aged yet.
	state.turnIndex = 0;
	let r = runPipeline(msgs, cfg, state, silentLogger);
	assert.equal(r.errorInputsPurged, 0);

	// Turn 3: now eligible.
	state.turnIndex = 3;
	r = runPipeline(msgs, cfg, state, silentLogger);
	assert.equal(r.errorInputsPurged, 1);

	// And the args on the cloned message must be the marker, not the original.
	const purgedCall = (r.messages[0] as AssistantMessage).content.find(
		(c: any) => c.type === "toolCall",
	) as any;
	assert.equal(purgedCall.arguments.__purged, "[args purged by pi-dcp]");

	// Original is untouched.
	const origCall = (msgs[0] as AssistantMessage).content.find(
		(c: any) => c.type === "toolCall",
	) as any;
	assert.equal(origCall.arguments.command, "rm -rf /tmp/non-existent && do-things");
});

test("purgeErrors skips protected tools (edit)", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("e1", "edit", { path: "a.ts", oldText: "x", newText: "y" }),
		mkToolResult("e1", "edit", "no match", true),
	];
	const state = createSessionState();
	state.turnIndex = 10;
	const r = runPipeline(msgs, lenientConfig(), state, silentLogger);
	assert.equal(r.errorInputsPurged, 0);
});

test("stored compression replaces tool result with placeholder", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("c1", "read", { path: "huge.log" }),
		mkToolResult("c1", "read", "x".repeat(40_000)),
	];
	const state = createSessionState();
	state.compressions.set(7, {
		id: 7,
		createdAt: 0,
		toolCallIds: ["c1"],
		summary: "huge.log had 40k chars of noise; nothing actionable.",
		topic: "noise log",
		tokensSaved: 0,
		suspended: false,
	});
	state.nextCompressionId = 8;
	const r = runPipeline(msgs, lenientConfig(), state, silentLogger);
	assert.equal(r.compressionsApplied, 1);
	const tr = r.messages[1] as ToolResultMessage;
	assert.match((tr.content[0] as any).text, /pi-dcp compression #7/);
	// Original must still hold the 40k payload.
	assert.equal((msgs[1] as ToolResultMessage).content[0].text!.length, 40_000);
});

test("suspended compression does NOT apply (decompress simulation)", () => {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("c1", "read", { path: "x" }),
		mkToolResult("c1", "read", "original output"),
	];
	const state = createSessionState();
	state.compressions.set(1, {
		id: 1,
		createdAt: 0,
		toolCallIds: ["c1"],
		summary: "summary",
		topic: "t",
		tokensSaved: 0,
		suspended: true,
	});
	const r = runPipeline(msgs, lenientConfig(), state, silentLogger);
	assert.equal(r.compressionsApplied, 0);
	const tr = r.messages[1] as ToolResultMessage;
	assert.equal((tr.content[0] as any).text, "original output");
});
