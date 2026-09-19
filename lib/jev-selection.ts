/** Owner-triggered context selection: complete approved snapshots in, reversible body omissions out. */
import { constants, openSync, closeSync, fstatSync, statSync, realpathSync, readSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig, type JevConfig } from "./config.ts";
import { approxTokens, canonicalJson, cloneForMutation, isAlreadyPlaceholder, isToolResult, protectedByRecency, type AnyMessage } from "./messages.ts";
import { exactKeys, findResult, isRecord, prepareRecovery, protectedUnchanged, replayPins, type OriginalResult } from "./protection.ts";
import { MAX_CANDIDATES, MAX_RESULT_BYTES, makeRequest, readKey, requestJev, type JevRequest, type JevResponse } from "./jev-client.ts";

export interface SelectionView {
	sessionId: string;
	cwd: string;
	entries: readonly SessionEntry[];
	messages: AgentMessage[];
	legacyProtected?: ReadonlySet<string>;
}
interface ObservedRead {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: unknown;
	isError: boolean;
	details?: unknown;
}
interface SourceSnapshot { file: string; stamp: string; digest: string }
interface Candidate { id: string; original: OriginalResult; source: SourceSnapshot }
export interface SelectionPolicy { hold: boolean; keep: Set<string>; omit: Map<string, string> }
type Inference = (request: JevRequest, signal: AbortSignal) => Promise<JevResponse & { elapsedMs: number }>;

function decodeConfig(value: unknown): JevConfig | null {
	if (!isRecord(value) || !exactKeys(value, ["enabled", "project", "files", "dropBelow", "auto", "task"])
		|| typeof value.enabled !== "boolean" || typeof value.project !== "string"
		|| !Array.isArray(value.files) || value.files.length > 64
		|| !value.files.every((file: unknown): file is string => typeof file === "string" && file.length > 0
			&& file.length <= 512 && !isAbsolute(file) && !/[\\\x00-\x1f\x7f]/.test(file)
			&& file.split("/").every(part => part !== "" && part !== "." && part !== ".."))
		|| (value.dropBelow !== null && (typeof value.dropBelow !== "number" || !Number.isFinite(value.dropBelow)
			|| value.dropBelow < 0 || value.dropBelow > 0.1))
		|| typeof value.auto !== "boolean" || typeof value.task !== "string" || Buffer.byteLength(value.task) > 2048) return null;
	if (value.enabled && (!isAbsolute(value.project) || !value.files.length)) return null;
	if (value.auto && !value.task.trim()) return null;
	return { enabled: value.enabled, project: value.project, files: [...value.files], dropBelow: value.dropBelow,
		auto: value.auto, task: value.task };
}

