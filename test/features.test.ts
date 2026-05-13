/**
 * Tests for the round-2 features:
 *   - compress range mode (branch-resolved span)
 *   - PromptStore default regeneration + override loading
 *   - manualMode.automaticStrategies toggle
 *   - nudgeFrequency per-request throttle
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
} from "../lib/messages.ts";
import { makeNudgeHandler } from "../lib/nudges.ts";
import { PROMPTS, PromptStore } from "../lib/prompts/index.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { createSessionState } from "../lib/state.ts";
import { createCompressRangeTool } from "../lib/tools/compress-range.ts";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as any;

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function tmpPromptStore(custom = false): PromptStore {
	return new PromptStore({ customPromptsEnabled: custom, promptsDir: tmpDir("pi-dcp-prompts-") });
}

function mkUser(text: string): AnyMessage {
	return { role: "user", content: text, timestamp: 0 };
}
function mkAssistantCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
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

// ───────── PromptStore ─────────

test("PromptStore writes defaults on first use", () => {
	const dir = tmpDir("pi-dcp-prompts-init-");
	new PromptStore({ customPromptsEnabled: false, promptsDir: dir });
	for (const name of Object.values(PROMPTS)) {
		assert.ok(fs.existsSync(path.join(dir, "defaults", `${name}.md`)), `default missing: ${name}`);
	}
	assert.ok(fs.existsSync(path.join(dir, "overrides", "README.md")));
});

test("PromptStore ignores overrides when customPrompts disabled", () => {
	const dir = tmpDir("pi-dcp-prompts-ovr-off-");
	fs.mkdirSync(path.join(dir, "overrides"), { recursive: true });
	fs.writeFileSync(path.join(dir, "overrides", "soft-nudge.md"), "MY OVERRIDE");
	const ps = new PromptStore({ customPromptsEnabled: false, promptsDir: dir });
	assert.notEqual(ps.read("soft-nudge"), "MY OVERRIDE");
});

test("PromptStore honors overrides when customPrompts enabled", () => {
	const dir = tmpDir("pi-dcp-prompts-ovr-on-");
	fs.mkdirSync(path.join(dir, "overrides"), { recursive: true });
	fs.writeFileSync(path.join(dir, "overrides", "soft-nudge.md"), "MY OVERRIDE");
	const ps = new PromptStore({ customPromptsEnabled: true, promptsDir: dir });
	assert.equal(ps.read("soft-nudge"), "MY OVERRIDE");
	assert.ok(ps.hasAnyOverride());
});

// ───────── Range mode ─────────

test("compress range tool resolves span between two endpoints", async () => {
	const state = createSessionState();
	const cfg = structuredClone(DEFAULT_CONFIG);
	const tool = createCompressRangeTool({ state, logger: silentLogger, config: cfg }, tmpPromptStore());

	const branch = [
		{ type: "message", message: mkUser("kick off") },
		{ type: "message", message: mkAssistantCall("c1", "grep", { p: "x" }) },
		{ type: "message", message: mkToolResult("c1", "grep", "...") },
		{ type: "message", message: mkAssistantCall("c2", "grep", { p: "y" }) },
		{ type: "message", message: mkToolResult("c2", "grep", "...") },
		{ type: "message", message: mkAssistantCall("c3", "write", { path: "a" }) },
		{ type: "message", message: mkToolResult("c3", "write", "ok") }, // PROTECTED, excluded
		{ type: "message", message: mkAssistantCall("c4", "read", { path: "b" }) },
		{ type: "message", message: mkToolResult("c4", "read", "data") },
	];
	const ext = { sessionManager: { getBranch: () => branch } } as any;

	const r = await tool.execute(
		"caller",
		{ startToolCallId: "c1", endToolCallId: "c4", topic: "scan", summary: "found things in src/" },
		undefined,
		undefined,
		ext,
	);
	const details = r.details as any;
	assert.equal(details.refused, undefined);
	// c3 (write) is protected; should be skipped. Span = c1, c2, c4.
	assert.deepEqual(details.resolvedToolCallIds, ["c1", "c2", "c4"]);
});

test("compress range tool refuses on unknown endpoint", async () => {
	const state = createSessionState();
	const cfg = structuredClone(DEFAULT_CONFIG);
	const tool = createCompressRangeTool({ state, logger: silentLogger, config: cfg }, tmpPromptStore());
	const branch = [
		{ type: "message", message: mkAssistantCall("c1", "grep", {}) },
		{ type: "message", message: mkToolResult("c1", "grep", "...") },
	];
	const ext = { sessionManager: { getBranch: () => branch } } as any;
	const r = await tool.execute(
		"caller",
		{ startToolCallId: "ghost", endToolCallId: "c1", topic: "t", summary: "summary text for the failing case" },
		undefined,
		undefined,
		ext,
	);
	assert.equal((r.details as any).refused, true);
	assert.equal((r.details as any).reason, "endpoint_not_found");
});

test("compress range tool respects manualMode", async () => {
	const state = createSessionState();
	state.manualMode = true;
	const cfg = structuredClone(DEFAULT_CONFIG);
	const tool = createCompressRangeTool({ state, logger: silentLogger, config: cfg }, tmpPromptStore());
	const r = await tool.execute(
		"caller",
		{ startToolCallId: "a", endToolCallId: "b", topic: "t", summary: "x".repeat(40) },
		undefined,
		undefined,
		{ sessionManager: { getBranch: () => [] } } as any,
	);
	assert.equal((r.details as any).reason, "manual_mode");
});

// ───────── manualMode.automaticStrategies ─────────

test("manualMode.enabled with automaticStrategies=true still runs dedup", () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.manualMode.enabled = true;
	cfg.manualMode.automaticStrategies = true;
	const msgs: AnyMessage[] = [
		mkAssistantCall("c1", "grep", { pattern: "foo" }),
		mkToolResult("c1", "grep", "x"),
		mkAssistantCall("c2", "grep", { pattern: "foo" }),
		mkToolResult("c2", "grep", "x"),
	];
	const r = runPipeline(msgs, cfg, createSessionState(), silentLogger);
	assert.equal(r.dedupPruned, 1);
});

test("manualMode.enabled with automaticStrategies=false suppresses dedup AND purge", () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.manualMode.enabled = true;
	cfg.manualMode.automaticStrategies = false;
	const state = createSessionState();
	state.turnIndex = 10;
	const msgs: AnyMessage[] = [
		mkAssistantCall("c1", "grep", { pattern: "foo" }),
		mkToolResult("c1", "grep", "x"),
		mkAssistantCall("c2", "grep", { pattern: "foo" }),
		mkToolResult("c2", "grep", "x"),
		mkAssistantCall("e1", "bash", { command: "fail" }),
		mkToolResult("e1", "bash", "err", true),
	];
	const r = runPipeline(msgs, cfg, state, silentLogger);
	assert.equal(r.dedupPruned, 0);
	assert.equal(r.errorInputsPurged, 0);
});

test("manualMode.automaticStrategies=false still applies stored compressions", () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.manualMode.enabled = true;
	cfg.manualMode.automaticStrategies = false;
	const state = createSessionState();
	state.compressions.set(1, {
		id: 1,
		createdAt: 0,
		toolCallIds: ["c1"],
		summary: "s",
		topic: "t",
		tokensSaved: 0,
		suspended: false,
	});
	const msgs: AnyMessage[] = [
		mkAssistantCall("c1", "read", { path: "x" }),
		mkToolResult("c1", "read", "original"),
	];
	const r = runPipeline(msgs, cfg, state, silentLogger);
	assert.equal(r.compressionsApplied, 1);
});

// ───────── nudgeFrequency ─────────

test("nudgeFrequency throttles soft nudge to every Nth fetch", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 0;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.nudgeEveryTurns = 1; // turn throttle effectively off
	cfg.compress.nudgeFrequency = 3;
	const state = createSessionState();
	const ps = tmpPromptStore();
	const handler = makeNudgeHandler(cfg, state, ps);
	const ctx = {
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
	} as any;
	const evt = { type: "before_agent_start" as const, prompt: "", systemPrompt: "B", systemPromptOptions: {} as any };

	const results: Array<unknown> = [];
	for (let i = 0; i < 6; i++) {
		state.turnIndex = i; // ensure turn-throttle never short-circuits
		state.lastSoftNudgeTurn = -Infinity;
		results.push(await handler(evt, ctx));
	}
	// fetchCount increments to 1..6. With freq=3, fires at 3 and 6 only.
	const fired = results.filter((r) => r !== undefined);
	assert.equal(fired.length, 2, `expected 2 nudges in 6 fetches, got ${fired.length}`);
});

test("nudgeFrequency=1 is a no-op (every fetch eligible by per-request rule)", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 0;
	cfg.compress.maxContextLimit = 1_000_000;
	cfg.compress.nudgeEveryTurns = 1;
	cfg.compress.nudgeFrequency = 1;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state, tmpPromptStore());
	const ctx = {
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
	} as any;
	const evt = { type: "before_agent_start" as const, prompt: "", systemPrompt: "B", systemPromptOptions: {} as any };

	let fired = 0;
	for (let i = 0; i < 4; i++) {
		state.turnIndex = i;
		state.lastSoftNudgeTurn = -Infinity;
		if (await handler(evt, ctx)) fired++;
	}
	assert.equal(fired, 4);
});
