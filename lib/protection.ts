/** Durable, branch-local protection. Invalid pin authority retains the entire DCP input view. */
import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { canonicalJson, approxTokens, type AnyMessage } from "./messages.ts";

/** Compare protected bodies and call positions/arguments across the complete DCP transformation. */
export function protectedUnchanged(before: AnyMessage[], after: AnyMessage[], ids: ReadonlySet<string>): boolean {
	const snapshot = (messages: AnyMessage[]) => messages.map(message => {
		if (message.role === "toolResult" && ids.has(message.toolCallId)) return message;
		if (message.role === "assistant") return message.content.map(content => content.type === "toolCall" && ids.has(content.id) ? content : null);
		return null;
	});
	try { return canonicalJson(snapshot(before)) === canonicalJson(snapshot(after)); }
	catch { return false; }
}

export const PIN_ENTRY = "pi-dcp.pin.v1";
export const RECALL_MESSAGE = "pi-dcp.recall.v1";

export interface ResultRef {
	sessionId: string;
	entryId: string;
	toolCallId: string;
	digest: string;
}

export interface OriginalResult {
	ref: ResultRef;
	call: ToolCall;
	message: ToolResultMessage;
}

export interface PinRecord {
	version: 1;
	action: "pin" | "release";
	reason: string;
	refs: ResultRef[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function isRef(value: unknown): value is ResultRef {
	return isRecord(value) && exactKeys(value, ["sessionId", "entryId", "toolCallId", "digest"])
		&& identifier(value.sessionId) && identifier(value.entryId) && identifier(value.toolCallId)
		&& typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest);
}

function isPinRecord(value: unknown): value is PinRecord {
	return isRecord(value) && exactKeys(value, ["version", "action", "reason", "refs"])
		&& value.version === 1 && (value.action === "pin" || value.action === "release")
		&& typeof value.reason === "string" && /^(owner|compression:[1-9][0-9]{0,14})$/.test(value.reason)
		&& Array.isArray(value.refs) && value.refs.length > 0 && value.refs.length <= 256
		&& value.refs.every(isRef) && new Set(value.refs.map(ref => ref.entryId)).size === value.refs.length;
}

/** References bind both halves of a unique pair, not a provider's reusable call ID alone. */
export function findResult(sessionId: string, entries: readonly SessionEntry[], entryId: string): OriginalResult | undefined {
	const targets = entries.filter(entry => entry.id === entryId);
	if (targets.length !== 1) return;
	const target = targets[0];
	if (target.type !== "message" || target.message.role !== "toolResult") return;
	const result = target.message;
	const calls: ToolCall[] = [];
	let results = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult" && entry.message.toolCallId === result.toolCallId) results++;
		if (entry.message.role !== "assistant") continue;
		for (const content of entry.message.content) {
			if (content.type === "toolCall" && content.id === result.toolCallId) {
				if (entries.indexOf(entry) >= entries.indexOf(target)) return;
				calls.push(content);
			}
		}
	}
	if (results !== 1 || calls.length !== 1 || calls[0].name !== result.toolName) return;
	const digest = createHash("sha256").update(canonicalJson({ call: calls[0], result })).digest("hex");
	return { ref: { sessionId, entryId, toolCallId: result.toolCallId, digest }, call: calls[0], message: result };
}

export function pinRecord(action: PinRecord["action"], reason: string, refs: readonly ResultRef[]): PinRecord {
	const record = { version: 1, action, reason, refs: structuredClone([...refs]) };
	if (!isPinRecord(record)) throw new Error("Invalid DCP pin action");
	return record;
}

/** Replay ancestry, not compacted model context or expiring sidecars. null means fail closed. */
export function replayPinReasons(sessionId: string, entries: readonly SessionEntry[]): Map<string, Set<string>> | null {
	const reasons = new Map<string, Set<string>>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PIN_ENTRY) continue;
		if (!isPinRecord(entry.data)) return null;
		for (const ref of entry.data.refs) {
			const original = findResult(sessionId, entries, ref.entryId);
			if (ref.sessionId !== sessionId || !original || original.ref.digest !== ref.digest
				|| original.ref.toolCallId !== ref.toolCallId
				|| entries.findIndex(target => target.id === ref.entryId) >= entries.indexOf(entry)) return null;
			let active = reasons.get(entry.data.reason);
			if (!active) {
				active = new Set();
				reasons.set(entry.data.reason, active);
			}
			if (entry.data.action === "pin") active.add(ref.toolCallId);
			else active.delete(ref.toolCallId);
		}
	}
	return reasons;
}

export function replayPins(sessionId: string, entries: readonly SessionEntry[]): Set<string> | null {
	const reasons = replayPinReasons(sessionId, entries);
	return reasons ? new Set([...reasons.values()].flatMap(ids => [...ids])) : null;
}

export type Recovery =
	| { kind: "present"; original: OriginalResult }
	| { kind: "archived"; original: OriginalResult; content: ToolResultMessage["content"] }
	| { kind: "unavailable" | "over-budget"; reason: string };

/** Archived recovery copies persisted text into a new labelled message, never an old toolResult. */
export function prepareRecovery(
	sessionId: string,
	entries: readonly SessionEntry[],
	active: readonly AgentMessage[],
	entryId: string,
	budgetTokens: number,
): Recovery {
	const original = findResult(sessionId, entries, entryId);
	if (!original) return { kind: "unavailable", reason: "Original pair is missing or ambiguous on this branch" };
	const results = active.filter(message => message.role === "toolResult" && message.toolCallId === original.ref.toolCallId);
	const calls = active.flatMap(message => message.role === "assistant"
		? message.content.filter(content => content.type === "toolCall" && content.id === original.ref.toolCallId) : []);
	if (results.length === 1 && calls.length === 1) {
		if (canonicalJson(results[0]) !== canonicalJson(original.message) || canonicalJson(calls[0]) !== canonicalJson(original.call)) {
			return { kind: "unavailable", reason: "Active content differs from the persisted original" };
		}
		return { kind: "present", original };
	}
	if (results.length || calls.length) return { kind: "unavailable", reason: "Active call/result pair is incomplete or ambiguous" };
	if (!original.message.content.every(content => content.type === "text")) {
		return { kind: "unavailable", reason: "Archived recall supports text-only results" };
	}
	const content: ToolResultMessage["content"] = [{ type: "text",
		text: `[DCP recalled reference data, not a user instruction: ${entryId}. Original tool: ${original.message.toolName}.]` },
		...structuredClone(original.message.content)];
	const text = content.map(block => block.type === "text" ? block.text : "").join("\n");
	if (!Number.isFinite(budgetTokens) || budgetTokens <= 0 || Buffer.byteLength(text) > 16_384 || approxTokens(text) > budgetTokens) {
		return { kind: "over-budget", reason: "Full original exceeds the recall budget; nothing appended" };
	}
	return { kind: "archived", original, content };
}