function stamp(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function snapshot(file: string): { text: string; stamp: string } | undefined {
	let descriptor: number | undefined;
	try {
		if (realpathSync(file) !== file) return;
		descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const before = fstatSync(descriptor, { bigint: true });
		if (!before.isFile() || before.size > BigInt(MAX_RESULT_BYTES)) return;
		const buffer = Buffer.alloc(MAX_RESULT_BYTES + 1);
		const size = readSync(descriptor, buffer, 0, buffer.length, 0);
		const after = fstatSync(descriptor, { bigint: true });
		if (BigInt(size) !== before.size || stamp(before) !== stamp(after) || stamp(statSync(file, { bigint: true })) !== stamp(before)) return;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
		if (text.includes("\0")) return;
		return { text, stamp: stamp(before) };
	} catch { return; }
	finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function contentDigest(input: unknown, content: unknown): string {
	return createHash("sha256").update(canonicalJson({ input, content })).digest("hex");
}

function protectedCalls(view: SelectionView): Set<string> | null {
	const pins = replayPins(view.sessionId, view.entries);
	if (pins) for (const id of view.legacyProtected ?? []) pins.add(id);
	return pins;
}

export class JevSelection {
	readonly options: JevConfig | null;
	readonly stats = { model: "", attempts: 0, completed: 0, failures: 0, inputTokens: 0, outputTokens: 0,
		elapsedMs: 0, approvalMs: 0, protectionBlocked: false, currentEstimatedTokensRemoved: 0, currentResultsOmitted: 0 };
	private readonly protectedTools: Set<string>;
	private readonly turns: number;
	private readonly maxSteps: number;
	private readonly sources = new Map<string, SourceSnapshot>();
	private readonly scores = new Map<string, { candidate: Candidate; probability: number; model: string }>();
	private readonly attempted = new Set<string>();
	private epoch = 0;
	private busy = false;
	private taskBrief: string | undefined;

	get readyTask(): string | undefined { return this.scores.size ? this.taskBrief : undefined; }
	get judgments() { return [...this.scores.values()].map(({ candidate, probability, model }) => ({ entryId: candidate.original.ref.entryId, probability, model })); }
	private cancellation: AbortController | undefined;

	constructor(config: DcpConfig) {
		this.options = decodeConfig(config.jev);
		this.turns = config.turnProtection.enabled && Number.isSafeInteger(config.turnProtection.turns)
			? Math.max(3, config.turnProtection.turns) : 3;
		this.maxSteps = config.turnProtection.enabled && Number.isSafeInteger(config.turnProtection.maxSteps)
			? Math.max(1, config.turnProtection.maxSteps) : Infinity;
		this.protectedTools = new Set([...ALWAYS_PROTECTED_TOOLS, ...config.compress.protectedTools,
			...config.strategies.deduplication.protectedTools, ...config.strategies.purgeErrors.protectedTools]);
	}

	invalidate(clearSources = false): void {
		this.epoch++;
		this.cancellation?.abort();
		this.scores.clear();
		this.attempted.clear();
		this.taskBrief = undefined;
		this.stats.currentEstimatedTokensRemoved = 0;
		this.stats.currentResultsOmitted = 0;
		if (clearSources) this.sources.clear();
	}

	private allowedFile(raw: string, cwd: string): string | undefined {
		const options = this.options;
		if (!options?.enabled) return;
		try {
			const root = realpathSync(options.project);
			if (realpathSync(cwd) !== root) return;
			const file = resolve(cwd, raw);
			const name = relative(root, file);
			if (!options.files.includes(name) || realpathSync(file) !== file) return;
			if (/(^|\/)(\.[^/]+|__tests__|tests?|fixtures?|docs|evidence|plans?|secrets?|credentials?)(\/|\.)/i.test(name)) return;
			if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|cpp|h|css|html)$/i.test(name)) return;
			return file;
		} catch { return; }
	}

	/** Registry metadata alone is not attestation: observed output must equal an approved local file. */
	observe(event: ObservedRead, cwd: string, builtin: boolean): void {
		this.sources.delete(event.toolCallId);
		if (!this.options?.enabled || !builtin || event.toolName !== "read" || event.isError || event.details !== undefined
			|| !exactKeys(event.input, ["path"]) || typeof event.input.path !== "string"
			|| !Array.isArray(event.content) || event.content.length !== 1) return;
		const block: unknown = event.content[0];
		if (!isRecord(block) || !exactKeys(block, ["type", "text"]) || block.type !== "text" || typeof block.text !== "string") return;
		const file = this.allowedFile(event.input.path, cwd);
		if (!file) return;
		const source = snapshot(file);
		if (!source || source.text !== block.text || Buffer.byteLength(source.text) < 512) return;
		if (this.sources.size >= 512) {
			const oldest = this.sources.keys().next().value;
			if (oldest !== undefined) this.sources.delete(oldest);
		}
		this.sources.set(event.toolCallId, { file, stamp: source.stamp, digest: contentDigest(event.input, event.content) });
	}

	private current(candidate: Candidate, view: SelectionView, recent: ReadonlySet<string>, pins: ReadonlySet<string>): boolean {
		const { original, source } = candidate;
		if (original.ref.sessionId !== view.sessionId || pins.has(original.ref.toolCallId) || recent.has(original.ref.toolCallId)) return false;
		const found = findResult(view.sessionId, view.entries, original.ref.entryId);
		if (!found || found.ref.digest !== original.ref.digest || found.message.isError || found.message.details !== undefined || this.protectedTools.has(found.message.toolName)) return false;
		const active = view.messages.filter(message => message.role === "toolResult" && message.toolCallId === original.ref.toolCallId);
		const calls = view.messages.flatMap(message => message.role === "assistant"
			? message.content.filter(content => content.type === "toolCall" && content.id === original.ref.toolCallId) : []);
		if (active.length !== 1 || calls.length !== 1 || canonicalJson(active[0]) !== canonicalJson(found.message)
			|| canonicalJson(calls[0]) !== canonicalJson(found.call)) return false;
		if (this.allowedFile(source.file, view.cwd) !== source.file) return false;
		try { return stamp(statSync(source.file, { bigint: true })) === source.stamp; }
		catch { return false; }
	}

	private candidates(view: SelectionView): Candidate[] {
		const pins = protectedCalls(view);
		if (!pins) return [];
		const recent = protectedByRecency(view.messages, this.turns, this.maxSteps);
		const result: Candidate[] = [];
		for (const entry of view.entries) {
			if (result.length === MAX_CANDIDATES) break;
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const source = this.sources.get(entry.message.toolCallId);
			if (!source) continue;
			const original = findResult(view.sessionId, view.entries, entry.id);
			if (!original || this.attempted.has(original.ref.digest)
				|| source.digest !== contentDigest(original.call.arguments, entry.message.content)) continue;
			const candidate = { id: `c${result.length}`, original, source };
			if (this.current(candidate, view, recent, pins)) result.push(candidate);
		}
		return result;
	}

	/** Authorize exact bytes once. Network awaits never occur in policy/apply. */
	async score(
		view: SelectionView, task: string, authorize: (preview: string) => Promise<boolean>,
		latest: () => SelectionView, infer: Inference = (request, signal) => requestJev(request, readKey(), signal),
	): Promise<"disabled" | "busy" | "budget" | "no-candidates" | "declined" | "stale" | "scored" | "failed"> {
		if (!this.options?.enabled) return "disabled";
		if (this.stats.attempts >= 4) return "budget";
		if (task !== this.taskBrief) {
			this.invalidate();
			this.taskBrief = task;
		}
		if (this.busy) return "busy";
		const candidates = this.candidates(view);
		if (!candidates.length) return "no-candidates";
		const request = makeRequest(task, candidates.map(candidate => ({ id: candidate.id,
			text: candidate.original.message.content.map(block => block.type === "text" ? block.text : "").join("\n") })));
		const preview = JSON.stringify(request, null, 2);
		const epoch = this.epoch;
		this.busy = true;
		const cancellation = new AbortController();
		this.cancellation = cancellation;
		let started: number | undefined;
		try {
			const approvalStarted = performance.now();
			const approved = await authorize(preview);
			this.stats.approvalMs += performance.now() - approvalStarted;
			if (!approved) return "declined";
			const current = latest();
			const pins = protectedCalls(current);
			const recent = protectedByRecency(current.messages, this.turns, this.maxSteps);
			if (epoch !== this.epoch || !pins || candidates.some(candidate => !this.current(candidate, current, recent, pins))) return "stale";
			for (const candidate of candidates) this.attempted.add(candidate.original.ref.digest);
			this.stats.attempts++;
			started = performance.now();
			const response = await infer(request, cancellation.signal);
			this.stats.completed++;
			this.stats.model = response.model;
			this.stats.inputTokens += response.usage.input_tokens;
			this.stats.outputTokens += response.usage.output_tokens;
			if (epoch !== this.epoch) return "stale";
			const now = latest();
			const nowPins = protectedCalls(now);
			const nowRecent = protectedByRecency(now.messages, this.turns, this.maxSteps);
			if (!nowPins || candidates.some(candidate => !this.current(candidate, now, nowRecent, nowPins))) return "stale";
			if (response.probabilities.size !== candidates.length) throw new Error("Unexpected Jev judgments");
			const judgments: Array<{ candidate: Candidate; probability: number; model: string }> = [];
			for (const candidate of candidates) {
				const probability = response.probabilities.get(candidate.id);
				if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Invalid Jev judgment");
				judgments.push({ candidate, probability, model: response.model });
			}
			for (const judgment of judgments) this.scores.set(judgment.candidate.original.ref.toolCallId, judgment);
			return "scored";
		} catch {
			this.stats.failures++;
			return epoch !== this.epoch ? "stale" : "failed";
		} finally {
			if (started !== undefined) this.stats.elapsedMs += performance.now() - started;
			this.busy = false;
			if (this.cancellation === cancellation) this.cancellation = undefined;
		}
	}

	policy(view: SelectionView): SelectionPolicy {
		this.stats.protectionBlocked = true;
		this.stats.currentEstimatedTokensRemoved = 0;
		this.stats.currentResultsOmitted = 0;
		const pins = protectedCalls(view);
		const keep = new Set(pins ?? []);
		const omit = new Map<string, string>();
		if (!pins || !this.options) return { hold: true, keep, omit };
		for (const id of pins) {
			if (!view.messages.some(message => message.role === "toolResult" && message.toolCallId === id
				|| message.role === "assistant" && message.content.some(content => content.type === "toolCall" && content.id === id))) continue;
			const entry = view.entries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
			if (!entry || prepareRecovery(view.sessionId, view.entries, view.messages, entry.id, 0).kind !== "present") return { hold: true, keep, omit };
		}
		this.stats.protectionBlocked = false;
		if (!this.options.enabled) return { hold: false, keep, omit };
		try {
			if (realpathSync(view.cwd) !== realpathSync(this.options.project)) return { hold: false, keep, omit };
		} catch {
			this.stats.protectionBlocked = true;
			return { hold: true, keep, omit };
		}
		const recent = protectedByRecency(view.messages, this.turns, this.maxSteps);

		// Only SCORED candidates are protected from the deterministic strategies:
		// scored-and-retained results join keep, scored-and-droppable ones go to
		// omit. Everything unscored stays free for dedup/overlap/decay/purge.
		for (const [id, { candidate, probability, model }] of this.scores) {
			if (model === this.stats.model && this.options.dropBelow !== null && probability < this.options.dropBelow && this.current(candidate, view, recent, pins)) {
				omit.set(id, candidate.original.ref.entryId);
			} else {
				keep.add(id);
			}
		}
		return { hold: false, keep, omit };
	}

	apply<T extends AnyMessage>(messages: T[], policy: SelectionPolicy, original: T[] = messages): T[] {
		this.stats.currentEstimatedTokensRemoved = 0;
		this.stats.currentResultsOmitted = 0;
		if (policy.hold) return original;
		const output = messages.map(message => {
			if (!isToolResult(message) || policy.keep.has(message.toolCallId) || isAlreadyPlaceholder(message)) return message;
			const ref = policy.omit.get(message.toolCallId);
			if (!ref) return message;
			const marker = `[pruned by pi-dcp: Jev-selected result ${ref}; /dcp jev restore ${ref}]`;
			const before = message.content.reduce((sum, block) => sum + (block.type === "text" ? approxTokens(block.text) : 0), 0);
			const removed = before - approxTokens(marker);
			if (removed <= 0) return message;
			const copy = cloneForMutation(message);
			copy.content = [{ type: "text", text: marker }];
			this.stats.currentEstimatedTokensRemoved += removed;
			this.stats.currentResultsOmitted++;
			return copy;
		});
		if (!protectedUnchanged(original, output, policy.keep)) {
			this.stats.currentEstimatedTokensRemoved = 0;
			this.stats.currentResultsOmitted = 0;
			this.stats.protectionBlocked = true;
			return original;
		}
		return output;
	}
}
