/** Selection tests use exact synthetic files and mocked inference; no credentials or live requests. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { JevSelection, type SelectionView } from "../lib/jev-selection.ts";
import { PIN_ENTRY, findResult, pinRecord } from "../lib/protection.ts";
import { resultEntries, messagesOf, selectionFixture as fixture } from "./_jev-fixtures.ts";

const lowScore = async () => ({ model: "jev-1.13.0", probabilities: new Map([["c0", 0.01]]), usage: { input_tokens: 100, output_tokens: 10 }, elapsedMs: 1 });

test("disabled, unknown, declined and no-candidate paths perform zero inference", async () => {
	const { view, config, selector } = fixture();
	let calls = 0;
	const infer = async () => { calls++; return lowScore(); };
	assert.equal(await selector.score(view, "Fix parser", async () => false, () => view, infer), "declined");
	assert.equal(calls, 0);
	config.jev.enabled = false;
	const disabled = new JevSelection(config);
	assert.equal(await disabled.score(view, "Fix parser", async () => true, () => view, infer), "disabled");
	assert.equal(calls, 0);
	assert.equal(await new JevSelection({ ...config, jev: { ...config.jev, enabled: true } }).score(view, "Fix parser", async () => true, () => view, infer), "no-candidates");
	assert.equal(calls, 0);
});

test("one approved batch scores once, omits only its body, and repeated hooks do not recount inference", async () => {
	const { selector, view, text } = fixture();
	const original = structuredClone(view.messages);
	let requests = 0;
	await selector.score(view, "Fix parser", async preview => {
		const payload = JSON.parse(preview);
		assert.deepEqual(Object.keys(payload.state), ["task", "candidates"]);
		assert.equal(payload.state.candidates[0].text, text);
		assert.ok(!preview.includes(view.cwd));
		assert.ok(!preview.includes("arguments"));
		return true;
	}, () => view, async () => { requests++; return lowScore(); });
	const policy = selector.policy(view);
	assert.equal(policy.hold, false);
	assert.equal(policy.keep.has("old"), false);
	const output = selector.apply(view.messages, policy);
	assert.deepEqual(output[0], original[0]);
	assert.notDeepEqual(output[1], original[1]);
	assert.deepEqual(view.messages, original);
	const saved = selector.stats.currentEstimatedTokensRemoved;
	assert.ok(saved > 0);
	selector.apply(view.messages, selector.policy(view));
	assert.equal(selector.stats.currentEstimatedTokensRemoved, saved);
	assert.equal(await selector.score(view, "Fix parser", async () => true, () => view, lowScore), "no-candidates");
	assert.equal(requests, 1);
});

test("pins, source changes and input invalidation defeat low scores", async () => {
	const { selector, view } = fixture();
	await selector.score(view, "Fix parser", async () => true, () => view, lowScore);
	const original = findResult(view.sessionId, view.entries, "result-old");
	assert.ok(original);
	const pinned: SelectionView = { ...view, entries: [...view.entries, { type: "custom", id: "pin", parentId: "result-old", timestamp: "2026-01-01T00:00:00Z", customType: PIN_ENTRY, data: pinRecord("pin", "owner", [original.ref]) }] };
	assert.equal(selector.policy(pinned).keep.has("old"), true);
	writeFileSync(join(view.cwd, "source.ts"), "different source");
	assert.equal(selector.policy(view).keep.has("old"), true);
	selector.invalidate();
	assert.equal(selector.policy(view).keep.has("old"), true);
});

test("a new explicit brief invalidates previous-task scores even when the new disclosure is declined", async () => {
	const { selector, view } = fixture();
	await selector.score(view, "First task", async () => true, () => view, lowScore);
	assert.equal(selector.policy(view).keep.has("old"), false);
	assert.equal(await selector.score(view, "Different task", async () => false, () => view, lowScore), "declined");
	assert.equal(selector.policy(view).keep.has("old"), true);
});

test("late responses and changed payload scope stay retained", async () => {
	const { selector, view } = fixture();
	let resolve!: (value: Awaited<ReturnType<typeof lowScore>>) => void;
	const response = new Promise<Awaited<ReturnType<typeof lowScore>>>(done => { resolve = done; });
	const pending = selector.score(view, "Fix parser", async () => true, () => view, async () => response);
	await new Promise(done => setImmediate(done));
	selector.invalidate();
	resolve(await lowScore());
	assert.equal(await pending, "stale");
	assert.deepEqual(selector.apply(view.messages, selector.policy(view)), view.messages);
});

test("partial, overridden, instruction-bearing, symlinked and unmatched output is ineligible", async () => {
	const { config, view, text } = fixture();
	for (const [input, content, builtin] of [
		[{ path: "source.ts", limit: 1 }, text, true],
		[{ path: "source.ts" }, "altered " + text, true],
		[{ path: "source.ts" }, text, false],
	] as const) {
		const selector = new JevSelection(config);
		selector.observe({ toolName: "read", toolCallId: "old", input, content: [{ type: "text", text: content }], isError: false }, view.cwd, builtin);
		assert.equal(await selector.score(view, "Fix parser", async () => true, () => view, lowScore), "no-candidates");
	}
	writeFileSync(join(view.cwd, "AGENTS.md"), text);
	symlinkSync(join(view.cwd, "source.ts"), join(view.cwd, "alias.ts"));
	for (const file of ["AGENTS.md", "alias.ts"]) {
		const selector = new JevSelection({ ...config, jev: { ...config.jev, files: [file] } });
		selector.observe({ toolName: "read", toolCallId: "old", input: { path: file }, content: [{ type: "text", text }], isError: false }, view.cwd, true);
		const entries = resultEntries("old", text, false, file);
		const matching = { ...view, entries: [...entries, ...view.entries.slice(2)], messages: [...messagesOf(entries), ...view.messages.slice(2)] };
		assert.equal(await selector.score(matching, "Fix parser", async () => true, () => matching, lowScore), "no-candidates");
	}
});
