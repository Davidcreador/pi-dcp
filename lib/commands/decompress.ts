import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toast } from "../ui/toast.ts";
import type { CompressionRecord, SessionState } from "../state.ts";

/** Strict positive-integer parse — rejects "5abc", negatives, NaN. */
function parseStrictId(arg: string): number | undefined {
	if (!/^\d+$/.test(arg)) return undefined;
	const n = Number(arg);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function makeDecompressCommand(state: SessionState, protect?: (record: CompressionRecord) => Promise<void>) {
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
		await protect?.(rec);
		rec.suspended = true;
		void toast(ctx, `pi-dcp: compression #${id} suspended; present originals protected, archived results require recall`, "info");
	};
}

/** Durable compression reasons remain discoverable/releasable without the expiring summary sidecar. */
export interface CompressionRelease {
	compressionIds(): number[];
	release(id: number): Promise<boolean>;
}

export function makeRecompressCommand(state: SessionState, protection?: CompressionRelease) {
	return async function handleRecompress(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim();
		if (!arg) {
			const suspended = new Set([...state.compressions.values()].filter(r => r.suspended).map(r => r.id));
			for (const id of protection?.compressionIds() ?? []) suspended.add(id);
			if (suspended.size === 0) {
				void toast(ctx, "pi-dcp: no decompressed entries to recompress", "info");
				return;
			}
			const lines = ["pi-dcp / suspended compressions (run /dcp recompress <id>):"];
			for (const id of suspended) lines.push(`  #${id} — ${state.compressions.get(id)?.topic ?? "durable protection; summary unavailable"}`);
			void toast(ctx, lines.join("\n"), "info");
			return;
		}
		const id = parseStrictId(arg);
		if (id === undefined) {
			void toast(ctx, `pi-dcp: invalid compression id "${arg}" (must be a positive integer)`, "warning");
			return;
		}
		const rec = state.compressions.get(id);
		const released = await protection?.release(id);
		if (!rec) {
			void toast(ctx, released ? `pi-dcp: compression #${id} protection released; summary unavailable`
				: `pi-dcp: no compression with id ${id}`, released ? "info" : "warning");
			return;
		}
		if (!rec.suspended) {
			void toast(ctx, released ? `pi-dcp: compression #${id} protection released; stored summary active`
				: `pi-dcp: compression #${id} is already active`, "info");
			return;
		}
		rec.suspended = false;
		void toast(ctx, `pi-dcp: compression #${id} re-applied`, "info");
	};
}

// Re-exported for unit tests.
export const _internal = { parseStrictId };
