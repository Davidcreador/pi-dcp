import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readLifetime } from "../stats.ts";

export async function handleStats(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const s = readLifetime();
	const ago = s.firstSeen ? `${Math.round((Date.now() - s.firstSeen) / 86_400_000)}d` : "—";
	const lines = [
		"pi-dcp / lifetime stats",
		`  active since:                  ${ago} ago`,
		`  duplicate tool results pruned: ${s.dedupPruned.toLocaleString()}`,
		`  errored tool inputs purged:    ${s.errorInputsPurged.toLocaleString()}`,
		`  compressions applied:          ${s.compressionsApplied.toLocaleString()}`,
		`  estimated tokens saved:        ~${s.tokensSaved.toLocaleString()}`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
