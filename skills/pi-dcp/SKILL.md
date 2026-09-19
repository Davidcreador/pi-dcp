---
name: pi-dcp
description: Use the pi-dcp Dynamic Context Pruning tools and slash commands to keep long pi sessions cheap. Triggers on long tutoring or coding loops, repeated tool failures, "context filling up" nudges, and any request to compress, summarize, or inspect token usage.
---

# pi-dcp — Dynamic Context Pruning

`pi-dcp` is a pi extension that reduces token spend in long sessions through three mechanisms:

1. **Automatic deduplication** — When the same tool is called with the same arguments more than once, only the latest output is sent to the LLM. Older duplicates are replaced with `[pruned by pi-dcp: duplicate ... call]`.
2. **Errored input purging** — Tool calls that errored out have their *inputs* stripped after `strategies.purgeErrors.turns` turns (default: 4). The error message is preserved so the model can still recover; only the (often huge) failed payload is removed.
3. **LLM-callable `compress` tool** — The model can decide to summarize closed work-streams into a technical summary. The summary replaces the original tool outputs on the next LLM request.

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
| `/dcp decompress <id>` | Confirm durable protection and suspend a compression; archived output requires recall |
| `/dcp recompress <id>` | Release the compression's protection reason, not independent owner pins |
| `/dcp jev stats` | Inspect judgments, IDs, model, overhead and estimated reductions |
| `/dcp jev score <task>` | Owner confirms one complete task/source payload before TypeSafe inference |
| `/dcp jev continue` | Explicitly confirm one turn for the scored task |
| `/dcp jev cancel` | Invalidate transient decisions, not pins |
| `/dcp jev restore\|release\|recall <result-entry-id>` | Native-confirmed protection or bounded exact-text recall |

## Experimental Jev selection

Disabled by default; configure `jev` only in owner-global `~/.pi-dcp/config.json`.
The exact canonical project/file allowlist does not authorize automatic uploads:
each batch requires native confirmation and the complete unchanged payload preview.
RPC dialogs and user-role text do not grant authority. No key lookup or network
request occurs for disabled, ineligible or declined batches.

Only observed, successful whole-file text reads with exact bounded source/output
matching are eligible. Unknown/partial/truncated/image results, pins and at least
three recent user turns remain visible. A trusted runtime is required; source tags
alone do not attest tool overrides. Read the full payload: path filters are not
secret detection.

`dropBelow: null` is shadow mode. No numeric cutoff is calibrated. Opt-in retention
also blocks legacy DCP strategies from bypassing protected/uncertain content, so
it may use more tokens than ordinary DCP in the configured project. Other canonical
projects keep ordinary DCP plus independent pins; unresolved scope fails closed.
New input, changed tasks, compaction and navigation invalidate decisions. Scoring never starts a turn; `continue` explicitly
does. Recall requires idle/headroom and appends labelled exact text to the current
branch without starting a turn or fabricating an old tool result.

Pins are durable against DCP, not native compaction. `/dcp recompress` lists durable
compression protection even after sidecar loss; `recompress <id>` releases only that
reason after native confirmation, without recreating an unavailable summary.
Invalid/foreign metadata holds
pruning closed; do not repair it by searching other sessions or releasing pins
from assistant/peer prose. Inspect `protectionBlocked` in stats. Synthetic tests
are not accuracy, cache, billing or workflow-latency evidence. See README for bounds
and the evaluation prerequisites.

## Configuration

Defaults are auto-written to `~/.pi-dcp/config.json` on first run. Per-project overrides go in `<repo>/.pi/dcp.json`. Restart pi (or `/reload`) after changes.

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
