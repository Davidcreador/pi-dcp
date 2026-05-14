/**
 * Prompt store.
 *
 * Six prompts power pi-dcp's interactions with the LLM:
 *
 *   - compress-message     description of the compress tool in message mode
 *   - compress-range       description of the compress tool in range mode
 *   - soft-nudge           system-prompt addendum at the soft-threshold floor
 *   - strong-nudge         aggressive variant of soft-nudge (compress.nudgeForce="strong")
 *   - hard-nudge           system-prompt addendum past the hard ceiling
 *   - iteration-nudge      addendum after iterationNudgeThreshold msgs since last user msg
 *
 * On startup we write all defaults to
 *     ~/.pi-dcp/prompts/defaults/{name}.md
 * so the user can see what they're overriding. If `experimental.customPrompts`
 * is enabled in config, we also LOOK FOR overrides at
 *     ~/.pi-dcp/prompts/overrides/{name}.md
 * and use them when present.
 *
 * Overrides are read once at extension init. Restart pi after edits to pick
 * up changes (matches opencode-dcp behavior).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROMPTS = {
	compressMessage: "compress-message",
	compressRange: "compress-range",
	softNudge: "soft-nudge",
	strongNudge: "strong-nudge",
	hardNudge: "hard-nudge",
	iterationNudge: "iteration-nudge",
} as const;

export type PromptName = (typeof PROMPTS)[keyof typeof PROMPTS];

/** Built-in default text for each prompt. Keep these in one place so the
 *  defaults file regen + the in-process fallback agree. */
export const DEFAULT_PROMPTS: Record<PromptName, string> = {
	"compress-message": [
		"Compress one or more older tool-call results into a high-fidelity summary. Use when the literal tool output is no longer needed but its facts still are (e.g. after finishing exploration, after a long failed retry loop). The replacement is applied on the next LLM request — your current turn sees the originals. NEVER compress tool calls from your most recent turn or work in progress.",
	].join("\n"),
	"compress-range": [
		"Compress a contiguous span of older tool-call results into one high-fidelity summary. Provide the FIRST and LAST tool-call IDs of the span; everything between (inclusive, excluding protected tools like write/edit/todo) is summarized. Use when an entire closed work-stream is no longer needed verbatim. The replacement is applied on the next LLM request — your current turn sees the originals. NEVER pick endpoints inside your most recent turn or in-flight work.",
	].join("\n"),
	"soft-nudge": [
		"",
		"## pi-dcp context note",
		"You have a `compress` tool. When old tool results are no longer needed verbatim",
		"but their facts still matter, call `compress(...)` to replace them with a",
		"lossless technical summary. Compress closed work-streams only — never",
		"compress your most recent turn or in-flight work.",
	].join("\n"),
	"strong-nudge": [
		"",
		"## pi-dcp — reduce context usage",
		"You have a `compress` tool. Older tool outputs in this conversation are",
		"likely no longer needed verbatim. Call `compress(...)` on every closed",
		"work-stream you have completed. Preserve facts, file paths, line numbers,",
		"errors, and decisions in the summary. Do NOT compress your most recent turn.",
	].join("\n"),
	"iteration-nudge": [
		"",
		"## pi-dcp — many steps since last user message",
		"You have done several tool calls without a user message. If any of that",
		"work is now closed, call `compress(...)` to summarize it before",
		"continuing. Preserve all concrete facts.",
	].join("\n"),
	"hard-nudge": [
		"",
		"## pi-dcp — context filling up",
		"You are approaching the model's context limit. Strongly consider calling the",
		"`compress` tool on older completed work-streams before continuing. Preserve",
		"all concrete facts (file paths, line numbers, decisions, errors).",
	].join("\n"),
};

// User-state directory. Matches PI_DCP_USER_DIR in lib/config.ts (kept
// duplicated here so prompts has no module-graph dependency on config).
const PROMPTS_DIR = path.join(os.homedir(), ".pi-dcp", "prompts");
const DEFAULTS_DIR = path.join(PROMPTS_DIR, "defaults");
const OVERRIDES_DIR = path.join(PROMPTS_DIR, "overrides");

