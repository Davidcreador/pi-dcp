/** Protection is shared by every DCP strategy; native compaction never destroys pin authority. */
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { pinRecord, replayPins, findResult, prepareRecovery, PIN_ENTRY } from "../lib/protection.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { createSessionState } from "../lib/state.ts";
import type { Logger } from "../lib/logger.ts";
import { lenientConfig } from "./_helpers.ts";

import { resultEntries, messagesOf } from "./_jev-fixtures.ts";

function actionEntry(id: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: "result-old", timestamp: "2026-01-01T00:00:00Z", customType: PIN_ENTRY, data };
}

const logger: Pick<Logger, "info"> = { info() {} };

test("pin references bind original body, arguments and selected branch", () => {
	const entries = resultEntries("old");
	const original = findResult("session", entries, "result-old");
	assert.ok(original);
	assert.equal(original.ref.toolCallId, "old");
	const changed = structuredClone(entries);
	const call = changed[0];
	if (call.type === "message" && call.message.role === "assistant") {
		const content = call.message.content[0];
		if (content.type === "toolCall") content.arguments.path = "different.ts";
	}
	assert.notEqual(findResult("session", changed, "result-old")?.ref.digest, original.ref.digest);
	assert.equal(findResult("session", entries, "absent"), undefined);
	assert.equal(findResult("session", [...entries, ...entries], "result-old"), undefined);
});

test("pin/release replay is reason-specific and fails closed on corrupt or foreign state", () => {
	const entries = resultEntries("old");
	const original = findResult("session", entries, "result-old");
	assert.ok(original);
	const owner = pinRecord("pin", "owner", [original.ref]);
	const compression = pinRecord("pin", "compression:1", [original.ref]);
	const release = pinRecord("release", "owner", [original.ref]);
	const branch = [...entries, actionEntry("pin1", owner), actionEntry("pin2", compression), actionEntry("release", release)];
	assert.deepEqual([...replayPins("session", branch)!], ["old"]);
	assert.equal(replayPins("other-session", branch), null);
	assert.equal(replayPins("session", [...entries, actionEntry("broken", { ...owner, unexpected: true })]), null);
	assert.equal(replayPins("session", [...resultEntries("old", "changed"), actionEntry("pin", owner)]), null);
	assert.equal(replayPins("session", [actionEntry("orphan", owner)]), null);
});

test("pin authority survives a compaction entry and disappears only on its branch release", () => {
	const entries = resultEntries("old");
	const original = findResult("session", entries, "result-old");
	assert.ok(original);
	const pinned = [...entries, actionEntry("pin", pinRecord("pin", "owner", [original.ref]))];
	pinned.push({ type: "compaction", id: "compact", parentId: "pin", timestamp: "2026-01-01T00:00:00Z",
		summary: "summary without original content", firstKeptEntryId: "compact", tokensBefore: 10000 });
	assert.deepEqual([...replayPins("session", pinned)!], ["old"]);
	assert.deepEqual([...replayPins("session", [...pinned, actionEntry("release", pinRecord("release", "owner", [original.ref]))])!], []);
	assert.deepEqual([...replayPins("session", entries)!], []);
});

test("recovery distinguishes present, archived, corrupted and over-budget results", () => {
	const entries = resultEntries("old", "original beyond a later summary");
	const active = messagesOf(entries);
	assert.equal(prepareRecovery("session", entries, active, "result-old", 0).kind, "present");
	const archived = prepareRecovery("session", entries, [], "result-old", 4096);
	assert.equal(archived.kind, "archived");
	if (archived.kind === "archived") {
		assert.deepEqual(archived.content.slice(1), [{ type: "text", text: "original beyond a later summary" }]);
	}
	assert.equal(prepareRecovery("session", entries, [], "result-old", 0).kind, "over-budget");
	assert.equal(prepareRecovery("session", entries, [], "missing", 4096).kind, "unavailable");
	assert.equal(prepareRecovery("session", entries, active.slice(1), "result-old", 4096).kind, "unavailable");
	const changed = messagesOf(resultEntries("old", "changed by another transformer"));
	assert.equal(prepareRecovery("session", entries, changed, "result-old", 4096).kind, "unavailable");
});

test("shared protection beats duplicate removal, stored compression and errored-input purge", () => {
	const config = lenientConfig();
	const entries = [...resultEntries("old", "critical failure evidence", true), ...resultEntries("new")];
	const original = messagesOf(entries);
	const before = structuredClone(original);
	const state = createSessionState();
	state.turnIndex = 10;
	state.erroredAt.set("old", 0);
	state.compressions.set(1, { id: 1, createdAt: 0, toolCallIds: ["old", "new"], summary: "summary", topic: "topic", tokensSaved: 0, suspended: false });
	const output = runPipeline(original, config, state, logger, new Set(["old"]));
	assert.deepEqual(output.messages.slice(0, 2), original.slice(0, 2));
	assert.deepEqual(original, before);
	assert.notDeepEqual(output.messages[3], original[3]);
	assert.equal(output.errorInputsPurged, 0);
});

test("a suspended legacy compression also protects its targets from dedup and purge", () => {
	const state = createSessionState();
	state.turnIndex = 10;
	state.erroredAt.set("old", 0);
	state.compressions.set(1, { id: 1, createdAt: 0, toolCallIds: ["old"], summary: "summary", topic: "topic", tokensSaved: 0, suspended: true });
	const original = messagesOf([...resultEntries("old", "evidence", true), ...resultEntries("new")]);
	const output = runPipeline(original, lenientConfig(), state, logger);
	assert.deepEqual(output.messages, original);
});
