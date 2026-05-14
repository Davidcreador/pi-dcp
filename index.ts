/**
 * pi-dcp — Dynamic Context Pruning for Pi.
 *
 * Port of opencode-dynamic-context-pruning (AGPL-3.0).
 *
 * Wires the following into pi:
 *   1. A `context` handler that prunes the message array on every LLM call
 *      (deduplication + errored-input purge + stored compressions). Returns
 *      a freshly built array — message objects share identity with persisted
 *      session entries and must not be mutated in place.
 *   2. A `compress` tool the LLM can call to summarize closed work-streams.
 *      Two variants: message-mode (toolCallIds[]) and range-mode (start+end).
 *      One or the other is registered based on `config.compress.mode`.
 *   3. A `before_agent_start` handler that appends throttled system-prompt
 *      nudges as context fills up.
 *   4. A `/dcp` slash command surface for inspecting/controlling DCP.
 *
 * Config lives in ~/.pi-dcp/config.json (auto-created on first run) with
 * optional per-project override at <cwd>/.pi/dcp.json.
 *
 * Prompts: defaults regenerated at init under ~/.pi-dcp/prompts/defaults/;
 * user overrides honoured under ~/.pi-dcp/prompts/overrides/ when
 * `experimental.customPrompts` is enabled.
 */
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	TurnStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./lib/config.ts";
import { Logger } from "./lib/logger.ts";
import { runPipeline } from "./lib/pipeline.ts";
import { createSessionState } from "./lib/state.ts";
import { bumpLifetime } from "./lib/stats.ts";
import { makeNudgeHandler } from "./lib/nudges.ts";
import { notifyPipelineResult } from "./lib/notifications.ts";
import { PromptStore } from "./lib/prompts/index.ts";
import { createCompressMessageTool } from "./lib/tools/compress-message.ts";
import { createCompressRangeTool } from "./lib/tools/compress-range.ts";
import { handleHelp } from "./lib/commands/help.ts";
import { handleStats } from "./lib/commands/stats.ts";
import { makeContextCommand } from "./lib/commands/context.ts";
import { makeManualCommand } from "./lib/commands/manual.ts";
import { makeSweepCommand } from "./lib/commands/sweep.ts";
import { makeDecompressCommand, makeRecompressCommand } from "./lib/commands/decompress.ts";

interface ContextEventResult {
	messages?: ContextEvent["messages"];
}

export default function piDcp(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const config = loadConfig(cwd);
	const logger = new Logger(config.debug);

	if (!config.enabled) {
		logger.info("pi-dcp disabled via config; skipping wiring");
		return;
	}

	const prompts = new PromptStore({
		customPromptsEnabled: config.experimental.customPrompts,
	});
	const state = createSessionState();
	// Seed runtime manualMode from config so the user can opt in declaratively.
	state.manualMode = config.manualMode.enabled;

	bumpLifetime({ sessionsTouched: 1 });
	logger.info("pi-dcp initialized", {
		enabled: config.enabled,
		mode: config.compress.mode,
		manualMode: state.manualMode,
		customPrompts: config.experimental.customPrompts,
		hasOverrides: prompts.hasAnyOverride(),
		strategies: {
			deduplication: config.strategies.deduplication.enabled,
			purgeErrors: config.strategies.purgeErrors.enabled,
		},
		compressPermission: config.compress.permission,
	});

	// 1. The pruning pipeline runs immediately before every LLM call. After it
	//    finishes, we emit user-visible feedback (footer status + optional
	//    inline toast) gated by config.pruneNotification.
	pi.on("context", (event: ContextEvent, ctx: ExtensionContext): ContextEventResult | void => {
		try {
			const result = runPipeline(event.messages as any, config, state, logger);
			notifyPipelineResult(ctx, config, state, result, logger);
			return { messages: result.messages as ContextEvent["messages"] };
		} catch (err) {
			logger.error("pipeline crashed — passing messages through unchanged", {
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
			return;
		}
	});

	// 2. Track turn index so purgeErrors can age errored calls.
	pi.on("turn_start", (event: TurnStartEvent) => {
		state.turnIndex = event.turnIndex;
	});

	// 3. Record errored tool results the moment we see them so purgeErrors has
	//    a reliable turn-of-first-observation, even if the pipeline hasn't run
	//    yet for this turn.
	pi.on("tool_result", (event: ToolResultEvent) => {
		if (!event.isError) return;
		if (!state.erroredAt.has(event.toolCallId)) {
			state.erroredAt.set(event.toolCallId, state.turnIndex);
		}
	});

	// 4. Compress tool: one variant based on configured mode.
	if (config.compress.permission !== "deny") {
		const toolCtx = { state, logger, config };
		if (config.compress.mode === "range") {
			pi.registerTool(createCompressRangeTool(toolCtx, prompts));
		} else {
			pi.registerTool(createCompressMessageTool(toolCtx, prompts));
		}
	}

	// 5. Throttled system-prompt nudges.
	pi.on("before_agent_start", makeNudgeHandler(config, state, prompts));

	// 6. /dcp slash commands.
	pi.registerCommand("dcp", {
		description: "Dynamic context pruning — see /dcp for subcommands",
		getArgumentCompletions(prefix) {
			const subs = ["context", "stats", "sweep", "manual", "decompress", "recompress"];
			return subs
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const subArgs = rest.join(" ");
			try {
				switch (sub) {
					case "":
						return handleHelp(subArgs, ctx);
					case "context":
						return makeContextCommand(state)(subArgs, ctx);
					case "stats":
						return handleStats(subArgs, ctx);
					case "manual":
						return makeManualCommand(state)(subArgs, ctx);
					case "sweep":
						return makeSweepCommand(state, config, logger)(subArgs, ctx);
					case "decompress":
						return makeDecompressCommand(state)(subArgs, ctx);
					case "recompress":
						return makeRecompressCommand(state)(subArgs, ctx);
					default:
						ctx.ui.notify(`pi-dcp: unknown subcommand "${sub}"`, "warning");
						return handleHelp("", ctx);
				}
			} catch (err) {
				logger.error("/dcp subcommand failed", {
					sub,
					error: err instanceof Error ? err.message : String(err),
				});
				ctx.ui.notify(
					`pi-dcp: /dcp ${sub} failed — ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
