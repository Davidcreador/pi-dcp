# pi-dcp

Dynamic Context Pruning for [Pi](https://github.com/earendil-works/pi-coding-agent). A port of [`@tarquinen/opencode-dcp`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (AGPL-3.0) tailored to pi's extension API.

Cuts token usage in long sessions through three independent mechanisms:

| Mechanism | What it does | When it runs |
|---|---|---|
| Deduplication | Same tool + same args → keep only the newest result. Older duplicates become placeholders. | Every LLM call (auto) |
| Errored input purge | Strips the **arguments** of failed tool calls after N turns. Error message is kept. | Every LLM call (auto) |
| `compress` tool | LLM-callable. Replaces a range of tool results with a high-fidelity summary. | When the model decides |

Session history on disk is never modified. Only the request payload sent to the model is pruned.

## Install

This package is meant to live under `~/.pi/agent/extensions/pi-dcp/` and is auto-discovered by pi on startup. No further wiring needed.

To install from scratch:

```bash
git clone <this repo> ~/.pi/agent/extensions/pi-dcp
# restart pi
```

## Develop

```bash
cd ~/.pi/agent/extensions/pi-dcp
npm run check    # typecheck + tests (20 tests, no external deps)
npm run test     # tests only (Node ≥ 22, --experimental-strip-types)
```

The extension itself has zero npm dependencies at runtime — only a peer
dependency on `@earendil-works/pi-coding-agent`.

## Configuration

A starter `config.json` is written to `~/.pi/agent/extensions/pi-dcp/` on first run. Project-level overrides go in `<repo>/.pi/dcp.json`. See [SKILL.md](skills/pi-dcp/SKILL.md) for all knobs.

## Slash commands

```
/dcp              show command list
/dcp context      session token usage + savings + active compressions
/dcp stats        lifetime savings across all sessions
/dcp sweep [n]    manually stage a compression over last n tool results
/dcp manual on|off   stop the LLM from auto-calling compress (manual mode)
/dcp decompress <id>  temporarily restore a stored compression
/dcp recompress <id>  re-apply a decompressed entry
```

## How it differs from upstream opencode-dcp

- Uses pi's built-in `ctx.getContextUsage()` instead of `@anthropic-ai/tokenizer`. Per-message savings are approximated with the ~4-chars-per-token heuristic.
- No auto-update from npm (lives in `~/.pi`; `git pull` to update).
- Soft/hard nudges live in `before_agent_start` system-prompt overrides rather than per-request injection (functionally equivalent).

Feature parity:
- `compress.mode: "range" | "message"` — both implemented; `"message"` is the default.
- `turnProtection.{enabled,turns}` — same semantics; in pi-dcp the compress tool *refuses upfront* if its targets land inside the protected window (upstream is more permissive).
- `compress.modelMinLimits` / `modelMaxLimits` — per-model overrides keyed by `"<provider>/<id>"` matching pi's model registry.
- `compress.iterationNudgeThreshold` — fire an iteration nudge after N non-user messages since the last user message.
- `compress.nudgeForce: "soft" | "strong"` — controls wording strength of the in-window nudge.
- `compress.nudgeFrequency` per-request throttle — stacks with pi-dcp's `nudgeEveryTurns` per-turn throttle.
- Editable prompt overrides — set `experimental.customPrompts: true`, then drop files into `~/.pi/agent/extensions/pi-dcp/prompts/overrides/{soft-nudge,strong-nudge,hard-nudge,iteration-nudge,compress-message,compress-range}.md`.
- `manualMode.enabled` with `manualMode.automaticStrategies` — same semantics as upstream. Runtime override via `/dcp manual`.
- Skipped: `pruneNotificationType: "toast"` (no toast UI), `compress.{showCompression,summaryBuffer}` (UI/advanced accounting), `experimental.allowSubAgents` (pi's subagent model differs), `protectedFilePatterns` (no-op when empty).

## Files

```
index.ts                     extension entry; wires hooks, tool, /dcp command
lib/config.ts                config loader, default config, % resolution
lib/logger.ts                ~/.pi-dcp/dcp.log writer
lib/state.ts                 per-session in-memory state
lib/stats.ts                 ~/.pi-dcp/stats.json lifetime counters
lib/messages.ts              AgentMessage helpers + placeholder writer
lib/strategies/
  deduplication.ts           drop redundant tool calls
  purge-errors.ts            strip errored tool inputs after N turns
lib/pipeline.ts              orchestrates strategies + applies compressions
lib/compress-tool.ts         registerTool() the `compress` tool
lib/nudges.ts                system-prompt nudges near context ceiling
lib/commands/
  help.ts | context.ts | stats.ts | manual.ts | sweep.ts | decompress.ts
skills/pi-dcp/SKILL.md       documentation surface for pi
```

## License

AGPL-3.0-or-later (inherits upstream).
