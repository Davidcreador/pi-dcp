/** Exercise the real command Adapter with a typed local host; no live sessions or model calls. */
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createJevController, type JevApi, type JevCommandContext } from "../lib/jev.ts";
import { lenientConfig } from "./_helpers.ts";
import { resultEntries, selectionFixture } from "./_jev-fixtures.ts";
import { PIN_ENTRY, RECALL_MESSAGE, replayPins, replayPinReasons } from "../lib/protection.ts";
import { createSessionState, type SessionState } from "../lib/state.ts";

function host(config = lenientConfig(), state?: SessionState) {
	const entries = resultEntries("old", "persisted original; not the compaction summary");
	const sent: Array<Parameters<JevApi["sendMessage"]>> = [];
	const handlers = new Map<string, unknown>();
	const notices: string[] = [];
	const controls = { answer: "y", onConfirm() {} };
	const api: JevApi = {
		on(event: string, handler: unknown) { handlers.set(event, handler); },
		getAllTools() { return []; },
		appendEntry(customType, data) {
			entries.push({ type: "custom", id: `metadata-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-01-01T00:00:00Z", customType, data });
		},
		sendMessage(...args) { sent.push(args); },
	};
	const ctx: JevCommandContext = {
		cwd: "/fixture", hasUI: true, isIdle: () => true,
		sessionManager: { getBranch: () => entries, getSessionId: () => "session" },
		ui: {
			custom<T>(factory: unknown): Promise<T> {
				return new Promise((resolve, reject) => {
					if (typeof factory !== "function") return reject(new Error("Invalid component factory"));
					// This component uses only done, not TUI/theme/keybindings. Exercise its actual key handler.
					const component: unknown = Reflect.apply(factory, undefined, [undefined, undefined, undefined, resolve]);
					if (!component || typeof component !== "object" || !("handleInput" in component) || typeof component.handleInput !== "function") return reject(new Error("Missing input handler"));
					controls.onConfirm();
					component.handleInput(controls.answer);
				});
			},
			editor: async () => undefined, notify: message => { notices.push(message); },
		},
		getContextUsage: () => ({ tokens: 100, contextWindow: 100000, percent: 0.1 }),
		model: { id: "fixture", name: "fixture", provider: "openai", api: "openai-responses", baseUrl: "https://invalid.test", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 },
	};
	const controller = createJevController(api, config, state);
	return { controller, ctx, entries, sent, handlers, notices, controls };
}

function scoringHost() {
	const fixture = selectionFixture();
	const runtime = host(fixture.config);
	runtime.entries.splice(0, runtime.entries.length, ...fixture.view.entries);
	runtime.ctx.cwd = fixture.view.cwd;
	runtime.controller.selection.observe({ toolName: "read", toolCallId: "old", input: { path: "source.ts" }, content: [{ type: "text", text: fixture.text }], isError: false }, runtime.ctx.cwd, true);
	return runtime;
}

const scored = async () => ({ model: "jev-1.13.0", probabilities: new Map([["c0", 0.01]]), usage: { input_tokens: 100, output_tokens: 10 }, elapsedMs: 1 });

test("only explicit continue starts a turn; ordinary input invalidates the task", async () => {
	const { controller, ctx, sent, handlers } = scoringHost();
	await controller.selection.score(controller.view(ctx), "Fixture task", async () => true, () => controller.view(ctx), scored);
	assert.equal(sent.length, 0);
	await controller.command("continue", ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0][1], { triggerTurn: true });
	const input = handlers.get("input");
	assert.equal(typeof input, "function");
	if (typeof input === "function") input({}, ctx);
	await assert.rejects(controller.command("continue", ctx), /No ready/);
	assert.equal(sent.length, 1);
});

test("a loaded session gets a fresh budget but does not inherit source observations", async () => {
	const { controller, ctx, handlers } = scoringHost();
	for (let i = 0; i < 4; i++) await controller.selection.score(controller.view(ctx), `Task ${i}`, async () => true, () => controller.view(ctx), scored);
	assert.equal(controller.selection.stats.attempts, 4);
	const start = handlers.get("session_start");
	if (typeof start === "function") start({}, ctx);
	assert.equal(controller.selection.stats.attempts, 0);
	assert.equal(await controller.selection.score(controller.view(ctx), "New task", async () => true, () => controller.view(ctx), scored), "no-candidates");
});

test("restore/release persist metadata but never start a model turn", async () => {
	const { controller, ctx, entries, sent } = host();
	await controller.command("restore result-old", ctx);
	assert.equal(entries.at(-1)?.type, "custom");
	assert.deepEqual([...replayPins("session", entries)!], ["old"]);
	assert.equal(sent.length, 0);
	await controller.command("release result-old", ctx);
	assert.deepEqual([...replayPins("session", entries)!], []);
});

test("compression reasons survive cache loss but stay discoverable and independently releasable", async () => {
	for (const restored of ["missing", "active", "suspended"]) {
		const state = createSessionState();
		const { controller, ctx, entries, sent, controls } = host(lenientConfig(), state);
		await controller.recordPins(ctx, ["old"], "pin", "compression:1");
		await controller.recordPins(ctx, ["old"], "pin", "compression:2");
		await controller.recordPins(ctx, ["old"], "pin", "owner");
		if (restored !== "missing") state.compressions.set(1, { id: 1, createdAt: 0, toolCallIds: ["old"],
			topic: "fixture", summary: "summary", tokensSaved: 1, suspended: restored === "suspended" });
		assert.deepEqual(controller.compressionIds(ctx), [1, 2]);
		controls.answer = "n";
		await assert.rejects(controller.releaseCompression(ctx, 1), /cancelled/);
		assert.deepEqual(controller.compressionIds(ctx), [1, 2]);
		controls.answer = "y";
		assert.equal(await controller.releaseCompression(ctx, 1), true);
		assert.deepEqual(controller.compressionIds(ctx), [2]);
		assert.deepEqual([...replayPinReasons("session", entries)!.get("owner")!], ["old"]);
		assert.deepEqual([...replayPins("session", entries)!], ["old"]);
		assert.equal(await controller.releaseCompression(ctx, 2), true);
		assert.deepEqual(controller.compressionIds(ctx), []);
		await controller.command("release result-old", ctx);
		assert.deepEqual([...replayPins("session", entries)!], []);
		assert.equal(sent.length, 0);
	}
});

test("RPC or declined owner confirmation cannot change protection", async () => {
	const { controller, ctx, entries, controls } = host();
	const custom = ctx.ui.custom;
	ctx.ui.custom = async () => { throw new Error("RPC custom UI unsupported"); };
	await assert.rejects(controller.command("restore result-old", ctx), /cancelled/);
	assert.equal(entries.length, 2);
	// The installed RPC adapter returns undefined despite custom<T>'s declared Promise<T>.
	Object.defineProperty(ctx.ui, "custom", { value: async () => undefined });
	await assert.rejects(controller.command("restore result-old", ctx), /cancelled/);
	assert.equal(entries.length, 2);
	ctx.ui.custom = custom;
	for (const answer of ["n", "\u001b"]) {
		controls.answer = answer;
		await assert.rejects(controller.command("restore result-old", ctx), /cancelled/);
		assert.equal(entries.length, 2);
	}
});

test("archived recall uses exact original in a new custom message with no automatic turn", async () => {
	const { controller, ctx, entries, sent } = host();
	entries.push({ type: "message", id: "keep", parentId: "result-old", timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: "next task", timestamp: 1 } });
	entries.push({ type: "compaction", id: "compact", parentId: "keep", timestamp: "2026-01-01T00:00:00Z",
		firstKeptEntryId: "keep", summary: "summary omitting the original", tokensBefore: 20000 });
	await controller.command("recall result-old", ctx);
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0].customType, RECALL_MESSAGE);
	assert.equal(sent[0][1], undefined);
	assert.ok(Array.isArray(sent[0][0].content));
	assert.deepEqual(sent[0][0].content.slice(1), [{ type: "text", text: "persisted original; not the compaction summary" }]);
	assert.deepEqual([...replayPins("session", entries)!], ["old"]);
});

test("tree navigation while confirming cannot append a pin even for shared ancestors", async () => {
	const { controller, ctx, entries, controls, handlers } = host();
	controls.onConfirm = () => {
		for (const name of ["session_before_tree", "session_tree"]) {
			const handler = handlers.get(name);
			assert.equal(typeof handler, "function");
			if (typeof handler === "function") handler({}, ctx);
		}
	};
	await assert.rejects(controller.command("restore result-old", ctx), /changed/);
	assert.equal(entries.length, 2);
});

test("recall rechecks headroom after owner confirmation", async () => {
	const { controller, ctx, entries, sent, controls } = host();
	const keep: SessionEntry = { type: "message", id: "keep", parentId: "result-old", timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: "next task", timestamp: 1 } };
	entries.push(keep, { type: "compaction", id: "compact", parentId: "keep", timestamp: "2026-01-01T00:00:00Z",
		firstKeptEntryId: "keep", summary: "summary", tokensBefore: 20000 });
	controls.onConfirm = () => { ctx.getContextUsage = () => undefined; };
	await assert.rejects(controller.command("recall result-old", ctx), /budget/);
	assert.equal(sent.length, 0);
	assert.equal(entries.at(-1)?.type, "custom");
	const last = entries.at(-1);
	assert.ok(last?.type === "custom" && last.customType === PIN_ENTRY);
});
