import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "../state.ts";

export function makeContextCommand(state: SessionState) {
	return async function handleContext(
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const u = ctx.getContextUsage();
		const lines: string[] = ["pi-dcp / current context"];
		if (!u || u.tokens === null) {
			lines.push("  context usage: unknown (no recent LLM call yet)");
		} else {
			const pct = u.percent === null ? "?" : `${u.percent.toFixed(1)}%`;
			lines.push(`  tokens: ${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} (${pct})`);
		}
		lines.push("");
		lines.push(`  session savings:`);
		lines.push(`    duplicate tool results pruned: ${state.stats.dedupPruned}`);
		lines.push(`    errored tool inputs purged:    ${state.stats.errorInputsPurged}`);
		lines.push(`    compressions applied:          ${state.stats.compressionsApplied}`);
		lines.push(`    estimated tokens saved:        ~${state.stats.tokensSaved.toLocaleString()}`);
		lines.push("");
		const active = [...state.compressions.values()].filter((r) => !r.suspended);
		if (active.length === 0) {
			lines.push("  no active compressions");
		} else {
			lines.push("  active compressions:");
			for (const r of active) {
				lines.push(`    #${r.id} — ${r.topic} (${r.toolCallIds.length} call(s))`);
			}
		}
		lines.push("");
		lines.push(`  manual mode: ${state.manualMode ? "ON" : "off"}`);
		ctx.ui.notify(lines.join("\n"), "info");
	};
}
