import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toast } from "../ui/toast.ts";

const HELP = [
	"pi-dcp commands:",
	"  /dcp            — this help",
	"  /dcp context    — current session token usage + DCP savings",
	"  /dcp stats      — cumulative DCP savings across all sessions",
	"  /dcp sweep [n]  — manually compress last n tool results (default: all since last user msg)",
	"  /dcp manual [on|off|status|toggle]  — control manual mode (runtime only — edit config.json to persist)",
	"  /dcp decompress <id>  — protect and suspend a compression; archived output requires recall",
	"  /dcp recompress <id>  — release that compression's protection reason",
	"  /dcp jev stats | score <task> | continue | cancel  — experimental owner-controlled selection",
	"  /dcp jev restore|release|recall <result-entry-id>  — native-confirmed protection/recovery",
	"",
	"Config: ~/.pi-dcp/config.json",
	"Prompts: ~/.pi-dcp/prompts/{defaults,overrides}/",
	"Logs:   ~/.pi-dcp/dcp.log (when debug:true)",
].join("\n");

export async function handleHelp(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	void toast(ctx, HELP, "info");
}
