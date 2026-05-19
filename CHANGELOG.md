# Changelog

All notable changes to **pi-dcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-05-19

### Fixed (root causes vs opencode-dcp)

- **State persistence** (biggest gap). Compressions, dedup tracking, errored-call
  records, and turn index are now saved to `~/.pi-dcp/sessions/{sessionId}.json`
  after every agent turn and on session shutdown. On next launch the same session
  resumes with all compressions intact. Previous versions lost all state on restart.
  New module: `lib/persistence.ts`.

- **Missing `session_compact` handler**. When pi runs built-in compaction all old
  tool-call IDs vanish from the message stream, but pi-dcp still held references
  to them in `dedupedCallIds`, `purgedErrorCallIds`, `appliedCompressionTargets`,
  and `erroredAt`. Those stale IDs silently poisoned subsequent pipeline passes.
  `session_compact` now calls `resetTrackingAfterCompaction()` which clears the
  ID sets. Compressions are preserved (user explicitly asked for them).

- **Missing `session_start` handler**. Without it there was no way to know the
  session ID, so state could never be restored. The handler now calls
  `ctx.sessionManager.getSessionId()`, seeds `state.sessionId`, and triggers
  state restore. Stale session files older than 30 days are pruned opportunistically.

- **Missing `session_shutdown` handler**. State was never saved; `agent_end` is
  now the primary save point (survives crashes) with `session_shutdown` as a
  belt-and-suspenders flush.

- **Null token count after compaction**. `ctx.getContextUsage().tokens` returns
  `null` right after compaction (before the first LLM response). Nudges used
  `tokens !== null` as a guard, so they were silenced at exactly the moment they
  were needed most. The nudge handler now caches `state.lastKnownTokens` from
  each non-null usage reading and falls back to it when the current value is null.
  `session_compact` resets this cache so pre-compaction numbers don't carry forward.

- **Inaccurate token counting**. All token estimates now go through `lib/tokens.ts`
  which tries `@anthropic-ai/tokenizer` (the same tokenizer Anthropic uses) with
  a graceful fallback to `Math.ceil(length / 4)` when it is not installed. Affects
  savings estimates shown in `/dcp context`, nudge threshold comparisons, and the
  footer chip.

### Added

- `lib/persistence.ts` — `saveSessionState`, `restoreSessionState`,
  `resetTrackingAfterCompaction`, `pruneOldSessionFiles`.
- `lib/tokens.ts` — `countTokens`, `estimateTokensBatch`, `approxTokens` backed
  by the Anthropic tokenizer with a char-count fallback.
- `state.sessionId` — session ID populated on `session_start`, used for persistence.
- `state.lastKnownTokens` — last non-null token count, used as nudge fallback.

[0.2.0]: https://github.com/Davidcreador/pi-dcp/releases/tag/v0.2.0

## [0.1.2] — 2026-05-13

### Fixed

- **User-visible feedback for pipeline work.** The `pruneNotification` config
  knob was declared but never read, so users could go entire sessions seeing
  no evidence that pi-dcp was running — even though it was, and the lifetime
  `~/.pi-dcp/stats.json` was accumulating real savings (~200k tokens / 30+
  sessions in personal use). The bug was zero plumbing between
  `pruneNotification` and the UI, not the pipeline itself.

### Added

- `lib/notifications.ts` — dispatches feedback after every pipeline pass:
  - **`pruneNotification: "minimal"`** (default): persistent footer status
    chip `DCP: ~24.3k saved` that updates whenever new pruning happens.
    Shows `DCP: idle` on the first context event so users know the extension
    is wired in.
  - **`pruneNotification: "detailed"`**: footer status + an inline
    `ctx.ui.notify` toast for each pass that did work, formatted like
    `pi-dcp: 2 duplicates, 1 errored call purged (~3.2k tokens)`.
  - **`pruneNotification: "off"`**: neither.
- The `context` event handler now passes `ctx` (was `_ctx`) into the new
  dispatcher.

[0.1.2]: https://github.com/Davidcreador/pi-dcp/releases/tag/v0.1.2

## [0.1.1] — 2026-05-13

### Fixed