const DEFAULTS_README = [
	"# pi-dcp prompt defaults",
	"",
	"This directory is REGENERATED on every pi-dcp init — do not edit files here.",
	"",
	"To customize a prompt, copy it to `../overrides/` (same filename) and edit",
	"that copy. Then enable `experimental.customPrompts: true` in your pi-dcp",
	"config and restart pi.",
	"",
	"## Files",
	"",
	"- `compress-message.md`  — description text the LLM sees for the compress tool in message mode",
	"- `compress-range.md`    — description text for compress tool in range mode",
	"- `soft-nudge.md`        — default soft system-prompt addendum (used when compress.nudgeForce='soft')",
	"- `strong-nudge.md`      — aggressive variant (used when compress.nudgeForce='strong')",
	"- `hard-nudge.md`        — system-prompt addendum when context usage crosses the hard ceiling",
	"- `iteration-nudge.md`   — system-prompt addendum after iterationNudgeThreshold messages since last user msg",
	"",
].join("\n");

const OVERRIDES_README = [
	"# pi-dcp prompt overrides",
	"",
	"Drop a file here named the same as one in `../defaults/` to override that",
	"prompt. Then enable `experimental.customPrompts: true` in your pi-dcp config",
	"and restart pi.",
	"",
	"Delete an override file to revert to the default for that prompt.",
	"",
].join("\n");

export interface PromptStoreOptions {
	/** If false, overrides directory is ignored even if present (default: false). */
	customPromptsEnabled: boolean;
	/** Override the prompts root, primarily for tests. */
	promptsDir?: string;
}

/**
 * In-memory prompt store. Resolves text in this order:
 *   1. user override (if customPromptsEnabled and file exists)
 *   2. on-disk default (regenerated on init)
 *   3. compiled-in DEFAULT_PROMPTS (fallback if filesystem unavailable)
 *
 * Reads happen at init and are cached. Restart pi to pick up changes.
 */
export class PromptStore {
	private readonly cache = new Map<PromptName, string>();
	private readonly customPromptsEnabled: boolean;
	private readonly promptsDir: string;

	constructor(options: PromptStoreOptions) {
		this.customPromptsEnabled = options.customPromptsEnabled;
		this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
		this.regenerateDefaults();
		this.load();
	}

	private regenerateDefaults(): void {
		try {
			const defaultsDir = path.join(this.promptsDir, "defaults");
			const overridesDir = path.join(this.promptsDir, "overrides");
			fs.mkdirSync(defaultsDir, { recursive: true });
			fs.mkdirSync(overridesDir, { recursive: true });
			fs.writeFileSync(path.join(defaultsDir, "README.md"), DEFAULTS_README);
			// Only write the overrides README if the dir was just created; we
			// don't want to clobber any user notes.
			const ovReadme = path.join(overridesDir, "README.md");
			if (!fs.existsSync(ovReadme)) {
				fs.writeFileSync(ovReadme, OVERRIDES_README);
			}
			for (const [name, text] of Object.entries(DEFAULT_PROMPTS)) {
				fs.writeFileSync(path.join(defaultsDir, `${name}.md`), text);
			}
		} catch {
			// Best effort — fall back to in-memory defaults at read() time.
		}
	}

	private load(): void {
		const overridesDir = path.join(this.promptsDir, "overrides");
		for (const name of Object.values(PROMPTS) as PromptName[]) {
			let text: string | undefined;
			if (this.customPromptsEnabled) {
				text = this.readFile(path.join(overridesDir, `${name}.md`));
			}
			if (text === undefined) {
				text = this.readFile(path.join(this.promptsDir, "defaults", `${name}.md`));
			}
			if (text === undefined) {
				text = DEFAULT_PROMPTS[name];
			}
			this.cache.set(name, text);
		}
	}

	private readFile(file: string): string | undefined {
		try {
			if (!fs.existsSync(file)) return undefined;
			return fs.readFileSync(file, "utf-8");
		} catch {
			return undefined;
		}
	}

	/**
	 * Look up a prompt. Always returns a non-empty string — never throws,
	 * never returns undefined. Falls back through: cache → in-process default
	 * → empty string (final defense if a caller invents a new name without
	 * registering it).
	 */
	read(name: PromptName): string {
		return this.cache.get(name) ?? DEFAULT_PROMPTS[name] ?? "";
	}

	/** True if any prompt resolved to a user override. Useful for debug logs. */
	hasAnyOverride(): boolean {
		if (!this.customPromptsEnabled) return false;
		const overridesDir = path.join(this.promptsDir, "overrides");
		for (const name of Object.values(PROMPTS) as PromptName[]) {
			if (this.readFile(path.join(overridesDir, `${name}.md`)) !== undefined) return true;
		}
		return false;
	}
}
