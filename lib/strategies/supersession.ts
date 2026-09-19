/**
 * Supersession strategy.
 *
 * A read (or bash read-alike) whose file was later modified by a successful
 * edit/write is stale: its content no longer reflects the file on disk, so
 * the result is placeholdered with a pointer to re-read. Only the LAST
 * successful modification per path matters — a read newer than every
 * modification stays.
 *
 * Runs after overlap dedup (which may already have placeholdered the read;
 * isAlreadyPlaceholder keeps the count honest) and before size-age decay,
 * which then skips the tiny placeholder.
 *
 * The pipeline passes us a working array of CLONED messages (see pipeline.ts
 * for cloning policy). We mutate that array in place; never the originals.
 */
import { basename, resolve } from "node:path";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	isAlreadyPlaceholder,
	isAssistant,
	isExcerpt,
	isToolResult,
	placeholderToolResult,
	toolCallsOf,
} from "../messages.ts";
import type { SessionState } from "../state.ts";
import { readRange, type ReadRange } from "./overlap-dedup.ts";

export interface SupersessionResult {
	supersededCount: number;
	tokensSaved: number;
}

export function applySupersession(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protectedByTurn: Set<string> = new Set(),
): SupersessionResult {
	if (!config.strategies.supersession.enabled) {
		return { supersededCount: 0, tokensSaved: 0 };
	}
	const protectedTools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.strategies.supersession.protectedTools,
		...config.compress.protectedTools,
	]);

	// 1. Map toolCallId -> read range, and edit/write callId -> modified path.
	const callIdToRead = new Map<string, ReadRange>();
	const modCallPaths = new Map<string, string>();
	for (const m of messages) {
		if (!isAssistant(m)) continue;
		for (const call of toolCallsOf(m)) {
			if ((call.name === "edit" || call.name === "write") && typeof call.arguments.path === "string") {
				modCallPaths.set(call.id, resolve(call.arguments.path));
				continue;
			}
			if (protectedTools.has(call.name)) continue;
			const range = readRange(call);
			if (range) callIdToRead.set(call.id, range);
		}
	}
	if (!callIdToRead.size || !modCallPaths.size) return { supersededCount: 0, tokensSaved: 0 };

	// 2. Latest successful modification result index per path. A modification
	//    only counts when its result exists and did not error.
	const latestModIndex = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!isToolResult(m) || m.isError) continue;
		const path = modCallPaths.get(m.toolCallId);
		if (path !== undefined) latestModIndex.set(path, i);
	}
	if (!latestModIndex.size) return { supersededCount: 0, tokensSaved: 0 };

	// 3. Any read older than the latest successful modification of its path is
	//    stale. Idempotent via state.supersededCallIds.
	let supersededCount = 0;
	let tokensSaved = 0;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!isToolResult(m) || m.isError) continue;
		if (protectedTools.has(m.toolName)) continue;
		if (protectedByTurn.has(m.toolCallId)) continue;
		if (isAlreadyPlaceholder(m) || isExcerpt(m)) continue;
		const range = callIdToRead.get(m.toolCallId);
		if (!range) continue;
		const modIndex = latestModIndex.get(range.path);
		if (modIndex === undefined || modIndex <= i) continue;
		const saved = placeholderToolResult(m,
			`stale read of ${basename(range.path)}: file was modified by a later edit/write; re-read for current content`);
		if (!state.supersededCallIds.has(m.toolCallId)) {
			state.supersededCallIds.add(m.toolCallId);
			supersededCount++;
			tokensSaved += saved;
		}
	}

	state.stats.superseded += supersededCount;
	state.stats.tokensSaved += tokensSaved;
	return { supersededCount, tokensSaved };
}
