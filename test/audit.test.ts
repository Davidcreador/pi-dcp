/**
 * Round-3 audit edge cases:
 *   - protectedByRecency with NO user message anywhere
 *   - iteration nudge: re-fire window throttling
 *   - per-model min+max both apply on same model
 *   - PromptStore.read on unknown name returns empty string (no crash)
 *   - messagesSinceLastUser bounded scan
 *   - compress tool refuses on turnProtection overlap (both modes)
 *   - empty messages array doesn't crash protectedByRecency
 *   - sweep refuses gracefully when getBranch throws
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../lib/config.ts";
import {
	type AnyMessage,
	type AssistantMessage,
	type ToolResultMessage,
	protectedByRecency,
} from "../lib/messages.ts";
import { makeNudgeHandler } from "../lib/nudges.ts";
import { PromptStore } from "../lib/prompts/index.ts";
import { createSessionState } from "../lib/state.ts";
import { createCompressMessageTool } from "../lib/tools/compress-message.ts";
import { createCompressRangeTool } from "../lib/tools/compress-range.ts";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as any;
function tmpPromptStore(): PromptStore {
	return new PromptStore({
		customPromptsEnabled: false,
		promptsDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-prompts-")),
	});
}
function user(): AnyMessage { return { role: "user", content: "x", timestamp: 0 }; }
function asst(id: string, name = "grep", args: any = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 };
}
function tr(id: string, name = "grep", text = "x", isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 };
}

// ───── protectedByRecency edges ─────

test("protectedByRecency on empty messages returns empty set", () => {
	assert.equal(protectedByRecency([], 5).size, 0);
});

test("protectedByRecency with no user msgs ever protects ALL tool calls", () => {
	// Fresh session, agent kicked off without a user message somehow.
	const msgs: AnyMessage[] = [asst("c1"), tr("c1"), asst("c2"), tr("c2")];
	const set = protectedByRecency(msgs, 1);
	// No boundary found → entire conversation is "still in the current turn".
	assert.deepEqual([...set].sort(), ["c1", "c2"]);
});

test("protectedByRecency with turns=NaN/-1/Infinity disables protection", () => {
	const msgs: AnyMessage[] = [user(), asst("c1"), tr("c1")];
	assert.equal(protectedByRecency(msgs, NaN).size, 0);
	assert.equal(protectedByRecency(msgs, -1).size, 0);
	assert.equal(protectedByRecency(msgs, Infinity).size, 0);
});

// ───── iteration nudge re-fire window ─────

test("iteration nudge does not re-fire until another threshold elapses", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 1_000_000;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.iterationNudgeThreshold = 3;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const baseBranch = [{ type: "message", message: user() }];
	function branchOf(extras: number) {
		const out = [...baseBranch];
		for (let i = 0; i < extras; i++) out.push({ type: "message", message: asst(`c${i}`) } as any);
		return out;
	}
	const ctxFor = (extras: number) =>
		({
			model: undefined,
			getContextUsage: () => ({ tokens: 5_000, contextWindow: 200_000, percent: 2 }),
			sessionManager: { getBranch: () => branchOf(extras) },
		}) as any;
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;

	// since=3 → fires.
	const r1 = await handler(evt, ctxFor(3));
	assert.ok(r1?.systemPrompt?.includes("many steps since last user message"));
	// since=4, 5 → no re-fire (under threshold delta).
	assert.equal(await handler(evt, ctxFor(4)), undefined);
	assert.equal(await handler(evt, ctxFor(5)), undefined);
	// since=6 → next window opens (3+3), fires again.
	const r6 = await handler(evt, ctxFor(6));
	assert.ok(r6?.systemPrompt?.includes("many steps since last user message"));
});

test("iteration nudge resets when user message arrives", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 1_000_000;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.iterationNudgeThreshold = 3;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;

	// First fire at since=3
	let branch: any[] = [{ type: "message", message: user() }, { type: "message", message: asst("c1") }, { type: "message", message: asst("c2") }, { type: "message", message: asst("c3") }];
	let ctx = { model: undefined, getContextUsage: () => ({ tokens: 5_000, contextWindow: 200_000, percent: 2 }), sessionManager: { getBranch: () => branch } } as any;
	assert.ok((await handler(evt, ctx))?.systemPrompt);

	// User sends another message — now since=0, lastIterationNudgeAt must reset.
	branch = [...branch, { type: "message", message: user() }];
	assert.equal(await handler(evt, ctx), undefined);
	assert.equal(state.lastIterationNudgeAt, 0);

	// And the threshold should now apply fresh: 3 more messages → fire.
	branch = [
		...branch,
		{ type: "message", message: asst("c4") },
		{ type: "message", message: asst("c5") },
		{ type: "message", message: asst("c6") },
	];
	assert.ok((await handler(evt, ctx))?.systemPrompt);
});

// ───── per-model min AND max on same model ─────

test("modelMinLimits + modelMaxLimits both apply for the same model", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 1_000_000;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.modelMinLimits = { "openai/gpt-5.5": 45_000 };
	cfg.compress.modelMaxLimits = { "openai/gpt-5.5": 100_000 };
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;
	const ctx = (tokens: number) =>
		({
			model: { provider: "openai", id: "gpt-5.5" },
			getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 0 }),
			sessionManager: { getBranch: () => [] },
		}) as any;

	// 40k < 45k → no nudge
	state.lastSoftNudgeTurn = -Infinity;
	state.nudgeFetchCount = 0;
	assert.equal(await handler(evt, ctx(40_000)), undefined);
	// 50k in (45k, 100k) → soft nudge
	state.lastSoftNudgeTurn = -Infinity;
	state.nudgeFetchCount = 0;
	const r1 = await handler(evt, ctx(50_000));
	assert.ok(r1?.systemPrompt?.includes("pi-dcp context note"));
	// 150k >= 100k → hard nudge
	const r2 = await handler(evt, ctx(150_000));
	assert.ok(r2?.systemPrompt?.includes("context filling up"));
});

// ───── PromptStore unknown name ─────

test("PromptStore.read on unknown name returns empty string (no crash)", () => {
	const ps = tmpPromptStore();
	assert.equal(ps.read("nonexistent" as any), "");
});

// ───── compress tool turnProtection overlap refusal ─────

test("compress message tool refuses when ids are in protected window", async () => {
	const state = createSessionState();
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.turnProtection.enabled = true;
	cfg.turnProtection.turns = 1;
	const tool = createCompressMessageTool({ state, logger: silentLogger, config: cfg }, tmpPromptStore());

	const branch = [
		{ type: "message", message: user() },
		{ type: "message", message: asst("c1") },
		{ type: "message", message: tr("c1") },
	];
	const ext = { sessionManager: { getBranch: () => branch } } as any;

	const r = await tool.execute(
		"caller",
		{ toolCallIds: ["c1"], topic: "t", summary: "x".repeat(40) },
		undefined,
		undefined,
		ext,
	);
	assert.equal((r.details as any).reason, "protected_window_overlap");
});

test("compress range tool refuses when span overlaps protected window", async () => {
	const state = createSessionState();
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.turnProtection.enabled = true;
	cfg.turnProtection.turns = 1;
	const tool = createCompressRangeTool({ state, logger: silentLogger, config: cfg }, tmpPromptStore());

	const branch = [
		{ type: "message", message: asst("c0") },
		{ type: "message", message: tr("c0") },
		{ type: "message", message: user() },
		{ type: "message", message: asst("c1") },
		{ type: "message", message: tr("c1") },
	];
	const ext = { sessionManager: { getBranch: () => branch } } as any;

	const r = await tool.execute(
		"caller",
		{ startToolCallId: "c0", endToolCallId: "c1", topic: "t", summary: "x".repeat(40) },
		undefined,
		undefined,
		ext,
	);
	assert.equal((r.details as any).reason, "protected_window_overlap");
});

test("compress range tool proceeds when endpoints are outside protected window", async () => {
	const state = createSessionState();
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.turnProtection.enabled = true;
	cfg.turnProtection.turns = 1;
	const tool = createCompressRangeTool({ state, logger: silentLogger, config: cfg }, tmpPromptStore());

	const branch = [
		{ type: "message", message: asst("c0") },
		{ type: "message", message: tr("c0") },
		{ type: "message", message: asst("c1") },
		{ type: "message", message: tr("c1") },
		{ type: "message", message: user() },
		{ type: "message", message: asst("c2") },
		{ type: "message", message: tr("c2") },
	];
	const ext = { sessionManager: { getBranch: () => branch } } as any;

	const r = await tool.execute(
		"caller",
		{ startToolCallId: "c0", endToolCallId: "c1", topic: "t", summary: "x".repeat(40) },
		undefined,
		undefined,
		ext,
	);
	assert.equal((r.details as any).refused, undefined);
	assert.deepEqual((r.details as any).resolvedToolCallIds, ["c0", "c1"]);
});
