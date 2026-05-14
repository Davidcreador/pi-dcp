/**
 * DCP configuration.
 *
 * Lookup order (later wins, shallow-merged top-level + deep-merged nested objects):
 *   1. ~/.pi-dcp/config.json (global default)
 *   2. <cwd>/.pi/dcp.json    (project override)
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
	/**
	 * Protect the most recent N turns from ALL pruning (dedup, purgeErrors,
	 * stored compressions). "Turn" here is bounded by user messages — the last
	 * `turns` user-to-user spans are immune.
	 */
	turnProtection: {
		enabled: boolean;
		turns: number;
	};
	experimental: {
		/**
		 * Enable user-editable prompt overrides under
		 * ~/.pi-dcp/prompts/overrides/. When false (default), the override
		 * directory exists but its contents are ignored. Restart pi after
		 * toggling this.
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
		/**
		 * Per-model override map for `minContextLimit`. Key is `"<provider>/<id>"`
		 * matching `ctx.model.provider`/`ctx.model.id`. Value follows the same
		 * number-or-"X%" grammar as the global setting. Wins over the global.
		 */
		modelMinLimits?: Record<string, number | string>;
		/** Per-model override for `maxContextLimit`. Wins over the global. */
		modelMaxLimits?: Record<string, number | string>;
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
		/**
		 * Start forcing a soft nudge after this many assistant/tool messages have
		 * happened since the last user message, even if the context floor hasn't
		 * been crossed. 0 disables this trigger.
		 */
		iterationNudgeThreshold: number;
		/**
		 * Controls the wording strength of the soft nudge.
		 * "soft"   = gentle reminder (lower bias toward compression)
		 * "strong" = aggressive language (higher bias toward compression)
		 */
		nudgeForce: "soft" | "strong";
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

/**
 * Default config. Tuned for real-world long sessions on modern Claude and
 * GPT-5.x models. Treated as frozen at runtime to avoid accidental shared
 * mutation across sessions; callers that need a mutable copy must clone.
 *
 * Per-model min/max limits are baked in here so users get sensible behavior
 * the moment they `pi install` — they can still override anything in
 * ~/.pi-dcp/config.json.
 */
export const DEFAULT_CONFIG: DcpConfig = Object.freeze({
	enabled: true,
	debug: false,
	pruneNotification: "minimal",
	experimental: {
		customPrompts: false,
	},
	turnProtection: {
		enabled: true,
		turns: 3,
	},
	manualMode: {
		enabled: false,
		automaticStrategies: true,
	},
	compress: {
		mode: "range",
		minContextLimit: 30_000,
		maxContextLimit: 70_000,
		modelMinLimits: {
			// Anthropic Claude 4.x — 200k windows.
			"anthropic/claude-haiku-4-5": 30_000,
			"anthropic/claude-sonnet-4-5": 50_000,
			"anthropic/claude-sonnet-4-6": 50_000,
			"anthropic/claude-opus-4-1": 35_000,
			"anthropic/claude-opus-4-5": 35_000,
			"anthropic/claude-opus-4-6": 35_000,
			"anthropic/claude-opus-4-7": 35_000,
			// OpenAI GPT-5.x — context window varies; values picked empirically.
			"openai/gpt-5.4-mini-fast": 25_000,
			"openai/gpt-5.4-mini": 30_000,
			"openai/gpt-5.5": 45_000,
		},
		modelMaxLimits: {
			"anthropic/claude-haiku-4-5": 70_000,
			"anthropic/claude-sonnet-4-5": 120_000,
			"anthropic/claude-sonnet-4-6": 120_000,
			"anthropic/claude-opus-4-1": 85_000,
			"anthropic/claude-opus-4-5": 85_000,
			"anthropic/claude-opus-4-6": 85_000,
			"anthropic/claude-opus-4-7": 85_000,
			"openai/gpt-5.4-mini-fast": 50_000,
			"openai/gpt-5.4-mini": 70_000,
			"openai/gpt-5.5": 100_000,
		},
		permission: "allow",
		protectedTools: [],
		nudgeEveryTurns: 5,
		nudgeFrequency: 3,
		iterationNudgeThreshold: 8,
		nudgeForce: "strong",
	},
	strategies: {
		deduplication: {
			enabled: true,
			protectedTools: [],
		},
		purgeErrors: {
			enabled: true,
			turns: 2,
			protectedTools: [],
		},
	},
}) as DcpConfig;

/**
 * User-state directory. INDEPENDENT of where pi installs the extension
 * code — pi may put the code under `~/.pi/agent/git/...` (git install),
 * `~/.pi/agent/extensions/...` (manual clone), or the npm global tree (npm
 * install). Config, prompts, and logs always live here.
 */
export const PI_DCP_USER_DIR = path.join(os.homedir(), ".pi-dcp");
const GLOBAL_CONFIG_PATH = path.join(PI_DCP_USER_DIR, "config.json");

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

/**
 * Write a starter config to ~/.pi-dcp/config.json if one doesn't already
 * exist. Also handles a one-time migration from the legacy install-path
 * config (~/.pi/agent/extensions/pi-dcp/config.json) so users who manually
 * cloned the repo before user-state moved don't lose their tuning.
 */
function ensureStarterConfig(onError: (msg: string) => void): void {
	try {
		if (fs.existsSync(GLOBAL_CONFIG_PATH)) return;
		fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });

		// Migration path: if the old in-repo config still exists, copy it over
		// so the user's tuning carries forward. Only happens once — we never
		// overwrite an existing ~/.pi-dcp/config.json.
		const legacyPath = path.join(
			os.homedir(),
			".pi", "agent", "extensions", "pi-dcp", "config.json",
		);
		if (fs.existsSync(legacyPath) && legacyPath !== GLOBAL_CONFIG_PATH) {
			try {
				fs.copyFileSync(legacyPath, GLOBAL_CONFIG_PATH);
				onError(
					`pi-dcp: migrated config from ${legacyPath} \u2192 ${GLOBAL_CONFIG_PATH}. ` +
					`The legacy file can be deleted.`,
				);
				return;
			} catch {
				// Fall through to writing defaults.
			}
		}

		fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
	} catch {
		// Best effort. Missing starter is fine — DEFAULT_CONFIG still kicks in.
	}
}

