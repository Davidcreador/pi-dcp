# Pi-Dynamic-Context-Pruning

Cut LLM token spend in long [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) sessions, automatically. Dedup redundant tool calls, strip errored payloads, and let the model summarize closed work-streams — all without ever modifying your session history.

A faithful port of [@tarquinen/opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) tailored to pi's extension API. Zero npm dependencies at runtime.

License: AGPL-3.0-or-later. Tests: 55 passing on Node 22 and 24.

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Slash commands](#slash-commands)
- [Configuration reference](#configuration-reference)
- [Per-model context limits](#per-model-context-limits)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)
- [Develop](#develop)
- [How it differs from opencode-dcp](#how-it-differs-from-opencode-dcp)
- [Project layout](#project-layout)
- [Credits and license](#credits-and-license)

## Why

A long agentic loop in Pi typically wastes tokens on:

- Repeated lookups — the same `grep` or `read` re-issued five turns later
- Failed payloads — a 4-KB `bash` command that errored, sent back to the model on every subsequent turn
- Closed work-streams — initial repo scans, abandoned approaches, resolved retry loops whose raw output is no longer useful

pi-dcp prunes all three before the request hits the model. The on-disk session is never touched — pruning is applied to the request payload only, so `/tree`, `/compact`, fork, and resume all keep the originals intact.

## How it works

A `context` event fires on every outbound LLM request. pi-dcp hooks that event, rewrites the request payload in-place, and lets it continue to the provider. The on-disk session is never mutated.

Three independent mechanisms run on the outbound request:

| Mechanism | What it does | When |
|---|---|---|
| Deduplication | Same `toolName + canonical(args)` keeps the newest result and replaces older copies with a `[pruned by pi-dcp: duplicate ... call]` marker. | Every LLM call (auto) |
| Errored input purge | Failed tool calls have their arguments stripped after N turns. Error message is preserved. | Every LLM call (auto) |
| `compress` tool | LLM-callable. Replaces a span of tool results with a lossless technical summary. Two modes: `message` (per-id list) or `range` (start and end span). | When the model decides |

Plus three nudge surfaces that bias the model toward compressing:

- Soft or strong in-system-prompt nudge when usage crosses `minContextLimit`
- Hard nudge above `maxContextLimit`
- Iteration nudge after N non-user messages without a user reply

## Install

Three ways. Pick one:

npm (recommended — versioned, easy to update):

```bash
pi install npm:@davecodes/pi-dcp
```

git (always tracks `main`):

```bash
pi install git:github.com/Davidcreador/pi-dcp
```

manual clone (for hacking on the code):

```bash
git clone git@github.com:Davidcreador/pi-dcp.git ~/.pi/agent/extensions/pi-dcp
```

All three paths produce the same runtime behavior. Pi auto-discovers the extension via its `pi.extensions` package.json entry.

User state always lives at `~/.pi-dcp/`, not next to the code. That directory holds:

```
~/.pi-dcp/
  config.json              your settings (written on first run from defaults)
  prompts/
    defaults/              regenerated each launch (read-only reference)
    overrides/             drop *.md files here to customize the LLM prompts
  dcp.log                  debug log (when config.debug is true)
  stats.json               lifetime savings counters
```

To update:

```bash
pi update npm:@davecodes/pi-dcp
```

## Quick start

After install, run pi normally. Verify the extension is live:

```bash
pi -p "do you have a tool called 'compress'? answer yes/no"
```

Expected output: `yes`.

Open a long session as usual. Check savings any time with:

```
/dcp context     # this session
/dcp stats       # lifetime, across sessions
```

To bias the model toward compressing more aggressively, edit `~/.pi-dcp/config.json`:

```json
{
  "compress": {
    "minContextLimit": "30%",
    "maxContextLimit": "60%",
    "nudgeForce": "strong"
  }
}
```

`minContextLimit` is the soft-nudge floor. `maxContextLimit` is the hard-nudge ceiling. Restart pi after config changes.

## Slash commands

| Command | What it does |
|---|---|
| `/dcp` | Show this command list |
| `/dcp context` | Current session: token usage, DCP savings, active compressions |
| `/dcp stats` | Lifetime savings across all pi sessions |
| `/dcp sweep [n]` | Stage a compression over the last n tool results (default: since last user message). Use to nuke unwanted output. |
| `/dcp manual on/off/toggle/status` | Runtime manual mode — stops the LLM from auto-compressing. Edit `config.json` to persist. |
| `/dcp decompress <id>` | Temporarily restore a stored compression's original tool outputs |
| `/dcp recompress <id>` | Re-apply a previously decompressed entry |

Slash commands work in interactive pi mode only — `pi -p` (print mode) does not dispatch them. The compress tool and auto strategies work in both modes.

## Configuration reference

Defaults are written to `~/.pi-dcp/config.json` on first run. Per-project overrides at `<repo>/.pi/dcp.json` shallow-merge on top. Restart pi after edits.

The shipped defaults are tuned for real-world long sessions — see `config.example.json` in this repo for the exact reference shape and inline comments.

```json
{
  "enabled": true,
  "debug": false,
  "pruneNotification": "minimal",

  "experimental": {
    "customPrompts": false
  },

  "manualMode": {
    "enabled": false,
    "automaticStrategies": true
  },

  "turnProtection": {
    "enabled": true,
    "turns": 3
  },

  "compress": {
    "mode": "range",
    "permission": "allow",
    "minContextLimit": 30000,
    "maxContextLimit": 70000,
    "modelMinLimits": {
      "anthropic/claude-opus-4-7": 35000
    },
    "modelMaxLimits": {
      "anthropic/claude-opus-4-7": 85000
    },
    "nudgeEveryTurns": 5,
    "nudgeFrequency": 3,
    "iterationNudgeThreshold": 8,
    "nudgeForce": "strong",
    "protectedTools": []
  },

  "strategies": {
    "deduplication": {
      "enabled": true,
      "protectedTools": []
    },
    "purgeErrors": {
      "enabled": true,
      "turns": 2,
      "protectedTools": []
    }
  }
}
```

Field notes:

- `pruneNotification`: `off`, `minimal`, or `detailed` (reserved).
- `experimental.customPrompts`: when `true`, honors `prompts/overrides/*.md`.
- `manualMode.automaticStrategies`: when manual mode is on, still run dedup and purge.
- `turnProtection.turns`: last N user-bounded turns are immune to pruning.
- `compress.minContextLimit` / `maxContextLimit`: number of tokens or a `"X%"` string of the model's context window.
- `compress.nudgeEveryTurns`: per-turn soft-nudge throttle.
- `compress.nudgeFrequency`: per-request soft-nudge throttle (stacks with the per-turn one).
- `compress.iterationNudgeThreshold`: 0 disables; fires after N messages since the last user message.
- `compress.nudgeForce`: `soft` or `strong` wording.
- `strategies.purgeErrors.turns`: turns after which errored args are purged.

Always protected (never pruned, regardless of config): `compress`, `write`, `edit`, `todo`, `task`, `skill`.

## Per-model context limits

`compress.modelMinLimits` and `modelMaxLimits` accept keys shaped as `provider/id`, matching `ctx.model.provider` and `ctx.model.id`. Examples mirroring the shipped `config.json`:

| Model | Window | Soft floor | Hard ceiling | Strategy |
|---|---|---|---|---|
| `anthropic/claude-haiku-4-5` | 200k | 30k | 70k | tight — cheap fast tier |
| `anthropic/claude-sonnet-4-5` | 200k | 50k | 120k | workhorse band |
| `anthropic/claude-sonnet-4-6` | 200k | 50k | 120k | workhorse band |
| `anthropic/claude-opus-4-1` to `4-7` | 200k | 35k | 85k | aggressive — save expensive tokens |
| `openai/gpt-5.4-mini-fast` | — | 25k | 50k | tightest |
| `openai/gpt-5.4-mini` | — | 30k | 70k | tight |
| `openai/gpt-5.5` | — | 45k | 100k | medium |

Values accept either a number (absolute token count) or a `"X%"` string (percentage of the model's context window).

## Recipes

### Save tokens aggressively on premium models

```json
{
  "compress": {
    "modelMinLimits": { "anthropic/claude-opus-4-7": "10%" },
    "modelMaxLimits": { "anthropic/claude-opus-4-7": "25%" },
    "nudgeForce": "strong"
  }
}
```

### Do not auto-compress, let me drive

```json
{
  "manualMode": { "enabled": true, "automaticStrategies": true }
}
```

Auto-dedup and purge still run. You drive compression via `/dcp sweep`.

### Project-specific overrides

Drop a `.pi/dcp.json` in the repo root:

```json
{
  "strategies": {
    "purgeErrors": {
      "turns": 1,
      "protectedTools": ["lint"]
    }
  }
}
```

### Customize the nudge wording

```json
{
  "experimental": { "customPrompts": true }
}
```

Then create `~/.pi-dcp/prompts/overrides/strong-nudge.md` with your text. Restart pi.

## Troubleshooting

The compress tool is not showing up:

- Confirm with `pi -p "list your tools" 2>&1 | grep compress`. If missing, check `compress.permission` is not `"deny"`.
- Restart pi after any config change. Extensions load once at startup.

Nothing is being pruned:

- `/dcp context` shows live stats. If always 0:
  - `turnProtection.turns` may cover your whole session (recent turns are protected).
  - `strategies.*.enabled` may be `false`.
  - You may be hitting protected tools — `write` and `edit` are never deduped.

See what is happening under the hood:

```json
{ "debug": true }
```

Restart pi. Logs land at `~/.pi-dcp/dcp.log`:

```
[2026-05-13T...] INFO pi-dcp initialized {"mode":"range",...}
[2026-05-13T...] INFO pipeline applied {"dedupPruned":2,"errorInputsPurged":1,"tokensSaved":3214}
```

Compress tool refuses with `protected_window_overlap`:

- The model picked tool-call IDs that live inside `turnProtection.turns`. Either lower `turnProtection.turns`, disable it, or tell the model to pick older calls.

## Develop

```bash
cd ~/.pi/agent/extensions/pi-dcp

# Set up dev deps (peer + typescript)
npm install --no-save typescript @earendil-works/pi-coding-agent

# Typecheck + test
npm run check
npm run test
```

CI on GitHub Actions runs the same on Node 22 and 24 against every push and PR.

## How it differs from opencode-dcp

| Feature | opencode-dcp | pi-dcp |
|---|---|---|
| Tokenizer | `@anthropic-ai/tokenizer` | `ctx.getContextUsage()` (built-in) |
| Auto-update | npm latest check | `git pull` |
| Soft/hard nudges | per-request injection | `before_agent_start` system-prompt addendum (functionally equivalent) |
| `compress.mode` (range, message) | both | both |
| `turnProtection` | runtime skip | runtime skip plus upfront refusal of compress tool overlap |
| `modelMinLimits` and `modelMaxLimits` | yes | yes |
| `iterationNudgeThreshold` | yes | yes |
| `nudgeForce` | yes | yes |
| `compress.nudgeFrequency` | yes | yes, plus per-turn `nudgeEveryTurns` |
| Prompt overrides | yes | yes |
| `manualMode.automaticStrategies` | yes | yes |
| Skipped in pi-dcp | — | `pruneNotificationType:"toast"`, `compress.showCompression`, `compress.summaryBuffer`, `experimental.allowSubAgents`, `protectedFilePatterns` |

## Project layout

```
pi-dcp/
  index.ts                          extension entry — wires hooks, tool, /dcp command
  config.json                       runtime config (auto-generated; tracked)
  lib/
    config.ts                       loader, DEFAULT_CONFIG, percent + per-model resolution
    logger.ts                       ~/.pi-dcp/dcp.log writer (gated by config.debug)
    state.ts                        per-session in-memory state
    stats.ts                        ~/.pi-dcp/stats.json lifetime counters (atomic write)
    messages.ts                     AgentMessage helpers + canonical JSON + cloneForMutation
    pipeline.ts                     orchestrates strategies + applies compressions
    nudges.ts                       soft/strong/hard/iteration system-prompt addendums
    strategies/
      deduplication.ts              drop redundant tool calls
      purge-errors.ts               strip errored tool inputs after N turns
    tools/
      compress-message.ts           LLM tool — per-id mode
      compress-range.ts             LLM tool — span mode
      shared.ts                     preflight, storeCompression, branchToolCallIds
    prompts/
      index.ts                      PromptStore + defaults + override loader
    commands/                       /dcp subcommand handlers
      help.ts
      context.ts
      stats.ts
      manual.ts
      sweep.ts
      decompress.ts                 decompress + recompress
  test/                             55 unit tests, zero external deps
    pipeline.test.ts                dedup, purge, mutation safety, idempotency
    misc.test.ts                    config percent parsing, nudge throttling, parseStrictId
    features.test.ts                range mode, prompt overrides, manual modes, nudgeFreq
    parity.test.ts                  turnProtection, modelMin/Max, iterationNudge, nudgeForce
    audit.test.ts                   edge cases (no-user, iter-refire, protected overlap)
  skills/pi-dcp/SKILL.md            documentation surface pi reads at session start
  prompts/defaults/                 regenerated on every init (read-only reference)
  prompts/overrides/                you put files here when customPrompts is true
  .github/workflows/ci.yml          Node 22/24 matrix typecheck + test
  README.md
```

## Credits and license

Concept and prompt design ported from [@tarquinen/opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) by tarquinen. Pi adaptation and tests by [@Davidcreador](https://github.com/Davidcreador).

License: AGPL-3.0-or-later — inherits from upstream. See `LICENSE`.