- Added `typebox` to `peerDependencies` per the official Pi packages spec.
  Previously typebox was imported but not declared; npm install would resolve
  it transitively from `@earendil-works/pi-coding-agent` but the spec calls
  for an explicit `"*"` peer-dep alongside `@earendil-works/pi-coding-agent`.

### Added

- `pi.image` field in `package.json` pointing to `assets/preview.png` so
  pi-dcp shows a preview card on [pi.dev/packages](https://pi.dev/packages).

[0.1.1]: https://github.com/Davidcreador/pi-dcp/releases/tag/v0.1.1

## [0.1.0] — 2026-05-13

### Distribution

- Published as **`@davecodes/pi-dcp`** on npm. Install via `pi install npm:@davecodes/pi-dcp`.

First formal release. Full opencode-dcp feature parity, installable via `pi install`.

### Added

- **`pi install` support.** Pi clones the repo to `~/.pi/agent/git/<host>/<path>/`,
  registers in `~/.pi/agent/settings.json`, and auto-loads on next launch.
  User state always lives at `~/.pi-dcp/` (config, prompts, logs, stats) —
  independent of where pi puts the code.
- **`compress` tool, message and range modes.** LLM-callable summarizer.
  Message mode takes `toolCallIds[]`; range mode takes `startToolCallId`
  and `endToolCallId` and resolves the span against the session branch.
- **`turnProtection.{enabled,turns}`.** Protect the last N user-bounded
  turns from ALL pruning. Compress tool refuses upfront on overlap with
  reason `protected_window_overlap`.
- **`compress.modelMinLimits` / `modelMaxLimits`.** Per-model context-limit
  overrides keyed by `"<provider>/<id>"`. Shipped defaults for Anthropic
  Claude 4.x (haiku, sonnet, opus 4-1 through 4-7) and OpenAI GPT-5.x.
- **`compress.iterationNudgeThreshold`.** Fire an iteration nudge after N
  non-user messages since the last user message (0 disables).
- **`compress.nudgeForce`** — `"soft"` (gentle) or `"strong"` (aggressive)
  wording for the in-window nudge.
- **`compress.nudgeFrequency`** — per-request soft-nudge throttle; stacks
  with `nudgeEveryTurns` per-turn throttle.
- **`compress.mode`** — `"range"` (default in shipped config) or `"message"`.
- **`manualMode.{enabled,automaticStrategies}`.** Silence the LLM compress
  tool and optionally also skip dedup/purge. Stored compressions still
  apply. Runtime override via `/dcp manual`.
- **`experimental.customPrompts`.** When true, honors user overrides at
  `~/.pi-dcp/prompts/overrides/{soft-nudge,strong-nudge,hard-nudge,iteration-nudge,compress-message,compress-range}.md`.
  Defaults regenerated each launch under `~/.pi-dcp/prompts/defaults/`.
- **Deduplication strategy.** Same `toolName + canonical-json(args)` →
  keep newest result, placeholder older copies.
- **Errored input purge strategy.** Failed tool calls have their arguments
  replaced after `purgeErrors.turns` turns. Error message preserved.
- **`/dcp` slash commands**: `context`, `stats`, `sweep [n]`,
  `manual [on|off|toggle|status]`, `decompress <id>`, `recompress <id>`.
- **Production-tuned `DEFAULT_CONFIG`**: turnProtection on (turns=3),
  compress.mode=range, nudgeForce=strong, nudgeFrequency=3,
  iterationNudgeThreshold=8, purgeErrors.turns=2.
- **AGPL-3.0-or-later** LICENSE, CI workflow (Node 22/24), README badges.

### Tests

- 55 unit tests covering: canonicalJson determinism, dedup behaviour,
  pipeline mutation safety + idempotency, purgeErrors turn aging,
  compression application + suspension, nudge throttling (soft/strong,
  per-turn, per-fetch, iteration), config % resolution, strict id
  parsing, turnProtection edges, per-model lookup, compress tool
  protected-window overlap refusal, PromptStore regen + override paths.

### Credits

Concept and prompt design ported from [`@tarquinen/opencode-dcp`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) by tarquinen.

[Unreleased]: https://github.com/Davidcreador/pi-dcp/compare/v0.1.2...HEAD
[0.1.0]: https://github.com/Davidcreador/pi-dcp/releases/tag/v0.1.0
