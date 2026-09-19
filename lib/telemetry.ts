/**
 * Real per-call context accounting.
 *
 * Lives outside messages.ts to avoid the existing messages.ts -> tokens.ts
 * import cycle. The pipeline measures the FULL outgoing message list per
 * model call (not the approxTokens of a summary) and accumulates it on
 * session state.
 */
import { canonicalJson, isAssistant, isToolResult, isUser, type AnyMessage } from "./messages.ts";
import type { SessionState } from "./state.ts";

/** Estimate tokens across the outgoing message list (chars/4; telemetry reports ratios, precision is not needed). Images cost 256, matching toolResultTokens. */
export function countMessagesTokens(messages: readonly AnyMessage[]): number {
	let total = 0;
	for (const m of messages) {
		if (isUser(m)) {
			if (typeof m.content === "string") total += Math.ceil(m.content.length / 4);
			else for (const c of m.content) total += c.type === "text" ? Math.ceil(c.text.length / 4) : 256;
		} else if (isAssistant(m)) {
			for (const c of m.content) {
				if (c.type === "text") total += Math.ceil(c.text.length / 4);
				else if (c.type === "thinking") total += Math.ceil(((c as { thinking?: string }).thinking ?? "").length / 4);
				else if (c.type === "toolCall") total += Math.ceil(canonicalJson(c.arguments).length / 4);
			}
		} else if (isToolResult(m)) {
			for (const c of m.content) total += c.type === "text" ? Math.ceil(c.text.length / 4) : 256;
		}
	}
	return total;
}

/** Accumulate one model call's pre/post token totals. */
export function recordCall(state: SessionState, before: number, after: number): void {
	state.callTelemetry.calls++;
	state.callTelemetry.tokensBefore += before;
	state.callTelemetry.tokensAfter += after;
}

/** One-line summary for /dcp stats and /dcp context. */
export function telemetrySummary(state: SessionState): string {
	const t = state.callTelemetry;
	if (!t.calls) return "this session: 0 calls";
	const avg = Math.round(t.tokensAfter / t.calls);
	const removed = t.tokensBefore > 0 ? Math.round((1 - t.tokensAfter / t.tokensBefore) * 100) : 0;
	return `this session: ${t.calls} calls, avg ${avg} tokens/call sent, ${removed}% removed by dcp`;
}
