/** Invoke the loaded production handlers with a real host SessionManager and explicit local UI/action adapters. */
import assert from "node:assert/strict";

/**
 * @param {import("@earendil-works/pi-coding-agent").LoadExtensionsResult} loaded
 * @param {import("@earendil-works/pi-coding-agent").SessionManager} session
 * @param {() => Promise<import("@earendil-works/pi-coding-agent").LoadExtensionsResult>} reload
 * @param {boolean} savedActive
 */
export async function exerciseHost(loaded, session, reload, savedActive) {
	let extension = loaded.extensions[0];
	let answer = "y";
	/** @type {string[]} */
	const notices = [];
	let sends = 0;
	const text = "const synthetic = 'persisted original';\n".repeat(30);
	const ctx = {
		cwd: process.cwd(), hasUI: true, sessionManager: session, isIdle: () => true,
		model: { contextWindow: 100000 },
		getContextUsage: () => ({ tokens: 100, contextWindow: 100000, percent: 0.1 }),
		ui: {
			/** @param {string} message */
			notify(message) { notices.push(message); },
			setStatus() {},
			/** @param {unknown} factory @param {{ overlay?: boolean }} [options] */
			async custom(factory, options) {
				if (!options?.overlay && answer === "rpc") return undefined;
				assert.ok(typeof factory === "function");
				return new Promise(resolve => {
					const theme = {
						/** @param {string} _color @param {string} value */
						fg: (_color, value) => value,
						/** @param {string} value */
						bold: value => value,
					};
					const component = Reflect.apply(factory, undefined, [{ requestRender() {} }, theme, undefined, resolve]);
					if (options?.overlay) { notices.push(component.render(100).join("\n")); resolve(undefined); }
					else component.handleInput(answer);
				});
			},
		},
	};
	/** @param {import("@earendil-works/pi-coding-agent").LoadExtensionsResult} result */
	function bind(result) {
		extension = result.extensions[0];
		result.runtime.appendEntry = (type, data) => { session.appendCustomEntry(type, data); };
		result.runtime.sendMessage = (message, options) => {
			assert.notEqual(options?.triggerTurn, true);
			sends++;
			session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		};
	}
	/** @param {string} type @param {Record<string, unknown>} [fields] */
	async function emit(type, fields = {}) {
		const results = [];
		for (const handler of extension.handlers.get(type) ?? []) results.push(await Reflect.apply(handler, undefined, [{ type, ...fields }, ctx]));
		return results;
	}
	/** @param {string} args */
	async function command(args) {
		const command = extension.commands.get("dcp");
		assert.ok(command);
		await Reflect.apply(command.handler, undefined, [args, ctx]);
	}
	/** @returns {Promise<unknown[]>} */
	async function requestView() {
		const original = session.buildSessionContext().messages;
		const snapshot = structuredClone(original);
		const results = await emit("context", { messages: original });
		assert.deepEqual(original, snapshot, "registered pipeline mutated the original host context");
		for (const result of results) {
			if (result && typeof result === "object" && "messages" in result) {
				assert.ok(Array.isArray(result.messages));
				return result.messages;
			}
		}
		return original;
	}
	/** @param {string} id */
	function pair(id) {
		session.appendMessage({ role: "assistant", timestamp: 0, api: "openai-responses", provider: "openai", model: "fixture",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "source.ts" } }], stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		return session.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 });
	}
	bind(loaded);
	await emit("session_start", { reason: "startup" });
	const resultId = pair("old");
	pair("new");
	for (let i = 0; i < 3; i++) session.appendMessage({ role: "user", content: `synthetic turn ${i}`, timestamp: i + 1 });
	const original = session.buildSessionContext().messages;
	assert.notDeepEqual(await requestView(), original, "ordinary dedup must be exercised");
	const compress = extension.tools.get("compress");
	assert.ok(compress);
	const compressed = await Reflect.apply(compress.definition.execute, undefined, ["compress-fixture",
		{ startToolCallId: "old", endToolCallId: "old", topic: "fixture", summary: "Synthetic complete summary for the archived fixture." }, undefined, undefined, ctx]);
	assert.equal(compressed.details?.compressionId, 1);
	if (savedActive) await emit("agent_end", { messages: [] });
	await command("decompress 1");
	assert.deepEqual(await requestView(), original, "registered decompression must protect originals");

	// Reload the extension without shutdown/agent_end: durable branch data survives, the unsaved sidecar does not.
	loaded = await reload();
	assert.deepEqual(loaded.errors, []);
	bind(loaded);
	await emit("session_start", { reason: "reload" });
	await command("recompress");
	assert.ok(notices.at(-1)?.includes("#1"), "lost-sidecar protection must remain discoverable");
	answer = "rpc";
	const count = session.getBranch().length;
	await assert.rejects(command("recompress 1"), /cancelled/);
	assert.equal(session.getBranch().length, count, "unsupported RPC UI must not append a release");
	assert.deepEqual(await requestView(), original);
	answer = "y";
	await command("recompress 1");
	assert.notDeepEqual(await requestView(), original, "cache-loss recompress must release durable protection");

	const kept = session.appendMessage({ role: "user", content: "after compaction", timestamp: 10 });
	const compact = session.appendCompaction("Synthetic summary without original reads", kept, 20000);
	await emit("session_compact", { compactionEntry: session.getEntry(compact), fromExtension: false });
	const compacted = await requestView();
	assert.deepEqual(compacted, session.buildSessionContext().messages);
	assert.equal(session.buildSessionContext().messages.some(message => message.role === "toolResult" && message.toolCallId === "old"), false);
	await command(`jev recall ${resultId}`);
	assert.equal(sends, 1);
	const recalled = await requestView();
	const entry = session.getBranch().at(-1);
	assert.ok(entry?.type === "custom_message" && entry.customType === "pi-dcp.recall.v1");
	assert.ok(Array.isArray(entry.content));
	assert.deepEqual(entry.content[1], { type: "text", text });
	assert.deepEqual(recalled.at(-1), session.buildSessionContext().messages.at(-1));
	await emit("agent_end", { messages: [] });
	await emit("session_shutdown");
	console.log(`HOST_INTEGRATION_PASS (${savedActive ? "stale active sidecar" : "missing sidecar"}): context, native decompression, reload, RPC refusal, recompression, compaction, exact recall, shutdown; no model turn`);
}
