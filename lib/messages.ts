/**
 * Helpers for inspecting and mutating the AgentMessage stream that the
 * `context` event hands us before each LLM call.
 *
 * Critical invariants:
 *
 * 1. Every ToolCall in an assistant message MUST be matched by exactly one
 *    ToolResultMessage immediately after it. When we "prune" a tool we
 *    therefore REPLACE the content of the ToolResultMessage with a short
 *    placeholder, never remove it. Many providers reject orphaned tool calls.
 *
 * 2. The `messages` array we receive contains references to message objects
 *    that the session manager still holds. Mutating them in place corrupts
 *    persisted session entries. ALWAYS clone a message (and any nested
 *    structures we plan to write to) before modifying it, and emit a fresh
 *    array via ContextEventResult.
 *
 * Type shapes mirror @earendil-works/pi-ai. We use structural types instead of
 * importing the full AgentMessage union — that keeps the file self-contained
 * and avoids leaking optional fields the pipeline never inspects.
 */

export interface TextContent {
	type: "text";
	text: string;
	[k: string]: unknown;
}
export interface ImageContent {
	type: "image";
	[k: string]: unknown;
}
export interface ThinkingContent {
	type: "thinking";
	[k: string]: unknown;
}

/** Pi-ai's ToolCall uses `arguments`, not `input`. Critical to get right. */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[k: string]: unknown;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type UserContent = TextContent | ImageContent;
export type ToolResultContent = TextContent | ImageContent;

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
	timestamp: number;
	[k: string]: unknown;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	timestamp: number;
	[k: string]: unknown;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
	[k: string]: unknown;
}

export type AnyMessage = UserMessage | AssistantMessage | ToolResultMessage;

export function isToolResult(m: AnyMessage): m is ToolResultMessage {
	return (m as { role?: string }).role === "toolResult";
}

export function isAssistant(m: AnyMessage): m is AssistantMessage {
	return (m as { role?: string }).role === "assistant";
}

export function isUser(m: AnyMessage): m is UserMessage {
	return (m as { role?: string }).role === "user";
}

export function isToolCall(c: { type?: string }): c is ToolCall {
	return c?.type === "toolCall";
}

/** Iterate all ToolCall entries inside an assistant message's content. */
export function toolCallsOf(m: AssistantMessage): ToolCall[] {
	const out: ToolCall[] = [];
	for (const c of m.content) {
		if (isToolCall(c)) out.push(c);
	}
	return out;
}

/**
 * Canonical JSON serialization for use as a dedup key.
 *
 * Standard `JSON.stringify(obj, keys.sort())` only sorts the TOP level, so
 * `{a:{x:1,y:2}}` and `{a:{y:2,x:1}}` produce different strings. We recurse
 * so nested objects are normalized too. Arrays preserve order (call semantics
 * usually depend on positional args). Cycles and non-JSON values are
 * stringified via `String()`.
 */
export function canonicalJson(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
	if (value === null) return "null";
	const t = typeof value;
	if (t === "string") return JSON.stringify(value);
	if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
	if (t === "boolean") return String(value);
	if (t === "undefined") return "null";
	if (t === "bigint") return JSON.stringify(String(value));
	if (t !== "object") return JSON.stringify(String(value));

	const obj = value as object;
	if (seen.has(obj)) return '"[cycle]"';
	seen.add(obj);

	if (Array.isArray(obj)) {
		return `[${obj.map((v) => canonicalJson(v, seen)).join(",")}]`;
	}
	const keys = Object.keys(obj as Record<string, unknown>).sort();
	const parts: string[] = [];
	for (const k of keys) {
		const v = (obj as Record<string, unknown>)[k];
		if (v === undefined) continue;
		parts.push(`${JSON.stringify(k)}:${canonicalJson(v, seen)}`);
	}
	return `{${parts.join(",")}}`;
}

/** Build a stable key for deduplication: name + canonical JSON of arguments. */
export function toolCallKey(call: { name: string; arguments: Record<string, unknown> }): string {
	return `${call.name}::${canonicalJson(call.arguments)}`;
}

// Use and re-export the real tokenizer from tokens.ts.
import { approxTokens as _approxTokens } from "./tokens.ts";
export { approxTokens } from "./tokens.ts";

