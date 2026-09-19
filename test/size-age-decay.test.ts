/**
 * Unit tests for the size×age decay strategy. Run with:
 *   node --experimental-strip-types --test test/*.test.ts
 *
 * Covers:
 *   - old large results become head+tail excerpts with a recall marker
 *   - age is counted in assistant messages after the result, not user turns
 *   - small/recent/protected/errored-edge results are honored
 *   - minified content falls back to a char-based excerpt
 *   - idempotency and original-immutability (via runPipeline)
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
import { applySizeAgeDecay } from "../lib/strategies/size-age-decay.ts";
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
function mkAssistantNote(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 };
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

const BIG_BODY = Array.from({ length: 400 }, (_, i) => `const value_${i} = "payload line ${i} with some padding";`).join("\n");

/** The target result plus `followers` assistant messages positioned after it. */
function aged(body: string, followers = 12, isError = false, name = "bash"): AnyMessage[] {
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("g1", name, name === "bash" ? { command: "seq 400" } : { path: "/abs/f.ts" }),
		mkToolResult("g1", name, body, isError),
	];
	for (let i = 0; i < followers; i++) msgs.push(mkAssistantNote(`step ${i}`));
	return msgs;
}

test("old large result is excerpted with head, tail, marker and token savings", () => {
	const msgs = aged(BIG_BODY);
	const state = createSessionState();
	const r = applySizeAgeDecay(msgs, lenientConfig(), state);
	assert.equal(r.decayedCount, 1);
	assert.ok(r.tokensSaved > 0);
	const out = text(msgs[1]).text;
	assert.ok(out.startsWith('const value_0 = "payload line 0 with some padding";'));
	assert.ok(out.includes('const value_399 = "payload line 399 with some padding";'));
	assert.match(out, /\[pi-dcp excerpt: showing 30\+15 of 400 lines, ~\d+ tokens omitted — recall toolCallId=g1 restores the full output\]/);
	assert.equal(state.stats.decayed, 1);
});

test("same result at age 11 is untouched", () => {
	const msgs = aged(BIG_BODY, 11);
	const r = applySizeAgeDecay(msgs, lenientConfig(), createSessionState());
	assert.equal(r.decayedCount, 0);
	assert.equal(text(msgs[1]).text, BIG_BODY);
});

test("large-but-recent and old-but-small results are untouched", () => {
	const recent = aged(BIG_BODY, 0);
	const small = aged("short output", 30);
	const state = createSessionState();
	const cfg = lenientConfig();
	assert.equal(applySizeAgeDecay(recent, cfg, state).decayedCount, 0);
	assert.equal(applySizeAgeDecay(small, cfg, state).decayedCount, 0);
});

test("protectedByTurn, protected tools and placeholders are untouched", () => {
	const cfg = lenientConfig();
	const protectedTurn = aged(BIG_BODY);
	assert.equal(applySizeAgeDecay(protectedTurn, cfg, createSessionState(), new Set(["g1"])).decayedCount, 0);

	cfg.strategies.sizeAgeDecay.protectedTools = ["bash"];
	const protectedTool = aged(BIG_BODY);
	assert.equal(applySizeAgeDecay(protectedTool, cfg, createSessionState()).decayedCount, 0);
	cfg.strategies.sizeAgeDecay.protectedTools = [];

	const placeholdered = aged(BIG_BODY);
	(placeholdered[1] as ToolResultMessage).content = [{ type: "text", text: "[pruned by pi-dcp: duplicate bash call] (recall toolCallId=g1 restores it)" }];
	assert.equal(applySizeAgeDecay(placeholdered, cfg, createSessionState()).decayedCount, 0);
});

test("old large error outputs are excerpted too", () => {
	const msgs = aged(BIG_BODY, 12, true);
	const r = applySizeAgeDecay(msgs, lenientConfig(), createSessionState());
	assert.equal(r.decayedCount, 1);
	assert.match(text(msgs[1]).text, /\[pi-dcp excerpt:/);
});

test("minified single-line content falls back to a char-based excerpt", () => {
	const body = Array.from({ length: 4000 }, (_, i) => `token_${i}_value`).join(" ");
	const msgs = aged(body);
	const r = applySizeAgeDecay(msgs, lenientConfig(), createSessionState());
	assert.equal(r.decayedCount, 1);
	const out = text(msgs[1]).text;
	assert.ok(out.startsWith(body.slice(0, 3000)));
	assert.ok(out.endsWith(body.slice(-1000)));
	assert.match(out, /\[pi-dcp excerpt: showing 3000\+1000 of \d+ chars, ~\d+ tokens omitted — recall toolCallId=g1 restores the full output\]/);
});

test("idempotent: a second run adds nothing to counts or stats", () => {
	const msgs = aged(BIG_BODY);
	const state = createSessionState();
	const cfg = lenientConfig();
	const first = applySizeAgeDecay(msgs, cfg, state);
	const second = applySizeAgeDecay(msgs, cfg, state);
	assert.equal(first.decayedCount, 1);
	assert.equal(second.decayedCount, 0);
	assert.equal(second.tokensSaved, 0);
	assert.equal(state.stats.decayed, 1);
});

test("decay reaches old results inside one long turn when turnProtection is step-capped", () => {
	const cfg = lenientConfig();
	cfg.turnProtection = { enabled: true, turns: 3, maxSteps: 30 };
	// One turn, 40 steps, no user boundary: only the newest 30 are protected,
	// so the big result at step 1 is exposed to decay.
	const msgs: AnyMessage[] = [
		mkAssistantWithCall("g1", "bash", { command: "seq 400" }),
		mkToolResult("g1", "bash", BIG_BODY),
	];
	for (let i = 2; i <= 40; i++) {
		msgs.push(
			mkAssistantWithCall(`s${i}`, "grep", { q: `query-${i}` }),
			mkToolResult(`s${i}`, "grep", `hit ${i}`),
		);
	}
	const r = runPipeline(msgs, cfg, createSessionState(), silentLogger);
	assert.equal(r.decayed, 1);
	assert.match(text(r.messages[1]).text, /\[pi-dcp excerpt:/);
});

test("runPipeline does not mutate the original result", () => {
	const msgs = aged(BIG_BODY);
	const snapshot = JSON.parse(JSON.stringify(msgs));
	const r = runPipeline(msgs, lenientConfig(), createSessionState(), silentLogger);
	assert.equal(r.decayed, 1);
	assert.deepEqual(msgs, snapshot);
	assert.match(text(r.messages[1]).text, /\[pi-dcp excerpt:/);
});
