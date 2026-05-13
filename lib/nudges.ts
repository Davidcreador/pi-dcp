/**
 * System-prompt nudges that encourage the model to call `compress` when the
 * conversation is approaching the configured maxContextLimit.
 *
 * Throttling rules:
 *   - usage < minContextLimit                  → no nudge (cheapest path)
 *   - minContextLimit <= usage < maxContextLimit → SOFT nudge, but only once
 *                                                  every `nudgeEveryTurns`
 *                                                  turns to avoid bloating
 *                                                  every request
 *   - usage >= maxContextLimit                 → HARD nudge every turn (we
 *                                                  WANT to bias the model
 *                                                  toward compression)
 *
 * We hook `before_agent_start` and return a `systemPrompt` override — pi
 * chains multiple extension overrides cleanly. Soft / hard nudges are
 * separate so the model can see escalating urgency.
 */
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type DcpConfig, resolveContextLimit } from "./config.ts";
import type { SessionState } from "./state.ts";

const SOFT_NUDGE = [
	"",
	"## pi-dcp context note",
	"You have a `compress` tool. When old tool results are no longer needed verbatim",
	"but their facts still matter, call `compress(toolCallIds, topic, summary)` to",
	"replace them with a lossless technical summary. Compress closed work-streams",
	"only — never compress your most recent turn or in-flight work.",
].join("\n");

const HARD_NUDGE = [
	"",
	"## pi-dcp — context filling up",
	"You are approaching the model's context limit. Strongly consider calling the",
	"`compress` tool on older completed work-streams before continuing. Preserve",
	"all concrete facts (file paths, line numbers, decisions, errors).",
].join("\n");

export function makeNudgeHandler(config: DcpConfig, state: SessionState) {
	return async (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<BeforeAgentStartEventResult | void> => {
		if (config.compress.permission === "deny") return;
		if (state.manualMode) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

		const minLimit = resolveContextLimit(config.compress.minContextLimit, usage.contextWindow);
		const maxLimit = resolveContextLimit(config.compress.maxContextLimit, usage.contextWindow);

		if (usage.tokens < minLimit) return;

		const isHard = usage.tokens >= maxLimit;
		if (!isHard) {
			const everyN = Math.max(1, config.compress.nudgeEveryTurns);
			if (state.turnIndex - state.lastSoftNudgeTurn < everyN) return;
			state.lastSoftNudgeTurn = state.turnIndex;
		}

		const nudge = isHard ? HARD_NUDGE : SOFT_NUDGE;
		const base = event.systemPrompt ?? "";
		return { systemPrompt: `${base}\n${nudge}` };
	};
}
