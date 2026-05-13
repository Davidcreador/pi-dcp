import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "../state.ts";

/**
 * /dcp manual [on|off]
 * Toggles or sets manualMode. When ON the LLM is prevented from auto-calling
 * the compress tool (the tool is still registered for explicit /dcp sweep
 * invocations). Automatic deduplication and purgeErrors still run unless
 * disabled in config.
 */
export function makeManualCommand(state: SessionState) {
	return async function handleManual(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim().toLowerCase();
		if (arg === "on") state.manualMode = true;
		else if (arg === "off") state.manualMode = false;
		else state.manualMode = !state.manualMode;
		ctx.ui.notify(`pi-dcp manual mode: ${state.manualMode ? "ON" : "off"}`, "info");
	};
}
