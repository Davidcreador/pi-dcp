import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HELP = [
	"pi-dcp commands:",
	"  /dcp            — this help",
	"  /dcp context    — current session token usage + DCP savings",
	"  /dcp stats      — cumulative DCP savings across all sessions",
	"  /dcp sweep [n]  — manually compress last n tool results (default: all since last user msg)",
	"  /dcp manual [on|off|status|toggle]  — control manual mode (runtime only — edit config.json to persist)",
	"  /dcp decompress <id>  — temporarily restore a stored compression",
	"  /dcp recompress <id>  — re-apply a previously decompressed entry",
	"",
	"Config: ~/.pi-dcp/config.json",
	"Prompts: ~/.pi-dcp/prompts/{defaults,overrides}/",
	"Logs:   ~/.pi-dcp/dcp.log (when debug:true)",
].join("\n");

export async function handleHelp(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify(HELP, "info");
}
