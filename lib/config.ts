/**
 * DCP configuration.
 *
 * Lookup order (later wins, shallow-merged top-level + deep-merged nested objects):
 *   1. ~/.pi/agent/extensions/pi-dcp/config.json (global default)
 *   2. <cwd>/.pi/dcp.json                        (project override)
 *
 * Both files are optional. On first run a commented starter is written to (1)
 * so the user can discover settings without reading the README.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Permission = "allow" | "ask" | "deny";

export interface DcpConfig {
	enabled: boolean;
	debug: boolean;
	/** "off" | "minimal" | "detailed" — controls /dcp context-style notifications. */
	pruneNotification: "off" | "minimal" | "detailed";
	experimental: {
		/**
		 * Enable user-editable prompt overrides under
		 * ~/.pi/agent/extensions/pi-dcp/prompts/overrides/. When false (default),
		 * the override directory exists but its contents are ignored. Restart pi
		 * after toggling this.
		 */
		customPrompts: boolean;
	};
	manualMode: {
		/** When true, the compress tool refuses autonomous invocation. */
		enabled: boolean;
		/**
		 * When manualMode.enabled is true, should auto strategies (dedup,
		 * purgeErrors) still run? Default: true — manual mode normally just
		 * silences the LLM, not the housekeeping.
		 */
		automaticStrategies: boolean;
	};
	compress: {
		/**
		 * Compression mode controlling the compress tool's parameter surface.
		 * - "message": tool takes `toolCallIds[]` and compresses individual results.
		 * - "range":   tool takes `startToolCallId` + `endToolCallId` and compresses
		 *             every eligible result in that contiguous span. Easier for
		 *             the model to use on closed work-streams; less surgical.
		 */
		mode: "range" | "message";
		/** Soft floor of context tokens before the LLM is nudged to compress. number or "X%" of context window. */
		minContextLimit: number | string;
		/** Soft ceiling — at/above this we push stronger nudges. number or "X%" of context window. */
		maxContextLimit: number | string;
		/** Permission for the `compress` tool. "deny" means do not register it at all. */
		permission: Permission;
		/** Tools whose outputs are never pruned and are appended to compression summaries. */
		protectedTools: string[];
		/** Soft nudge will fire at most once every N turns to avoid bloating every request. */
		nudgeEveryTurns: number;
		/**
		 * Additional throttle: soft nudge fires only every Nth context fetch.
		 * Use this when a single turn can do many tool calls and you don't want
		 * the nudge appended on every one. Default: 1 (no extra throttling beyond
		 * nudgeEveryTurns). Set to 5 to fire every 5th fetch.
		 */
		nudgeFrequency: number;
	};
	strategies: {
		deduplication: {
			enabled: boolean;
			/** Tools that must never be deduplicated (e.g. write, edit). */
			protectedTools: string[];
		};
		purgeErrors: {
			enabled: boolean;
			/** Number of turns before errored tool call inputs are pruned. */
			turns: number;
			protectedTools: string[];
		};
	};
}

/** Tools that are ALWAYS protected regardless of user config. */
export const ALWAYS_PROTECTED_TOOLS = new Set([
	"compress",
	"write",
	"edit",
	"todo",
	"task",
	"skill",
]);

/** Default config. Treat as frozen at runtime to avoid accidental shared
 *  mutation across sessions; callers that need a mutable copy must clone. */
export const DEFAULT_CONFIG: DcpConfig = Object.freeze({
	enabled: true,
	debug: false,
	pruneNotification: "detailed",
	experimental: {
		customPrompts: false,
	},
	manualMode: {
		enabled: false,
		automaticStrategies: true,
	},
	compress: {
		mode: "message",
		minContextLimit: "30%",
		maxContextLimit: "60%",
		permission: "allow",
		protectedTools: [],
		nudgeEveryTurns: 5,
		nudgeFrequency: 1,
	},
	strategies: {
		deduplication: {
			enabled: true,
			protectedTools: [],
		},
		purgeErrors: {
			enabled: true,
			turns: 4,
			protectedTools: [],
		},
	},
}) as DcpConfig;

const GLOBAL_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	"pi-dcp",
	"config.json",
);

function safeReadJson(
	file: string,
	onError: (msg: string) => void,
): Partial<DcpConfig> | null {
	try {
		if (!fs.existsSync(file)) return null;
		const text = fs.readFileSync(file, "utf-8");
		return JSON.parse(text) as Partial<DcpConfig>;
	} catch (e) {
		// Don't crash on a broken config — fail soft to DEFAULT_CONFIG — but DO
		// surface the error so the user can see why their override is ignored.
		onError(`pi-dcp: failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

function deepMerge<T>(base: T, override: Partial<T> | null | undefined): T {
	if (!override) return base;
	const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
	for (const [k, v] of Object.entries(override)) {
		if (v && typeof v === "object" && !Array.isArray(v) && (base as any)[k]) {
			out[k] = deepMerge((base as any)[k], v as any);
		} else if (v !== undefined) {
			out[k] = v;
		}
	}
	return out;
}

/** Write the default config to GLOBAL_CONFIG_PATH if it does not yet exist. */
function ensureStarterConfig(): void {
	try {
		if (fs.existsSync(GLOBAL_CONFIG_PATH)) return;
		fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
		fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
	} catch {
		// Best effort. Missing starter is fine.
	}
}

export function loadConfig(
	cwd: string,
	onError: (msg: string) => void = (m) => console.error(m),
): DcpConfig {
	ensureStarterConfig();
	const globalOverride = safeReadJson(GLOBAL_CONFIG_PATH, onError);
	const projectPath = path.join(cwd, ".pi", "dcp.json");
	const projectOverride = safeReadJson(projectPath, onError);
	return deepMerge(deepMerge(DEFAULT_CONFIG, globalOverride), projectOverride);
}

/**
 * Resolve a context limit setting (number or "X%" string) against the model's
 * context window. Returns a token count. Falls back to a generous default if
 * the percentage cannot be applied (e.g. context window unknown).
 */
/**
 * Resolve a min/max context-limit setting against the model's context window.
 * Accepts:
 *   - a non-negative number          → used as-is (tokens). 0 means "always above the floor".
 *   - a percentage string "X%"       → floor(X/100 * contextWindow)
 *   - a bare numeric string "12345"  → parsed as a number
 *
 * Junk values fall back to the safest interpretation — for a floor this is
 * "never trigger nudges" (= return contextWindow), for the caller's purposes.
 */
export function resolveContextLimit(
	setting: number | string,
	contextWindow: number | undefined,
): number {
	if (typeof setting === "number" && Number.isFinite(setting) && setting >= 0) return setting;
	if (typeof setting === "string") {
		const m = setting.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
		if (m && contextWindow && contextWindow > 0) {
			return Math.floor((Number(m[1]) / 100) * contextWindow);
		}
		const asNumber = Number(setting);
		if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
	}
	return contextWindow && contextWindow > 0 ? contextWindow : 100_000;
}
