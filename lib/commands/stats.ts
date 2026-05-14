/**
 * /dcp stats
 *
 * Lifetime DCP savings shown in the same info-panel overlay used by
 * /dcp context. Falls back to a toast in non-interactive modes.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readLifetime } from "../stats.ts";
import { showInfoPanel } from "../ui/info-panel.ts";

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function humanizeAgo(firstSeen: number): string {
	if (!firstSeen) return "—";
	const days = Math.round((Date.now() - firstSeen) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "1 day ago";
	return `${days} days ago`;
}

export async function handleStats(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const s = readLifetime();
	await showInfoPanel(ctx, {
		title: "pi-dcp / lifetime stats",
		sections: [
			{
				rows: [
					{ kind: "kv", label: "active since", value: humanizeAgo(s.firstSeen) },
					{
						kind: "kv",
						label: "sessions touched",
						value: s.sessionsTouched.toLocaleString(),
					},
				],
			},
			{
				heading: "Across all sessions",
				rows: [
					{
						kind: "kv",
						label: "duplicate tool results pruned",
						value: s.dedupPruned.toLocaleString(),
					},
					{
						kind: "kv",
						label: "errored tool inputs purged",
						value: s.errorInputsPurged.toLocaleString(),
					},
					{
						kind: "kv",
						label: "compressions applied",
						value: s.compressionsApplied.toLocaleString(),
					},
					{
						kind: "kv",
						label: "estimated tokens saved",
						value: `~${formatTokens(s.tokensSaved)}`,
						valueColor: "success",
					},
				],
			},
		],
	});
}
