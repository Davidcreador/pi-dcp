/** Regression boundaries for immutable goals, lifecycle, provenance and bounded inference. */
import test from "node:test";
import assert from "node:assert/strict";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { JevSelection } from "../lib/jev-selection.ts";
import { PIN_ENTRY, findResult, pinRecord } from "../lib/protection.ts";
import { resultEntries, messagesOf, selectionFixture } from "./_jev-fixtures.ts";

const reply = (model = "jev-1.13.0") => ({ model, probabilities: new Map([["c0", 0.01]]),
	usage: { input_tokens: 100, output_tokens: 10 }, elapsedMs: 1 });

test("actual SDK 0.74 whole-file read output satisfies the bounded source Adapter", async () => {
	const { selector, view } = selectionFixture();
	const result = await createReadTool(view.cwd).execute("old", { path: "source.ts" });
	selector.observe({ toolName: "read", toolCallId: "old", input: { path: "source.ts" }, content: result.content, details: result.details, isError: false }, view.cwd, true);
	assert.equal(await selector.score(view, "Task", async () => true, () => view, async () => reply()), "scored");
});

test("three-turn floor and legacy restores prevent disclosure before inference", async () => {
	const { selector, view } = selectionFixture();
	let calls = 0;
	const infer = async () => { calls++; return reply(); };
	const recent = { ...view, entries: view.entries.slice(0, -1), messages: view.messages.slice(0, -1) };
	assert.equal(await selector.score(recent, "Task", async () => true, () => recent, infer), "no-candidates");
	const restored = { ...view, legacyProtected: new Set(["old"]) };
	assert.equal(await selector.score(restored, "Task", async () => true, () => restored, infer), "no-candidates");
	assert.equal(calls, 0);
});

test("declared truncation is ineligible even when observed text happens to match the file", async () => {
	const { selector, view, text } = selectionFixture();
	selector.observe({ toolName: "read", toolCallId: "old", input: { path: "source.ts" }, content: [{ type: "text", text }],
		isError: false, details: { truncation: { truncated: true } } }, view.cwd, true);
	assert.equal(await selector.score(view, "Task", async () => true, () => view, async () => reply()), "no-candidates");
});

test("shadow judgments retain results and failures never authorize another strategy", async () => {
	const { config, view, text, selector } = selectionFixture();
	const shadow = new JevSelection({ ...config, jev: { ...config.jev, dropBelow: null } });
	shadow.observe({ toolName: "read", toolCallId: "old", input: { path: "source.ts" }, content: [{ type: "text", text }], isError: false }, view.cwd, true);
	assert.equal(await shadow.score(view, "Task", async () => true, () => view, async () => reply()), "scored");
	assert.equal(shadow.policy(view).keep.has("old"), true);
	assert.equal(await selector.score(view, "Task", async () => true, () => view, async () => { throw new Error("fixture timeout"); }), "failed");
	assert.equal(selector.policy(view).omit.has("old"), false);
	assert.equal(await selector.score(view, "Task", async () => true, () => view, async () => reply()), "no-candidates");
});

test("attempt budget survives task resets and does not automatically retry", async () => {
	const { selector, view } = selectionFixture();
	for (let i = 0; i < 4; i++) {
		assert.equal(await selector.score(view, `Task ${i}`, async () => true, () => view, async () => reply()), "scored");
	}
	assert.equal(await selector.score(view, "Another task", async () => { throw new Error("No approval expected"); }, () => view, async () => reply()), "budget");
	assert.equal(selector.stats.attempts, 4);
	assert.equal(selector.policy(view).omit.has("old"), true);
});

test("invalid pins and upstream changes to protected originals retain the entire incoming view", () => {
	const { selector, view } = selectionFixture();
	const original = findResult(view.sessionId, view.entries, "result-old");
	assert.ok(original);
	const entries = [...view.entries, { type: "custom" as const, id: "pin", parentId: "user-2", timestamp: "2026-01-01T00:00:00Z",
		customType: PIN_ENTRY, data: pinRecord("pin", "owner", [original.ref]) }];
	const messages = structuredClone(view.messages);
	const result = messages.find(message => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	result.content = [{ type: "text", text: "another extension changed it" }];
	assert.equal(selector.policy({ ...view, entries, messages }).hold, true);
	assert.equal(selector.policy({ ...view, entries, sessionId: "foreign-fork" }).hold, true);
	assert.equal(selector.policy({ ...view, entries: [entries[entries.length - 1], ...view.entries] }).hold, true, "pin metadata cannot precede its referenced result");
	assert.equal(selector.policy({ ...view, entries: [...view.entries, { ...entries[entries.length - 1], type: "custom", id: "bad", customType: PIN_ENTRY, data: {} }] }).hold, true);
});

test("final guard returns the untouched incoming view if another strategy changes protected data", async () => {
	const { selector, view } = selectionFixture();
	await selector.score(view, "Task", async () => true, () => view, async () => ({
		model: "jev-1.13.0", probabilities: new Map([["c0", 0.9]]),
		usage: { input_tokens: 100, output_tokens: 10 }, elapsedMs: 1 }));
	const policy = selector.policy(view);
	assert.equal(policy.keep.has("old"), true);
	const changed = structuredClone(view.messages);
	const result = changed.find(message => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	result.content = [{ type: "text", text: "incorrectly pruned" }];
	assert.deepEqual(selector.apply(changed, policy, view.messages), view.messages);
	assert.equal(selector.stats.currentEstimatedTokensRemoved, 0);
});

test("resolved model changes cannot reuse an older model's omission decisions", async () => {
	const { selector, view, text } = selectionFixture();
	await selector.score(view, "Task", async () => true, () => view, async () => reply());
	const second = resultEntries("second", text);
	second[0].parentId = "result-old";
	const entries = [...view.entries.slice(0, 2), ...second, ...structuredClone(view.entries.slice(2))];
	entries[4].parentId = "result-second";
	const latest = { ...view, entries, messages: messagesOf(entries) };
	selector.observe({ toolName: "read", toolCallId: "second", input: { path: "source.ts" }, content: [{ type: "text", text }], isError: false }, view.cwd, true);
	await selector.score(latest, "Task", async () => true, () => latest, async () => reply("jev-2.0"));
	assert.equal(selector.policy(latest).keep.has("old"), true);
	assert.equal(selector.policy(latest).keep.has("second"), false);
});
