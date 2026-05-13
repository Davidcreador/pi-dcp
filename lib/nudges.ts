/**
 * System-prompt nudges that encourage the model to call `compress`.
 *
 * Three independent nudge surfaces:
 *
 *   - SOFT / STRONG   appended when usage crosses minContextLimit. Text comes
 *                     from PROMPTS.softNudge or PROMPTS.strongNudge depending
 *                     on `compress.nudgeForce`. Throttled by:
 *                       * nudgeFrequency (per before_agent_start)
 *                       * nudgeEveryTurns (per turn)
 *   - HARD            appended when usage crosses maxContextLimit. Fires every
 *                     fetch above the ceiling — urgency outweighs token cost.
 *   - ITERATION       appended after iterationNudgeThreshold non-user messages
 *                     since the last user message. Independent of context
 *                     size; fires at most once per iteration window.
 *
 * Manual mode (config OR runtime) suppresses ALL nudges — the model can't
 * compress anyway.
 *
 * Per-model context limits: if `compress.modelMinLimits` / `modelMaxLimits`
 * has a `"<provider>/<id>"` entry matching the current model, that wins over
 * the global `minContextLimit` / `maxContextLimit`.
 */
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type DcpConfig, resolveModelLimit } from "./config.ts";
import { PROMPTS, type PromptName, type PromptStore } from "./prompts/index.ts";
import type { SessionState } from "./state.ts";

/**
 * Count non-user messages back to the most recent user message in the branch.
 * Returns 0 if no user message is found within `maxScan` entries.
 *
 * Bounded scan: even very long sessions only walk back at most `maxScan`
 * entries. The iteration-nudge fires once we've crossed the configured
 * threshold, so we never need to look much further back than that.
 */
function messagesSinceLastUser(
	branch: ReadonlyArray<unknown>,
	maxScan: number,
): number {
	const limit = Math.max(0, Math.min(maxScan, branch.length));
	let count = 0;
	for (let i = branch.length - 1, scanned = 0; i >= 0 && scanned < limit; i--, scanned++) {
		const entry = branch[i] as { type?: string; message?: { role?: string } };
		if (entry?.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") return count;
		count++;
	}
	return count;
}

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
		const window = usage?.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : undefined;
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		const minLimit = resolveModelLimit(
			config.compress.minContextLimit,
			config.compress.modelMinLimits,
			model,
			window,
		);
		const maxLimit = resolveModelLimit(
			config.compress.maxContextLimit,
			config.compress.modelMaxLimits,
			model,
			window,
		);

		const tokens = usage?.tokens ?? null;
		const isHard = tokens !== null && tokens >= maxLimit;
		const isSoft = !isHard && tokens !== null && tokens >= minLimit;

		// Iteration nudge: independent of context size. We need the session
		// branch to count messages-since-user; fall back to 0 if unavailable.
		let iterationFired = false;
		if (config.compress.iterationNudgeThreshold > 0) {
			let branch: ReadonlyArray<unknown> = [];
			try {
				branch = ctx.sessionManager.getBranch();
			} catch {
				branch = [];
			}
			// Bound the walk: a small multiple of the threshold is enough — we
			// only need to know if `since >= threshold`. 4x gives plenty of
			// headroom for the re-fire window check below.
			const scanCap = Math.max(64, config.compress.iterationNudgeThreshold * 4);
			const since = messagesSinceLastUser(branch, scanCap);
			if (since >= config.compress.iterationNudgeThreshold) {
				// Fire at most once per iteration window: track the count at which
				// we last fired and require another `threshold` messages before
				// firing again.
				if (since - state.lastIterationNudgeAt >= config.compress.iterationNudgeThreshold) {
					state.lastIterationNudgeAt = since;
					iterationFired = true;
				}
			} else {
				// Reset window when user has spoken again.
				state.lastIterationNudgeAt = 0;
			}
		}

		// Build the addendum stack. Order: soft/strong -> iteration -> hard.
		const parts: PromptName[] = [];

		if (isSoft) {
			const freq = Math.max(1, config.compress.nudgeFrequency);
			const turnGate = state.turnIndex - state.lastSoftNudgeTurn;
			const everyN = Math.max(1, config.compress.nudgeEveryTurns);
			const fireSoft = state.nudgeFetchCount % freq === 0 && turnGate >= everyN;
			if (fireSoft) {
				state.lastSoftNudgeTurn = state.turnIndex;
				parts.push(config.compress.nudgeForce === "strong" ? PROMPTS.strongNudge : PROMPTS.softNudge);
			}
		}

		if (iterationFired) parts.push(PROMPTS.iterationNudge);
		if (isHard) parts.push(PROMPTS.hardNudge);

		if (parts.length === 0) return;

		const base = event.systemPrompt ?? "";
		const addendum = parts.map((p) => prompts.read(p)).join("\n");
		return { systemPrompt: `${base}\n${addendum}` };
	};
}
