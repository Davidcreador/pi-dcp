import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toast } from "../ui/toast.ts";
import type { SessionState } from "../state.ts";

/**
 * /dcp manual [on|off|status]
 *
 * Toggles or sets manualMode at RUNTIME. When ON the LLM-callable `compress`
 * tool refuses autonomous invocation and nudges are silenced. Automatic
 * deduplication and purgeErrors still run unless `manualMode.automaticStrategies`
 * is false in config.
 *
 * Note: this command updates the runtime flag only. To make it persistent across
 * pi restarts, edit `manualMode.enabled` in ~/.pi-dcp/config.json.
 */
export function makeManualCommand(state: SessionState) {
	return async function handleManual(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim().toLowerCase();
		if (arg === "status") {
			void toast(ctx, 
				`pi-dcp manual mode: ${state.manualMode ? "ON" : "off"} (runtime only \u2014 edit config.json to persist)`,
				"info",
			);
			return;
		}
		if (arg === "on") state.manualMode = true;
		else if (arg === "off") state.manualMode = false;
		else if (arg === "" || arg === "toggle") state.manualMode = !state.manualMode;
		else {
			void toast(ctx, `pi-dcp: unknown arg "${arg}" (expected on|off|status|toggle)`, "warning");
			return;
		}
		void toast(ctx, 
			`pi-dcp manual mode: ${state.manualMode ? "ON" : "off"} (runtime only \u2014 edit config.json to persist)`,
			"info",
		);
	};
}
