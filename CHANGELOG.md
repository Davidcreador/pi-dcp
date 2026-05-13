# Changelog

All notable changes to **pi-dcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Davidcreador/pi-dcp/compare/v0.1.1...HEAD
[0.1.0]: https://github.com/Davidcreador/pi-dcp/releases/tag/v0.1.0
