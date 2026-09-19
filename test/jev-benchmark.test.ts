/** Mechanical comparison only: injected judgments cannot establish accuracy, provider cost or cache savings. */
import test from "node:test";
import assert from "node:assert/strict";
import { approxTokens } from "../lib/messages.ts";
import { findResult, pinRecord, PIN_ENTRY } from "../lib/protection.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { createSessionState } from "../lib/state.ts";
import { messagesOf, resultEntries, selectionFixture } from "./_jev-fixtures.ts";

const logger = { info() {} };

test("Jev scope leaves ordinary DCP active elsewhere while preserving independent pins", () => {
	const { selector, view, config, text } = selectionFixture();
	const duplicate = resultEntries("duplicate", text);
	duplicate[0].parentId = "user-2";
	const entries = [...view.entries, ...duplicate];
	const outside = { ...view, cwd: selectionFixture().view.cwd, entries, messages: messagesOf(entries) };
	const baseline = runPipeline(outside.messages, config, createSessionState(), logger).messages;
	assert.notDeepEqual(baseline, outside.messages);
	const policy = selector.policy(outside);
	assert.equal(policy.hold, false);
	assert.equal(policy.keep.size, 0);
	assert.equal(policy.omit.size, 0);
	assert.deepEqual(selector.apply(runPipeline(outside.messages, config, createSessionState(), logger, policy.keep).messages, policy, outside.messages), baseline);

	const original = findResult(view.sessionId, entries, "result-old");
	assert.ok(original);
	entries.push({ type: "custom", id: "pin", parentId: "result-duplicate", timestamp: "2026-01-01T00:00:00Z",
		customType: PIN_ENTRY, data: pinRecord("pin", "owner", [original.ref]) });
	const pinned = selector.policy({ ...outside, legacyProtected: new Set(["legacy"]) });
	assert.equal(pinned.hold, false);
	assert.deepEqual([...pinned.keep], ["old", "legacy"]);
	assert.deepEqual(selector.apply(runPipeline(outside.messages, config, createSessionState(), logger, pinned.keep).messages, pinned, outside.messages), outside.messages);
});

test("unresolvable Jev project scope holds pruning closed", () => {
	const { selector, view } = selectionFixture();
	assert.equal(selector.policy({ ...view, cwd: `${view.cwd}/absent` }).hold, true);
	assert.equal(selector.stats.protectionBlocked, true);
});

test("fixture comparison measures both potential reduction and conservative retention overhead", async t => {
	for (const scenario of ["approved-obsolete", "unapproved-duplicate"]) {
		const { selector, view, config, text } = selectionFixture();
		const critical = resultEntries("critical", "REQUIRED_EVIDENCE: preserve this exact result", false, "AGENTS.md");
		critical[0].parentId = "user-2";
		const entries = [...view.entries, ...critical];
		if (scenario === "unapproved-duplicate") {
			const duplicate = resultEntries("duplicate", text);
			duplicate[0].parentId = "result-critical";
			entries.push(...duplicate);
			selector.invalidate(true);
		}
		const current = { ...view, entries, messages: messagesOf(entries) };
		const original = structuredClone(current.messages);
		let requests = 0;
		await selector.score(current, "Work on the parser; preserve required evidence", async () => true, () => current, async request => {
			requests++;
			return { model: "jev-fixture", probabilities: new Map(request.state.candidates.map(candidate => [candidate.id, 0.01])),
				usage: { input_tokens: 0, output_tokens: 0 }, elapsedMs: 0 };
		});
		const dcpStarted = performance.now();
		const baseline = runPipeline(current.messages, config, createSessionState(), logger).messages;
		const dcpMs = performance.now() - dcpStarted;
		const jevStarted = performance.now();
		const policy = selector.policy(current);
		const protectedIds = new Set([...policy.keep, ...policy.omit.keys()]);
		const selected = selector.apply(runPipeline(current.messages, config, createSessionState(), logger, protectedIds).messages, policy, current.messages);
		const jevMs = performance.now() - jevStarted;
		assert.deepEqual(current.messages, original);
		assert.deepEqual(selected.find(message => message.role === "toolResult" && message.toolCallId === "critical"), messagesOf(critical)[1]);
		const counts = { original: approxTokens(JSON.stringify(original)), currentDcp: approxTokens(JSON.stringify(baseline)), proposed: approxTokens(JSON.stringify(selected)) };
		if (scenario === "approved-obsolete") assert.ok(counts.proposed < counts.currentDcp);
		// Unscored duplicates are no longer Jev-protected: deterministic dedup
		// removes them in both pipelines, so the proposals tie.
		else assert.equal(counts.proposed, counts.currentDcp);
		t.diagnostic(JSON.stringify({ schema: "jev-fixture-comparison/v1", scenario, serializedFixtureTokenEstimates: counts,
			singleRunTransformMs: { currentDcp: dcpMs, proposed: jevMs }, mockedRequests: requests, protectedFixturePreserved: true,
			realAccuracyCostCacheAndWorkflowLatency: "not measured" }));
	}
});
