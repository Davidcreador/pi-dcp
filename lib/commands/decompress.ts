import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toast } from "../ui/toast.ts";
import type { SessionState } from "../state.ts";

/** Strict positive-integer parse — rejects "5abc", negatives, NaN. */
function parseStrictId(arg: string): number | undefined {
	if (!/^\d+$/.test(arg)) return undefined;
	const n = Number(arg);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function makeDecompressCommand(state: SessionState) {
	return async function handleDecompress(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim();
		if (!arg) {
			const active = [...state.compressions.values()].filter((r) => !r.suspended);
			if (active.length === 0) {
				void toast(ctx, "pi-dcp: no active compressions to decompress", "info");
				return;
			}
			const lines = ["pi-dcp / active compressions (run /dcp decompress <id>):"];
			for (const r of active) lines.push(`  #${r.id} — ${r.topic} (${r.toolCallIds.length} call(s))`);
			void toast(ctx, lines.join("\n"), "info");
			return;
		}
		const id = parseStrictId(arg);
		if (id === undefined) {
			void toast(ctx, `pi-dcp: invalid compression id "${arg}" (must be a positive integer)`, "warning");
			return;
		}
		const rec = state.compressions.get(id);
		if (!rec) {
			void toast(ctx, `pi-dcp: no compression with id ${id}`, "warning");
			return;
		}
		if (rec.suspended) {
			void toast(ctx, `pi-dcp: compression #${id} is already decompressed`, "info");
			return;
		}
		rec.suspended = true;
		void toast(ctx, `pi-dcp: compression #${id} decompressed (originals restored)`, "info");
	};
}

export function makeRecompressCommand(state: SessionState) {
	return async function handleRecompress(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim();
		if (!arg) {
			const suspended = [...state.compressions.values()].filter((r) => r.suspended);
			if (suspended.length === 0) {
				void toast(ctx, "pi-dcp: no decompressed entries to recompress", "info");
				return;
			}
			const lines = ["pi-dcp / suspended compressions (run /dcp recompress <id>):"];
			for (const r of suspended) lines.push(`  #${r.id} — ${r.topic}`);
			void toast(ctx, lines.join("\n"), "info");
			return;
		}
		const id = parseStrictId(arg);
		if (id === undefined) {
			void toast(ctx, `pi-dcp: invalid compression id "${arg}" (must be a positive integer)`, "warning");
			return;
		}
		const rec = state.compressions.get(id);
		if (!rec) {
			void toast(ctx, `pi-dcp: no compression with id ${id}`, "warning");
			return;
		}
		if (!rec.suspended) {
			void toast(ctx, `pi-dcp: compression #${id} is already active`, "info");
			return;
		}
		rec.suspended = false;
		void toast(ctx, `pi-dcp: compression #${id} re-applied`, "info");
	};
}

// Re-exported for unit tests.
export const _internal = { parseStrictId };
