/**
 * Per-session DCP state.
 *
 * In-memory only. Cumulative cross-session stats are persisted by lib/stats.ts.
 */

export interface CompressionRecord {
	id: number;
	createdAt: number;
	/** Tool-call IDs whose ToolResultMessage entries this compression replaces. */
	toolCallIds: string[];
	/** High-fidelity summary the LLM produced. */
	summary: string;
	/** Topic/heading the LLM tagged the compression with. */
	topic: string;
	/** Estimated tokens saved (sum of replaced content lengths / 4). */
	tokensSaved: number;
	/** If user ran /dcp decompress, this record is suspended until /dcp recompress. */
	suspended: boolean;
}

export interface SessionStats {
	dedupPruned: number;
	errorInputsPurged: number;
	compressionsApplied: number;
	tokensSaved: number;
}

export interface SessionState {
	compressions: Map<number, CompressionRecord>;
	nextCompressionId: number;
	stats: SessionStats;
	manualMode: boolean;
	/** Turn counter, updated on every turn_start event. Used to age errored calls. */
	turnIndex: number;
	/**
	 * Map of errored tool-call id -> turnIndex observed when the error was first
	 * seen. purgeErrors compares this to the current turnIndex.
	 */
	erroredAt: Map<string, number>;
	/** Tool-call IDs we have already deduplicated this session (idempotency). */
	dedupedCallIds: Set<string>;
	/** Tool-call IDs whose error inputs have been purged (idempotency). */
	purgedErrorCallIds: Set<string>;
	/** Tool-call IDs that have already had a compression applied (idempotency for stats). */
	appliedCompressionTargets: Set<string>;
	/** Turn at which we last emitted a soft nudge. Used for throttling. */
	lastSoftNudgeTurn: number;
	/** Monotonic counter of before_agent_start invocations — powers nudgeFrequency. */
	nudgeFetchCount: number;
	/**
	 * Count of "messages since last user message" at which the iteration
	 * nudge most recently fired. Used to throttle the iteration nudge so it
	 * doesn't repeat on every fetch once over the threshold.
	 */
	lastIterationNudgeAt: number;
}

export function createSessionState(): SessionState {
	return {
		compressions: new Map(),
		nextCompressionId: 1,
		stats: {
			dedupPruned: 0,
			errorInputsPurged: 0,
			compressionsApplied: 0,
			tokensSaved: 0,
		},
		manualMode: false,
		turnIndex: 0,
		erroredAt: new Map(),
		dedupedCallIds: new Set(),
		purgedErrorCallIds: new Set(),
		appliedCompressionTargets: new Set(),
		lastSoftNudgeTurn: -Infinity,
		nudgeFetchCount: 0,
		lastIterationNudgeAt: 0,
	};
}
