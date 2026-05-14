/**
 * /dcp context
 *
 * Show the current session's context usage and DCP savings as an overlay
 * panel. In non-interactive modes (print/RPC) the panel falls back to a
 * multi-line toast, see showInfoPanel for details.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "../state.ts";
import type { PanelRow, PanelSection } from "../ui/info-panel.ts";
import { showInfoPanel } from "../ui/info-panel.ts";

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Build a Unicode bar of `filled / total * width` filled cells. Used to give
 * a quick at-a-glance view of how close we are to the model's context window.
 */
function progressBar(percent: number, width = 24): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled));
}

export function makeContextCommand(state: SessionState) {
	return async function handleContext(
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const u = ctx.getContextUsage();

		// Usage section. Drives the title-bar feel — bar + tokens + percent.
		const usageRows: PanelRow[] = [];
		if (!u || u.tokens === null) {
			usageRows.push({
				kind: "text",
				text: "context usage: unknown (no recent LLM call yet)",
			});
		} else {
			const pct = u.percent ?? 0;
			usageRows.push({
				kind: "kv",
				label: "tokens",
				value: `${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} (${pct.toFixed(1)}%)`,
			});
			usageRows.push({
				kind: "text",
				text: progressBar(pct),
			});
		}

		const sections: PanelSection[] = [
			{ rows: usageRows },
			{
				heading: "Session savings",
				rows: [
					{
						kind: "kv",
						label: "duplicate tool results pruned",
						value: state.stats.dedupPruned.toLocaleString(),
					},
					{
						kind: "kv",
						label: "errored tool inputs purged",
						value: state.stats.errorInputsPurged.toLocaleString(),
					},
					{
						kind: "kv",
						label: "compressions applied",
						value: state.stats.compressionsApplied.toLocaleString(),
					},
					{
						kind: "kv",
						label: "estimated tokens saved",
						value: `~${formatTokens(state.stats.tokensSaved)}`,
						valueColor: "success",
					},
				],
			},
		];

		const active = [...state.compressions.values()].filter((r) => !r.suspended);
		if (active.length === 0) {
			sections.push({
				heading: "Active compressions",
				rows: [{ kind: "text", text: "(none)" }],
			});
		} else {
			sections.push({
				heading: "Active compressions",
				rows: active.map((r) => ({
					kind: "kv" as const,
					label: `#${r.id}`,
					value: `${r.topic}  (${r.toolCallIds.length} call${r.toolCallIds.length === 1 ? "" : "s"})`,
				})),
			});
		}

		sections.push({
			rows: [
				{
					kind: "kv",
					label: "manual mode",
					value: state.manualMode ? "ON" : "off",
					valueColor: state.manualMode ? "warning" : undefined,
				},
			],
		});

		await showInfoPanel(ctx, {
			title: "pi-dcp / current context",
			sections,
		});
	};
}
