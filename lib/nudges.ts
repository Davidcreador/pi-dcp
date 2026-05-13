/**
 * System-prompt nudges that encourage the model to call `compress` when the
 * conversation approaches the configured maxContextLimit.
 *
 * Throttling rules (any one returning false stops the nudge):
 *   1. usage < minContextLimit                  → no nudge
 *   2. manualMode.enabled                       → no nudge (LLM can't compress anyway)
 *   3. soft nudges: count++ % nudgeFrequency !== 0
 *      AND (turnIndex - lastSoftNudgeTurn) < nudgeEveryTurns
 *   4. usage >= maxContextLimit                 → HARD nudge every fetch (we want urgency)
 *
 * Soft text and hard text both come from PromptStore, so the user can override
 * either by dropping a file in prompts/overrides/.
 */
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type DcpConfig, resolveContextLimit } from "./config.ts";
import { PROMPTS, type PromptStore } from "./prompts/index.ts";
import type { SessionState } from "./state.ts";

export function makeNudgeHandler(
	config: DcpConfig,
	state: SessionState,
	prompts: PromptStore,
) {
	return async (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<BeforeAgentStartEventResult | void> => {
		if (config.compress.permission === "deny") return;
		if (config.manualMode.enabled || state.manualMode) return;

		state.nudgeFetchCount++;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

		const minLimit = resolveContextLimit(config.compress.minContextLimit, usage.contextWindow);
		const maxLimit = resolveContextLimit(config.compress.maxContextLimit, usage.contextWindow);

		if (usage.tokens < minLimit) return;

		const isHard = usage.tokens >= maxLimit;
		if (!isHard) {
			// Per-request throttle: only emit on every Nth fetch.
			const freq = Math.max(1, config.compress.nudgeFrequency);
			if (state.nudgeFetchCount % freq !== 0) return;

			// Per-turn throttle: limit to once every N turns.
			const everyN = Math.max(1, config.compress.nudgeEveryTurns);
			if (state.turnIndex - state.lastSoftNudgeTurn < everyN) return;
			state.lastSoftNudgeTurn = state.turnIndex;
		}

		const nudge = prompts.read(isHard ? PROMPTS.hardNudge : PROMPTS.softNudge);
		const base = event.systemPrompt ?? "";
		return { systemPrompt: `${base}\n${nudge}` };
	};
}