export function loadConfig(
	cwd: string,
	onError: (msg: string) => void = (m) => console.error(m),
): DcpConfig {
	ensureStarterConfig(onError);
	const globalOverride = safeReadJson(GLOBAL_CONFIG_PATH, onError);
	const projectPath = path.join(cwd, ".pi", "dcp.json");
	const projectOverride = safeReadJson(projectPath, onError);
	return deepMerge(deepMerge(DEFAULT_CONFIG, globalOverride), projectOverride);
}

/**
 * Pick the effective limit for the active model. If `overrides` has a matching
 * `"<provider>/<id>"` entry we use that; otherwise we fall back to the global
 * `globalSetting`. The chosen value is then resolved by `resolveContextLimit`.
 */
export function resolveModelLimit(
	globalSetting: number | string,
	overrides: Record<string, number | string> | undefined,
	model: { provider?: string; id?: string } | undefined,
	contextWindow: number | undefined,
): number {
	if (overrides && model?.provider && model?.id) {
		const key = `${model.provider}/${model.id}`;
		if (key in overrides) {
			return resolveContextLimit(overrides[key], contextWindow);
		}
	}
	return resolveContextLimit(globalSetting, contextWindow);
}

/**
 * Resolve a min/max context-limit setting against the model's context window.
 * Accepts:
 *   - a non-negative number          → used as-is (tokens). 0 means "always above the floor".
 *   - a percentage string "X%"       → floor(X/100 * contextWindow)
 *   - a bare numeric string "12345"  → parsed as a number
 *
 * Falls back to the model's contextWindow (or 100k as a last resort) when the
 * value is junk. For a floor this means "never trigger soft nudges"; for a
 * ceiling it means "never trigger hard nudges". Both are safe defaults.
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
