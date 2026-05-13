/**
 * Lifetime DCP statistics persisted to ~/.pi-dcp/stats.json.
 *
 * Best-effort: any read/write error fails soft and returns zeroed counters.
 * /dcp stats reads this file; pipeline.ts writes to it whenever pruning happens.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATS_DIR = path.join(os.homedir(), ".pi-dcp");
const STATS_FILE = path.join(STATS_DIR, "stats.json");

export interface LifetimeStats {
	sessionsTouched: number;
	dedupPruned: number;
	errorInputsPurged: number;
	compressionsApplied: number;
	tokensSaved: number;
	firstSeen: number;
	lastUpdated: number;
}

const EMPTY: LifetimeStats = {
	sessionsTouched: 0,
	dedupPruned: 0,
	errorInputsPurged: 0,
	compressionsApplied: 0,
	tokensSaved: 0,
	firstSeen: 0,
	lastUpdated: 0,
};

export function readLifetime(): LifetimeStats {
	try {
		if (!fs.existsSync(STATS_FILE)) return { ...EMPTY };
		return { ...EMPTY, ...(JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")) as Partial<LifetimeStats>) };
	} catch {
		return { ...EMPTY };
	}
}

/**
 * Bump lifetime counters. Read-modify-write is racy across concurrent pi
 * processes, so we write to a temp file + rename atomically. The rename is
 * atomic on the same filesystem on POSIX. Two concurrent writers may still
 * lose a delta (last-writer-wins), but the file will never be left partially
 * written or with mixed JSON — we'd rather lose one bump than corrupt the
 * stats file.
 */
export function bumpLifetime(delta: Partial<LifetimeStats>): void {
	try {
		fs.mkdirSync(STATS_DIR, { recursive: true });
		const cur = readLifetime();
		const next: LifetimeStats = {
			sessionsTouched: cur.sessionsTouched + (delta.sessionsTouched ?? 0),
			dedupPruned: cur.dedupPruned + (delta.dedupPruned ?? 0),
			errorInputsPurged: cur.errorInputsPurged + (delta.errorInputsPurged ?? 0),
			compressionsApplied: cur.compressionsApplied + (delta.compressionsApplied ?? 0),
			tokensSaved: cur.tokensSaved + (delta.tokensSaved ?? 0),
			firstSeen: cur.firstSeen || Date.now(),
			lastUpdated: Date.now(),
		};
		const tmp = `${STATS_FILE}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
		fs.renameSync(tmp, STATS_FILE);
	} catch {
		// Best effort.
	}
}
