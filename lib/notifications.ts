/**
 * User-visible feedback when the pipeline does work.
 *
 * Two surfaces, gated by `config.pruneNotification`:
 *
 *   - **Footer status** (always on for "minimal" and "detailed"): pi's
 *     status bar gets a persistent `DCP: ~24.3k saved` chip that updates
 *     whenever new pruning happens. Tells the user pi-dcp is alive without
 *     being noisy.
 *
 *   - **Inline notification** (only on "detailed"): every time a pipeline
 *     pass prunes something new, `ctx.ui.notify()` fires a one-line summary
 *     like "pi-dcp: pruned 2 duplicate grep calls, purged 1 errored bash
 *     call (~3.2k tokens)". Interactive mode only.
 *
 * Without one of these wired up the extension is effectively invisible \u2014
 * the lifetime stats build up in ~/.pi-dcp/stats.json but the user never
 * sees the benefit on screen.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { PipelineResult } from "./pipeline.ts";
import type { SessionState } from "./state.ts";
import { toast } from "./ui/toast.ts";

const STATUS_KEY = "dcp";

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function buildFooterText(state: SessionState): string {
	const s = state.stats;
	const total =
		s.dedupPruned + s.errorInputsPurged + s.compressionsApplied;
	if (total === 0) return "DCP: idle";
	return `DCP: ~${formatTokens(s.tokensSaved)} saved`;
}

function buildToastText(result: PipelineResult): string {
	const parts: string[] = [];
	if (result.dedupPruned > 0) {
		parts.push(`${result.dedupPruned} duplicate${result.dedupPruned > 1 ? "s" : ""}`);
	}
	if (result.errorInputsPurged > 0) {
		parts.push(
			`${result.errorInputsPurged} errored call${result.errorInputsPurged > 1 ? "s" : ""} purged`,
		);
	}
	if (result.compressionsApplied > 0) {
		parts.push(
			`${result.compressionsApplied} compression${result.compressionsApplied > 1 ? "s" : ""} applied`,
		);
	}
	const summary = parts.join(", ");
	return `pi-dcp: ${summary} (~${formatTokens(result.tokensSaved)} tokens)`;
}

/**
 * Called from the `context` handler after every pipeline pass. Cheap when
 * the pipeline did no work (early return). Otherwise emits the configured
 * notifications.
 */
export function notifyPipelineResult(
	ctx: ExtensionContext,
	config: DcpConfig,
	state: SessionState,
	result: PipelineResult,
	logger?: Logger,
): void {
	const mode = config.pruneNotification;
	if (mode === "off") {
		logger?.info("notify skipped: pruneNotification=off");
		return;
	}
	if (!ctx.hasUI) {
		logger?.info("notify skipped: ctx.hasUI=false (non-interactive mode)");
		return;
	}

	const didWork =
		result.dedupPruned > 0 ||
		result.errorInputsPurged > 0 ||
		result.compressionsApplied > 0;

	const footerText = buildFooterText(state);

	// Footer status — always reflect lifetime session totals, including
	// "DCP: idle" on the first context event so the user knows the extension
	// is wired in. Set on every call: the TUI dedupes identical strings, and
	// the cost is negligible.
	let footerOk = false;
	try {
		ctx.ui.setStatus(STATUS_KEY, footerText);
		footerOk = true;
	} catch (err) {
		logger?.warn("setStatus failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Inline toast — only on "detailed", only when this pass did work.
	let toastFired = false;
	if (mode === "detailed" && didWork) {
		const text = buildToastText(result);
		try {
			void toast(ctx, text, "info");
			toastFired = true;
		} catch (err) {
			logger?.warn("notify failed", {
				error: err instanceof Error ? err.message : String(err),
				text,
			});
		}
	}

	logger?.info("notify pass", {
		mode,
		didWork,
		footerText,
		footerOk,
		toastFired,
		result: {
			dedupPruned: result.dedupPruned,
			errorInputsPurged: result.errorInputsPurged,
			compressionsApplied: result.compressionsApplied,
		},
	});
}
