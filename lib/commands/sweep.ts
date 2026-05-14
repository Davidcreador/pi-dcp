/**
 * /dcp sweep [n]
 *
 * Stages a synthetic compression covering the last `n` tool results in the
 * current branch (default: all tool results since the most recent user
 * message). The summary is a placeholder — use this when you want to nuke a
 * wall of unwanted output, not when you want to preserve facts (use the
 * compress tool for that). Undo with /dcp decompress <id>.
 *
 * We walk the session BRANCH (root→leaf path) rather than getEntries() so we
 * pick up the user's currently active conversation, not the entire session
 * tree.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toast } from "../ui/toast.ts";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { CompressionRecord, SessionState } from "../state.ts";

export function makeSweepCommand(state: SessionState, config: DcpConfig, logger: Logger) {
	return async function handleSweep(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim();
		// Strict: only accept pure positive-integer arguments. parseInt("5abc")
		// silently returns 5 which is surprising and inconsistent with how
		// /dcp decompress|recompress parse their ids.
		let userLimit: number | undefined;
		if (arg) {
			if (/^\d+$/.test(arg)) {
				const n = Number(arg);
				if (Number.isInteger(n) && n > 0) userLimit = n;
			}
			if (userLimit === undefined) {
				void toast(ctx, `pi-dcp sweep: "${arg}" is not a positive integer; ignoring`, "warning");
			}
		}

		const sm = ctx.sessionManager;
		let branch: ReturnType<typeof sm.getBranch>;
		try {
			branch = sm.getBranch();
		} catch (e) {
			void toast(ctx, "pi-dcp sweep: could not read session branch", "warning");
			logger.error("sweep failed to read branch", {
				error: e instanceof Error ? e.message : String(e),
			});
			return;
		}

		const protectedTools = new Set([
			...ALWAYS_PROTECTED_TOOLS,
			...config.compress.protectedTools,
		]);

		// Walk newest-first across the branch. Collect tool result IDs until we
		// either hit the requested count or cross a user message.
		const ids: string[] = [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry: any = branch[i];
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			if (msg.role === "user") break;
			if (msg.role !== "toolResult") continue;
			if (protectedTools.has(msg.toolName)) continue;
			ids.push(msg.toolCallId);
			if (userLimit !== undefined && ids.length >= userLimit) break;
		}

		if (ids.length === 0) {
			void toast(ctx, "pi-dcp sweep: no eligible tool results found", "info");
			return;
		}

		const id = state.nextCompressionId++;
		const rec: CompressionRecord = {
			id,
			createdAt: Date.now(),
			toolCallIds: ids,
			summary: "(manual sweep — no summary; original outputs no longer in context)",
			topic: "manual sweep",
			tokensSaved: 0,
			suspended: false,
		};
		state.compressions.set(id, rec);
		logger.info("sweep staged", { id, count: ids.length });
		void toast(ctx, 
			`pi-dcp sweep: staged compression #${id} over ${ids.length} tool result(s). Run "/dcp decompress ${id}" to undo before the next message.`,
			"info",
		);
	};
}
