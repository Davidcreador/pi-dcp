/** Complete SDK message fixtures; no live session data. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevSelection, type SelectionView } from "../lib/jev-selection.ts";
import { lenientConfig } from "./_helpers.ts";

export function resultEntries(id: string, text = "original", isError = false, file = "source.ts"): SessionEntry[] {
	return [{
		type: "message", id: `call-${id}`, parentId: null, timestamp: "2026-01-01T00:00:00Z",
		message: {
			role: "assistant", timestamp: 0, api: "openai-responses", provider: "openai", model: "fixture",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: file } }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
		},
	}, {
		type: "message", id: `result-${id}`, parentId: `call-${id}`, timestamp: "2026-01-01T00:00:00Z",
		message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }],
			isError, timestamp: 0 },
	}];
}

export const messagesOf = (entries: SessionEntry[]) => entries.flatMap(e => e.type === "message" ? [e.message] : []);

export function selectionFixture() {
	const cwd = mkdtempSync(join(tmpdir(), "jev-source-"));
	const text = "const obsolete = 'unused';\n".repeat(40);
	writeFileSync(join(cwd, "source.ts"), text);
	const entries = resultEntries("old", text);
	for (let i = 0; i < 3; i++) entries.push({ type: "message", id: `user-${i}`, parentId: i ? `user-${i - 1}` : "result-old",
		timestamp: "2026-01-01T00:00:00Z", message: { role: "user", timestamp: i + 1, content: "fixture turn" } });
	const view: SelectionView = { sessionId: "session", cwd, entries, messages: messagesOf(entries) };
	const config = lenientConfig();
	config.jev = { enabled: true, project: cwd, files: ["source.ts"], dropBelow: 0.05 };
	const selector = new JevSelection(config);
	selector.observe({ toolName: "read", toolCallId: "old", input: { path: "source.ts" }, content: [{ type: "text", text }], isError: false }, cwd, true);
	return { selector, view, config, text };
}
