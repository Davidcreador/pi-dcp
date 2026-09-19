/** Pi Adapter for explicit Jev batches and durable recovery; never starts a model turn or uploads on a context hook. */
import { buildSessionContext, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import type { DcpConfig } from "./config.ts";
import { suspendedTargets, type SessionState } from "./state.ts";
import { JevSelection, type SelectionView } from "./jev-selection.ts";
import { findResult, pinRecord, replayPinReasons, prepareRecovery, PIN_ENTRY, RECALL_MESSAGE } from "./protection.ts";

export type JevApi = Pick<ExtensionAPI, "on" | "getAllTools" | "appendEntry" | "sendMessage">;
type JevContext = Pick<ExtensionContext, "cwd"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
};
export type JevCommandContext = JevContext & Pick<ExtensionCommandContext, "hasUI" | "model" | "getContextUsage" | "isIdle"> & {
	ui: Pick<ExtensionContext["ui"], "custom" | "editor" | "notify">;
};

/** RPC implements confirm/editor but not custom components; only this native prompt authorizes effects. */
async function confirmOwner(ctx: JevCommandContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	try {
		return await ctx.ui.custom<boolean>((_tui, _theme, _keys, done) => {
			const text = new Text(`${title}\n\n${message}\n\n[y] Approve  [n/Esc] Cancel`, 1, 1);
			return {
				render: (width: number) => text.render(width),
				invalidate: () => text.invalidate(),
				handleInput(data: string) {
					if (matchesKey(data, "y")) done(true);
					else if (matchesKey(data, "n") || matchesKey(data, "escape")) done(false);
				},
			};
		});
	} catch {
		ctx.ui.notify("DCP effects require native interactive confirmation; unsupported UI retained all data", "warning");
		return false;
	}
}

