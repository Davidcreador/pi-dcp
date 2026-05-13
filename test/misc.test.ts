/**
 * Smaller-surface tests for config % resolution, nudge throttling, and the
 * strict integer parser used by /dcp decompress|recompress.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_CONFIG, resolveContextLimit } from "../lib/config.ts";
import { _internal as decompressInternals } from "../lib/commands/decompress.ts";
import { makeNudgeHandler } from "../lib/nudges.ts";
import { createSessionState } from "../lib/state.ts";

test("resolveContextLimit: percentage", () => {
	assert.equal(resolveContextLimit("50%", 200_000), 100_000);
	assert.equal(resolveContextLimit("12.5%", 200_000), 25_000);
});

test("resolveContextLimit: numeric string", () => {
	assert.equal(resolveContextLimit("80000", 200_000), 80_000);
});

test("resolveContextLimit: bare number", () => {
	assert.equal(resolveContextLimit(60_000, 200_000), 60_000);
});

test("resolveContextLimit: junk falls back to contextWindow", () => {
	assert.equal(resolveContextLimit("bogus", 200_000), 200_000);
});

test("resolveContextLimit: zero context window falls back to safe default", () => {
	assert.equal(resolveContextLimit("50%", 0), 100_000);
});

test("parseStrictId rejects junk", () => {
	const p = decompressInternals.parseStrictId;
	assert.equal(p("5"), 5);
	assert.equal(p("0"), undefined);
	assert.equal(p("-1"), undefined);
	assert.equal(p("5abc"), undefined);
	assert.equal(p("abc"), undefined);
	assert.equal(p(""), undefined);
	assert.equal(p("3.5"), undefined);
});

test("soft nudge fires only once every nudgeEveryTurns turns", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 0; // always over the floor
	cfg.compress.maxContextLimit = 1_000_000; // never over the ceiling = soft only
	cfg.compress.nudgeEveryTurns = 3;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state);
	const ctx = {
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
	} as any;
	const evt = { type: "before_agent_start" as const, prompt: "", systemPrompt: "BASE", systemPromptOptions: {} as any };

	state.turnIndex = 0;
	const r0 = await handler(evt, ctx);
	assert.ok(r0?.systemPrompt?.includes("pi-dcp context note"));

	state.turnIndex = 1;
	const r1 = await handler(evt, ctx);
	assert.equal(r1, undefined);

	state.turnIndex = 3;
	const r3 = await handler(evt, ctx);
	assert.ok(r3?.systemPrompt?.includes("pi-dcp context note"));
});

test("hard nudge fires every turn when over maxContextLimit", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 0;
	cfg.compress.maxContextLimit = 50_000;
	const state = createSessionState();
	const handler = makeNudgeHandler(cfg, state);
	const ctx = {
		getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
	} as any;
	const evt = { type: "before_agent_start" as const, prompt: "", systemPrompt: "B", systemPromptOptions: {} as any };

	for (let i = 0; i < 3; i++) {
		state.turnIndex = i;
		const r = await handler(evt, ctx);
		assert.ok(r?.systemPrompt?.includes("context filling up"), `hard nudge missing at turn ${i}`);
	}
});

test("manual mode suppresses nudges", async () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.compress.minContextLimit = 0;
	const state = createSessionState();
	state.manualMode = true;
	const handler = makeNudgeHandler(cfg, state);
	const ctx = {
		getContextUsage: () => ({ tokens: 999_999, contextWindow: 200_000, percent: 99 }),
	} as any;
	const evt = { type: "before_agent_start" as const, prompt: "", systemPrompt: "B", systemPromptOptions: {} as any };
	const r = await handler(evt, ctx);
	assert.equal(r, undefined);
});