/** Approximate token count for a ToolResultMessage's content payload. */
export function toolResultTokens(m: ToolResultMessage): number {
	let n = 0;
	for (const c of m.content) {
		if ((c as TextContent).type === "text") n += _approxTokens((c as TextContent).text);
		else n += 256; // images: rough placeholder cost
	}
	return n;
}

/**
 * Shallow-clone a message AND the inner mutable fields we may rewrite.
 *
 * For assistant messages we clone the content array and every ToolCall (their
 * `arguments` may be rewritten by purgeErrors). For tool result messages we
 * clone the content array (its entries may be replaced with placeholders).
 * Everything else stays a shared reference — cheap and safe because we never
 * write to those fields.
 */
export function cloneForMutation<T extends AnyMessage>(m: T): T {
	if (isToolResult(m)) {
		return { ...m, content: m.content.map((c) => ({ ...c })) } as T;
	}
	if (isAssistant(m)) {
		const content = m.content.map((c) => {
			if (isToolCall(c)) {
				return { ...c, arguments: { ...c.arguments } } as ToolCall;
			}
			return { ...c };
		});
		return { ...m, content } as T;
	}
	return { ...m } as T;
}

const PRUNED_PLACEHOLDER_PREFIX = "[pruned by pi-dcp:";
const COMPRESSION_PLACEHOLDER_PREFIX = "[pi-dcp compression";

/** True if this tool result's content is already a pi-dcp placeholder. Used to keep the pipeline idempotent. */
export function isAlreadyPlaceholder(m: ToolResultMessage): boolean {
	const first = m.content[0] as TextContent | undefined;
	if (!first || first.type !== "text") return false;
	return (
		first.text.startsWith(PRUNED_PLACEHOLDER_PREFIX) ||
		first.text.startsWith(COMPRESSION_PLACEHOLDER_PREFIX)
	);
}

/**
 * Replace a tool result's content with a short placeholder. Returns the
 * estimated tokens removed. Idempotent — if already a placeholder, returns 0.
 * The caller is expected to have cloned `m` already via `cloneForMutation`.
 */
export function placeholderToolResult(m: ToolResultMessage, reason: string): number {
	if (isAlreadyPlaceholder(m)) return 0;
	const before = toolResultTokens(m);
	m.content = [
		{
			type: "text",
			text: `${PRUNED_PLACEHOLDER_PREFIX} ${reason}]`,
		},
	];
	m.details = undefined;
	const after = toolResultTokens(m);
	return Math.max(0, before - after);
}

/**
 * Replace a tool result's content with a compression-summary placeholder.
 * Caller must clone `m` first. The summary itself stays in the per-session
 * compression record; the placeholder gives the model just enough context to
 * recall what was compressed.
 */
export function compressionPlaceholderToolResult(
	m: ToolResultMessage,
	compressionId: number,
	topic: string,
): number {
	if (isAlreadyPlaceholder(m)) return 0;
	const before = toolResultTokens(m);
	m.content = [
		{
			type: "text",
			text: `${COMPRESSION_PLACEHOLDER_PREFIX} #${compressionId}: ${topic}] (see /dcp decompress ${compressionId} to restore)`,
		},
	];
	m.details = undefined;
	const after = toolResultTokens(m);
	return Math.max(0, before - after);
}

export const PURGE_ARGS_MARKER = "[args purged by pi-dcp]";

/**
 * Compute the set of tool-call IDs that fall inside the last `turns` user
 * boundaries (counting newest-first). These IDs must be skipped by every
 * pruning strategy when turnProtection is enabled.
 *
 * Algorithm: walk newest → oldest. Increment a counter on each user message.
 * Once the counter exceeds `turns`, stop — everything beyond is outside the
 * protected window. While the counter is <= `turns`, collect tool-call IDs
 * from every assistant tool call and every tool result we see.
 *
 * `turns <= 0` returns an empty set (protection disabled).
 */
export function protectedByRecency(messages: AnyMessage[], turns: number): Set<string> {
	if (!Number.isFinite(turns) || turns <= 0) return new Set();
	const out = new Set<string>();
	let userCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isUser(m)) {
			userCount++;
			// A user message is the BOUNDARY between turns; everything beyond
			// it (older) belongs to a previous turn we are not protecting.
			if (userCount >= turns) break;
			continue;
		}
		if (isToolResult(m)) {
			out.add(m.toolCallId);
			continue;
		}
		if (isAssistant(m)) {
			for (const c of m.content) {
				if (isToolCall(c)) out.add(c.id);
			}
		}
	}
	return out;
}