export function createJevController(pi: JevApi, config: DcpConfig, state?: SessionState) {
	let selection = new JevSelection(config);
	let navigation = 0;
	const view = (ctx: JevContext, messages?: AgentMessage[]): SelectionView => {
		const entries = ctx.sessionManager.getBranch();
		return { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, entries,
			legacyProtected: state ? suspendedTargets(state) : new Set(), messages: messages ?? buildSessionContext(entries).messages };
	};
	const recordPins = async (ctx: JevCommandContext, ids: string[], action: "pin" | "release", reason: string) => {
		const generation = navigation;
		const initial = view(ctx);
		const refs = ids.map(id => {
			const entry = initial.entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
			const original = entry && findResult(initial.sessionId, initial.entries, entry.id);
			if (!original) throw new Error("Original result unavailable on the current branch");
			return original.ref;
		});
		const approved = await confirmOwner(ctx, `${action === "pin" ? "Protect" : "Release"} ${ids.length} DCP result(s)?`,
			`Reason: ${reason}\nResult entries: ${refs.map(ref => ref.entryId).join(", ")}\nThis changes only this branch's protection. Other reasons remain; archived content is not automatically recalled.`);
		if (!approved) throw new Error("Protection change cancelled");
		const current = view(ctx);
		if (navigation !== generation || current.sessionId !== initial.sessionId || refs.some(ref => findResult(current.sessionId, current.entries, ref.entryId)?.ref.digest !== ref.digest)) {
			throw new Error("Protection target changed; nothing recorded");
		}
		pi.appendEntry(PIN_ENTRY, pinRecord(action, reason, refs));
		selection.invalidate();
	};

	const pinReasons = (ctx: JevContext) => {
		const current = view(ctx);
		const reasons = replayPinReasons(current.sessionId, current.entries);
		if (!reasons) throw new Error("Invalid branch protection metadata; nothing released");
		return reasons;
	};
	const leaveBranch = () => { navigation++; selection.invalidate(true); };
	pi.on("session_start", () => { leaveBranch(); selection = new JevSelection(config); });
	pi.on("session_shutdown", leaveBranch);
	pi.on("session_before_switch", leaveBranch);
	pi.on("session_before_fork", leaveBranch);
	pi.on("session_before_compact", () => selection.invalidate());
	pi.on("session_compact", () => selection.invalidate());
	pi.on("session_before_tree", leaveBranch);
	pi.on("session_tree", leaveBranch);
	pi.on("input", () => { selection.invalidate(); return { action: "continue" }; });
	pi.on("tool_result", (event, ctx) => {
		if (!selection.options?.enabled) return;
		if (event.toolName === "write" || event.toolName === "edit") selection.invalidate();
		if (event.toolName !== "read") return;
		const tool = pi.getAllTools().find(tool => tool.name === "read");
		selection.observe(event, ctx.cwd, tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === "<builtin:read>");
	});

	return {
		get selection() { return selection; },
		view,
		recordPins,
		compressionIds(ctx: JevContext): number[] {
			return [...pinReasons(ctx)].filter(([reason, ids]) => reason.startsWith("compression:") && ids.size > 0)
				.map(([reason]) => Number(reason.slice("compression:".length)));
		},
		async releaseCompression(ctx: JevCommandContext, id: number): Promise<boolean> {
			const reason = `compression:${id}`;
			const durable = pinReasons(ctx).get(reason);
			const record = state?.compressions.get(id);
			let ids: string[] = [];
			if (durable?.size) ids = [...durable];
			else if (record?.suspended) ids = record.toolCallIds;
			if (!ids.length) return false;
			await recordPins(ctx, ids, "release", reason);
			return true;
		},
		async command(args: string, ctx: JevCommandContext): Promise<void> {
			const [action, ...rest] = args.trim().split(/\s+/);
			const argument = rest.join(" ");
			if (!action || action === "stats") {
				ctx.ui.notify(JSON.stringify({ configurationValid: selection.options !== null,
					mode: !selection.options?.enabled ? "disabled" : selection.options.dropBelow === null ? "shadow" : "prune",
					...selection.stats, judgments: selection.judgments }), "info");
				return;
			}
			if (action === "score") {
				if (!argument) throw new Error("Usage: /dcp jev score <explicit nonsecret task brief>");
				const result = await selection.score(view(ctx), argument, async preview => {
					if (!await confirmOwner(ctx, "Review a TypeSafe disclosure?", "The next editor contains the FULL task and source payload. Submit unchanged to send; Esc cancels.")) return false;
					const submitted = await ctx.ui.editor("Send to TypeSafe: review FULL payload; submit unchanged to authorize, Esc to cancel", preview);
					return submitted === preview;
				}, () => view(ctx));
				ctx.ui.notify(`DCP Jev: ${result}. Scores are advisory; savings are estimates, not billing proof.`, result === "failed" ? "warning" : "info");
				return;
			}
			if (action === "continue" && !argument) {
				const task = selection.readyTask;
				if (!task) throw new Error("No ready Jev task; score an approved batch first");
				if (!ctx.isIdle()) throw new Error("Agent is already running; no additional turn started");
				if (!await confirmOwner(ctx, "Continue the explicitly declared Jev task?", JSON.stringify(task))) return;
				if (selection.readyTask !== task || !ctx.isIdle()) throw new Error("Task state changed; no turn started");
				pi.sendMessage({ customType: "pi-dcp.task.v1", content: `Continue this owner-confirmed task: ${task}`, display: true }, { triggerTurn: true });
				return;
			}
			if (action === "cancel") {
				selection.invalidate();
				ctx.ui.notify("Jev decisions cancelled; durable pins unchanged", "info");
				return;
			}
			if (!["restore", "release", "recall"].includes(action) || !argument || /\s/.test(argument)) {
				throw new Error("Usage: /dcp jev stats | score <task> | continue | cancel | restore|release|recall <result-entry-id>");
			}
			const generation = navigation;
			const initial = view(ctx);
			const original = findResult(initial.sessionId, initial.entries, argument);
			if (!original) throw new Error("Original result unavailable on this branch");
			if (action === "restore" || action === "release") {
				await recordPins(ctx, [original.ref.toolCallId], action === "restore" ? "pin" : "release", "owner");
				if (navigation !== generation) throw new Error("Navigation changed after recording protection; check the selected branch");
				const recovery = prepareRecovery(initial.sessionId, initial.entries, initial.messages, argument, 0);
				ctx.ui.notify(action === "release" ? "Owner pin released; other protection reasons remain"
					: recovery.kind === "present" ? "Pinned: original stays visible through DCP on the next request"
						: `Pinned; active-context restore unavailable. Use /dcp jev recall ${argument} for archived text.`, "info");
				return;
			}
			if (!ctx.isIdle()) throw new Error("Recall requires an idle agent; nothing queued");
			const recallBudget = () => {
				const usage = ctx.getContextUsage();
				return usage?.tokens !== null && usage?.tokens !== undefined && ctx.model
					? Math.min(4096, ctx.model.contextWindow - usage.tokens - 16384) : 0;
			};
			const recovery = prepareRecovery(initial.sessionId, initial.entries, initial.messages, argument, recallBudget());
			if (recovery.kind !== "archived") {
				ctx.ui.notify(recovery.kind === "present" ? "Result is present; use restore to protect it" : recovery.reason, "warning");
				return;
			}
			await recordPins(ctx, [original.ref.toolCallId], "pin", "owner");
			const current = view(ctx);
			if (navigation !== generation || !ctx.isIdle() || current.sessionId !== initial.sessionId || findResult(current.sessionId, current.entries, argument)?.ref.digest !== original.ref.digest) {
				throw new Error("Recall target changed; nothing appended");
			}
			const checked = prepareRecovery(current.sessionId, current.entries, current.messages, argument, recallBudget());
			if (checked.kind !== "archived") throw new Error("Recall state or available budget changed; nothing queued");
			pi.sendMessage({ customType: RECALL_MESSAGE, content: checked.content, display: true,
				details: { source: original.ref } });
			ctx.ui.notify("Exact persisted text appended to this branch for the next ordinary prompt; no model turn started", "info");
		},
	};
}
