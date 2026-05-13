/**
 * Tests for the opencode-parity features:
 *   - turnProtection
 *   - modelMinLimits / modelMaxLimits
 *   - iterationNudgeThreshold
 *   - nudgeForce
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, resolveModelLimit } from "../lib/config.ts";
import { lenientConfig } from "./_helpers.ts";
import {
	type AnyMessage,
	type AssistantMessage,
	type ToolResultMessage,
	protectedByRecency,
} from "../lib/messages.ts";
import { makeNudgeHandler } from "../lib/nudges.ts";
import { PromptStore } from "../lib/prompts/index.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { createSessionState } from "../lib/state.ts";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as any;

function tmpPromptStore(): PromptStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-prompts-"));
	return new PromptStore({ customPromptsEnabled: false, promptsDir: dir });
}

function user(): AnyMessage { return { role: "user", content: "x", timestamp: 0 }; }
function asst(id: string, name = "grep", args: any = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 };
}
function tr(id: string, name = "grep", text = "x", isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 };
}

// ──────── turnProtection ────────

test("protectedByRecency: turns=1 protects everything after the last user msg", () => {
	const msgs: AnyMessage[] = [
		user(),
		asst("c1"), tr("c1"),
		user(),
		asst("c2"), tr("c2"),
		asst("c3"), tr("c3"),
	];
	const set = protectedByRecency(msgs, 1);
	assert.deepEqual([...set].sort(), ["c2", "c3"]);
});

test("protectedByRecency: turns=2 spans back across one user boundary", () => {
	const msgs: AnyMessage[] = [
		asst("c0"), tr("c0"),
		user(),
		asst("c1"), tr("c1"),
		user(),
		asst("c2"), tr("c2"),
	];
	const set = protectedByRecency(msgs, 2);
	assert.deepEqual([...set].sort(), ["c1", "c2"]);
});

test("protectedByRecency: turns=0 returns empty set", () => {
	const set = protectedByRecency([user(), asst("c1"), tr("c1")], 0);
	assert.equal(set.size, 0);
});

test("turnProtection prevents dedup of recent turn results", () => {
	// c1 and c2 are identical grep calls (would normally dedup); both inside
	// the protected window. c0 is older and same key — should dedup against
	// nothing because it's the only call outside the window.
	const cfg = lenientConfig();
	cfg.turnProtection.enabled = true;
	cfg.turnProtection.turns = 1;
	const msgs: AnyMessage[] = [
		asst("c0", "grep", { p: "x" }), tr("c0"),
		asst("c1", "grep", { p: "x" }), tr("c1"),
		user(),
		asst("c2", "grep", { p: "x" }), tr("c2"),
	];
	const r = runPipeline(msgs, cfg, createSessionState(), silentLogger);
	// With protection: c2 is protected (after last user). c0 and c1 are NOT
	// protected (before last user). Dedup keeps newest (c1), prunes c0.
	assert.equal(r.dedupPruned, 1);
});

test("turnProtection prevents purgeErrors on recent failed call", () => {
	const cfg = lenientConfig();
	cfg.turnProtection.enabled = true;
	cfg.turnProtection.turns = 1;
	cfg.strategies.purgeErrors.turns = 0; // would normally purge immediately
	const state = createSessionState();
	state.turnIndex = 100;
	const msgs: AnyMessage[] = [
		user(),
		asst("e1", "bash", { command: "long failing command" }),
		tr("e1", "bash", "err", true),
	];
	const r = runPipeline(msgs, cfg, state, silentLogger);
	assert.equal(r.errorInputsPurged, 0);
});

test("turnProtection prevents compression of recent tool result", () => {
	const cfg = lenientConfig();
	cfg.turnProtection.enabled = true;
	cfg.turnProtection.turns = 1;
	const state = createSessionState();
	state.compressions.set(1, {
		id: 1, createdAt: 0, toolCallIds: ["c1"],
		summary: "s", topic: "t", tokensSaved: 0, suspended: false,
	});
	const msgs: AnyMessage[] = [user(), asst("c1", "read", {}), tr("c1", "read", "data")];
	const r = runPipeline(msgs, cfg, state, silentLogger);
	assert.equal(r.compressionsApplied, 0);
});

// ──────── modelMinLimits / modelMaxLimits ────────

test("resolveModelLimit: falls back to global when no override", () => {
	assert.equal(resolveModelLimit("50%", undefined, undefined, 200_000), 100_000);
	assert.equal(resolveModelLimit(60_000, {}, { provider: "openai", id: "gpt-5" }, 200_000), 60_000);
});

test("resolveModelLimit: model override wins", () => {
	const overrides = { "openai/gpt-5.4-mini-fast": 25_000 };
	assert.equal(
		resolveModelLimit(30_000, overrides, { provider: "openai", id: "gpt-5.4-mini-fast" }, 200_000),
		25_000,
	);
});

test("resolveModelLimit: % in override resolved against window", () => {
	const overrides = { "anthropic/claude-sonnet-4.6": "80%" };
	assert.equal(
		resolveModelLimit(30_000, overrides, { provider: "anthropic", id: "claude-sonnet-4.6" }, 200_000),
		160_000,
	);
});

test("nudge uses per-model max override", async () => {
	const cfg = lenientConfig();
	cfg.compress.minContextLimit = 1_000_000; // global far above usage
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.modelMaxLimits = { "openai/gpt-5.4-mini": 50_000 };
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const ctx = {
		model: { provider: "openai", id: "gpt-5.4-mini" },
		getContextUsage: () => ({ tokens: 60_000, contextWindow: 200_000, percent: 30 }),
		sessionManager: { getBranch: () => [] },
	} as any;
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;
	const r = await handler(evt, ctx);
	// 60k > 50k model max → hard nudge fires.
	assert.ok(r?.systemPrompt?.includes("context filling up"));
});

// ──────── iterationNudgeThreshold ────────

test("iterationNudgeThreshold fires after N messages since last user msg", async () => {
	const cfg = lenientConfig();
	cfg.compress.minContextLimit = 1_000_000; // no soft trigger
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.iterationNudgeThreshold = 3;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const branch = [
		{ type: "message", message: user() },
		{ type: "message", message: asst("c1") },
		{ type: "message", message: tr("c1") },
		{ type: "message", message: asst("c2") },
	];
	const ctx = {
		model: undefined,
		getContextUsage: () => ({ tokens: 5_000, contextWindow: 200_000, percent: 2 }),
		sessionManager: { getBranch: () => branch },
	} as any;
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;
	const r = await handler(evt, ctx);
	assert.ok(r?.systemPrompt?.includes("many steps since last user message"));
});

test("iterationNudgeThreshold=0 disables the trigger", async () => {
	const cfg = lenientConfig();
	cfg.compress.minContextLimit = 1_000_000;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.iterationNudgeThreshold = 0;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const branch = new Array(100).fill({ type: "message", message: asst("c1") });
	const ctx = {
		model: undefined,
		getContextUsage: () => ({ tokens: 5_000, contextWindow: 200_000, percent: 2 }),
		sessionManager: { getBranch: () => branch },
	} as any;
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;
	const r = await handler(evt, ctx);
	assert.equal(r, undefined);
});

// ──────── nudgeForce ────────

test("nudgeForce='strong' uses strong-nudge text", async () => {
	const cfg = lenientConfig();
	cfg.compress.minContextLimit = 0;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.nudgeForce = "strong";
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const ctx = {
		model: undefined,
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
		sessionManager: { getBranch: () => [] },
	} as any;
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;
	const r = await handler(evt, ctx);
	assert.ok(r?.systemPrompt?.includes("reduce context usage"));
	assert.ok(!r?.systemPrompt?.includes("context note"));
});

test("nudgeForce='soft' uses soft-nudge text (default)", async () => {
	const cfg = lenientConfig();
	cfg.compress.minContextLimit = 0;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.nudgeForce = "soft";
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const ctx = {
		model: undefined,
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
		sessionManager: { getBranch: () => [] },
	} as any;
	const evt = { type: "before_agent_start", prompt: "", systemPrompt: "B", systemPromptOptions: {} } as any;
	const r = await handler(evt, ctx);
	assert.ok(r?.systemPrompt?.includes("context note"));
	assert.ok(!r?.systemPrompt?.includes("reduce context usage"));
});
