---
name: pi-dcp
description: Use the pi-dcp Dynamic Context Pruning tools and slash commands to keep long pi sessions cheap. Triggers on long tutoring or coding loops, repeated tool failures, "context filling up" nudges, and any request to compress, summarize, or inspect token usage.
---

# pi-dcp — Dynamic Context Pruning

`pi-dcp` is a pi extension that reduces token spend in long sessions through three mechanisms:

1. **Automatic deduplication** — When the same tool is called with the same arguments more than once, only the latest output is sent to the LLM. Older duplicates are replaced with `[pruned by pi-dcp: duplicate ... call]`.
2. **Errored input purging** — Tool calls that errored out have their *inputs* stripped after `strategies.purgeErrors.turns` turns (default: 4). The error message is preserved so the model can still recover; only the (often huge) failed payload is removed.
3. **LLM-callable `compress` tool** — The model can decide to summarize closed work-streams into a lossless technical summary. The summary replaces the original tool outputs on the next LLM request.

## When to call `compress`

Call `compress(toolCallIds, topic, summary)` when:

- A discovery phase is finished (initial repo scan, finding the bug location) and you no longer need the raw `grep`/`read` output.
- A long failing retry loop has been resolved and the verbose failures are no longer informative.
- A logically closed sub-task is complete and you can move on with just the conclusions.

**Never compress** the most recent turn, in-flight work, or anything containing facts the user just asked about. Compressions preserve only what is in the `summary` argument — be terse but lossless on file paths, line numbers, errors, and decisions.

## Slash commands

| Command | Purpose |
|---|---|
| `/dcp` | Show command list |
| `/dcp context` | Current session token usage + DCP savings + active compressions |
| `/dcp stats` | Cumulative lifetime DCP savings across all sessions |
| `/dcp sweep [n]` | Stage a compression over the last `n` tool results (default: since last user msg) |
| `/dcp manual [on\|off\|toggle\|status]` | Control runtime manual mode (edit config to persist) |
| `/dcp decompress <id>` | Temporarily restore a compression's original tool outputs |
| `/dcp recompress <id>` | Re-apply a previously decompressed entry |

## Configuration

Defaults are auto-written to `~/.pi/agent/extensions/pi-dcp/config.json` on first run. Per-project overrides go in `<repo>/.pi/dcp.json`. Restart pi (or `/reload`) after changes.

Notable knobs:

- `compress.mode` — `"message"` (default; LLM lists individual toolCallIds) or `"range"` (LLM gives start+end and we resolve the span).
- `compress.minContextLimit` / `compress.maxContextLimit` — soft floor/ceiling. Below the floor: no nudge. Between floor and ceiling: soft nudge in system prompt. At/above ceiling: hard nudge. Accepts a number or `"X%"` of the model's context window.
- `compress.modelMinLimits` / `modelMaxLimits` — per-model overrides keyed by `"<provider>/<id>"`.
- `compress.permission` — `"allow"` (default), `"ask"`, or `"deny"` (tool not registered at all).
- `compress.nudgeForce` — `"soft"` (gentle wording) or `"strong"` (aggressive wording) for the in-window nudge.
- `compress.nudgeFrequency` (per-fetch) and `compress.nudgeEveryTurns` (per-turn) — stacked throttles for the soft/strong nudge.
- `compress.iterationNudgeThreshold` — fire an iteration nudge after N non-user messages since the last user message, even below the context floor. 0 disables.
- `turnProtection.enabled` / `turns` — the last N user-bounded turns are immune to ALL pruning. The compress tool also REFUSES UPFRONT if its targets land inside this window.
- `manualMode.enabled` / `automaticStrategies` — silence the LLM compress tool and optionally also skip dedup/purge. Stored compressions still apply.
- `experimental.customPrompts` — honor user overrides in `prompts/overrides/{soft-nudge,strong-nudge,hard-nudge,iteration-nudge,compress-message,compress-range}.md`.
- `strategies.deduplication.enabled` / `strategies.purgeErrors.enabled` — independent on/off switches.
- `*.protectedTools` — additional tool names that must never be pruned (e.g. custom write/edit tools).

## Guardrails (always on)

`compress`, `write`, `edit`, `todo`, `task`, and `skill` are *never* deduplicated or purged. Their outputs are also appended verbatim when included in a compression range.
