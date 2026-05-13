# pi-dcp

[![CI](https://github.com/Davidcreador/pi-dcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Davidcreador/pi-dcp/actions/workflows/ci.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-55%20passing-brightgreen.svg)](#develop)
[![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-43853d.svg)](https://nodejs.org)

> **Cut LLM token spend in long [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) sessions, automatically.**
> Dedup redundant tool calls, strip errored payloads, and let the model summarize closed work-streams — all without ever modifying your session history.

A faithful port of [`@tarquinen/opencode-dcp`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) tailored to pi's extension API. Zero npm dependencies at runtime.

---

## Contents

- [Why?](#why)
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
- [Credits & license](#credits--license)

---

## Why?

A long agentic loop in Pi typically wastes tokens on:

- **Repeated lookups** — the same `grep`/`read` re-issued five turns later
- **Failed payloads** — a 4-KB `bash` command that errored, sent back to the model on every subsequent turn
- **Closed work-streams** — initial repo scans, abandoned approaches, resolved retry loops whose raw output is no longer useful

pi-dcp prunes all three before the request hits the model. **The on-disk session is never touched** — pruning is applied to the request payload only, so `/tree`, `/compact`, fork, and resume all keep the originals intact.

## How it works

```
                ┌────────────────────────────────────────────┐
   user msg ──▶ │  pi agent loop                             │
                │                                            │
                │   on("context", event) ◄── pi-dcp prunes   │
                │       │                                    │
                │       └─▶ provider request ──▶ LLM         │
                └────────────────────────────────────────────┘
```

Three independent mechanisms run on the **outbound** request:

| Mechanism | What it does | When |
|---|---|---|
| **Deduplication** | Same `toolName + canonical(args)` → keep newest result, replace older with `[pruned by pi-dcp: duplicate ... call]`. | Every LLM call (auto) |
| **Errored input purge** | Failed tool calls have their *arguments* stripped after N turns. Error message preserved. | Every LLM call (auto) |
| **`compress` tool** | LLM-callable. Replaces a span of tool results with a lossless technical summary. Two modes: `message` (per-id list) or `range` (start+end span). | When the model decides |

Plus three nudge surfaces that bias the model toward compressing:

- **soft / strong** in-system-prompt nudge when usage crosses `minContextLimit`
- **hard** nudge above `maxContextLimit`
- **iteration** nudge after N non-user messages without a user reply

## Install

```bash
git clone git@github.com:Davidcreador/pi-dcp.git ~/.pi/agent/extensions/pi-dcp
# restart pi
```

That's it. Pi auto-discovers extensions under `~/.pi/agent/extensions/*/`. The first launch writes a starter `config.json` and a `prompts/defaults/` reference tree.

To **update**:

```bash
cd ~/.pi/agent/extensions/pi-dcp && git pull
```

## Quick start

After install, run pi normally. Verify the extension is live:

```bash
pi -p "do you have a tool called 'compress'? answer yes/no"
# → yes
```

Open a long session as usual. Check savings any time with:

```
/dcp context     # this session
/dcp stats       # lifetime, across sessions
```

To bias the model toward compressing more aggressively, edit `~/.pi/agent/extensions/pi-dcp/config.json`:

```jsonc
{
  "compress": {
    "minContextLimit": "30%",   // soft nudge starts at 30% of context window
    "maxContextLimit": "60%",   // hard nudge starts at 60%
    "nudgeForce": "strong"      // aggressive nudge text
  }
}
```

Restart pi after config changes.

## Slash commands

| Command | What it does |
|---|---|
| `/dcp` | Show this command list |
| `/dcp context` | Current session: token usage + DCP savings + active compressions |
| `/dcp stats` | Lifetime savings across all pi sessions |
| `/dcp sweep [n]` | Stage a compression over the last *n* tool results (default: since last user message). Use to nuke unwanted output. |
| `/dcp manual [on\|off\|toggle\|status]` | Runtime manual mode — stops the LLM from auto-compressing. Edit `config.json` to persist. |
| `/dcp decompress <id>` | Temporarily restore a stored compression's original tool outputs |
| `/dcp recompress <id>` | Re-apply a previously decompressed entry |

> Slash commands work in interactive pi mode only — `pi -p` (print mode) won't dispatch them. The compress tool and auto strategies work in **both** modes.

## Configuration reference

Defaults are written to `~/.pi/agent/extensions/pi-dcp/config.json` on first run. Per-project overrides at `<repo>/.pi/dcp.json` shallow-merge on top. **Restart pi after edits.**

```jsonc
{
  "enabled": true,
  "debug": false,
  "pruneNotification": "minimal",        // off | minimal | detailed (reserved)

  "experimental": {
    "customPrompts": false              // honor prompts/overrides/*.md when true
  },

  "manualMode": {
    "enabled": false,                    // silence the compress tool + nudges
    "automaticStrategies": true          // when manual: still run dedup/purge
  },

  "turnProtection": {
    "enabled": true,
    "turns": 3                           // last N user-bounded turns are immune to pruning
  },

  "compress": {
    "mode": "range",                     // "range" or "message"
    "permission": "allow",               // "allow" | "ask" | "deny"
    "minContextLimit": 30000,            // soft floor — number or "X%"
    "maxContextLimit": 70000,            // hard ceiling — number or "X%"
    "modelMinLimits": {                  // per-model overrides (see below)
      "anthropic/claude-opus-4-7": 35000
    },
    "modelMaxLimits": {
      "anthropic/claude-opus-4-7": 85000
    },
    "nudgeEveryTurns": 5,                // per-turn soft-nudge throttle
    "nudgeFrequency": 3,                 // per-request soft-nudge throttle (stacks)
    "iterationNudgeThreshold": 8,        // 0 disables; fires after N msgs since user msg
    "nudgeForce": "strong",              // "soft" or "strong" wording
    "protectedTools": []
  },

  "strategies": {
    "deduplication": {
      "enabled": true,
      "protectedTools": []               // additional tools to NEVER dedup
    },
    "purgeErrors": {
      "enabled": true,
      "turns": 2,                        // turns after which errored args are purged
      "protectedTools": []
    }
  }
}
```

**Always protected** (never pruned, regardless of config): `compress`, `write`, `edit`, `todo`, `task`, `skill`.

## Per-model context limits

`compress.modelMinLimits` and `modelMaxLimits` accept keys shaped as `"<provider>/<id>"` matching `ctx.model.provider` / `ctx.model.id`. Examples mirroring the shipped `config.json`:

| Model | Window | Soft floor | Hard ceiling | Strategy |
|---|---|---|---|---|
| `anthropic/claude-haiku-4-5` | 200k | 30k | 70k | tight — cheap fast tier |
| `anthropic/claude-sonnet-4-5` | 200k | 50k | 120k | workhorse band |
| `anthropic/claude-sonnet-4-6` | 200k | 50k | 120k | workhorse band |
| `anthropic/claude-opus-4-1`..`4-7` | 200k | 35k | 85k | aggressive — save expensive tokens |
| `openai/gpt-5.4-mini-fast` | — | 25k | 50k | tightest |
| `openai/gpt-5.4-mini` | — | 30k | 70k | tight |
| `openai/gpt-5.5` | — | 45k | 100k | medium |

Values accept either a number (absolute token count) or a `"X%"` string (percentage of the model's context window).

## Recipes

### "Save tokens aggressively on premium models"

```jsonc
"compress": {
  "modelMinLimits": { "anthropic/claude-opus-4-7": "10%" },
  "modelMaxLimits": { "anthropic/claude-opus-4-7": "25%" },
  "nudgeForce": "strong"
}
```

### "Don't auto-compress, let me drive"

```jsonc
"manualMode": { "enabled": true, "automaticStrategies": true }
```

Auto-dedup and purge still run. You drive compression via `/dcp sweep`.

### "Project-specific overrides"

Drop a `.pi/dcp.json` in the repo root:

```jsonc
{
  "strategies": {
    "purgeErrors": {
      "turns": 1,                        // I retry fast, purge fast
      "protectedTools": ["lint"]         // never strip lint runs
    }
  }
}
```

### "Customize the nudge wording"

```jsonc
"experimental": { "customPrompts": true }
```

Then create `~/.pi/agent/extensions/pi-dcp/prompts/overrides/strong-nudge.md` with your text. Restart pi.

## Troubleshooting

**The compress tool isn't showing up**
- Confirm: `pi -p "list your tools" 2>&1 | grep compress`. If missing, check `compress.permission` isn't `"deny"`.
- Restart pi after any config change. Extensions load once at startup.

**Nothing is being pruned**
- `/dcp context` shows live stats. If always 0:
  - `turnProtection.turns` may cover your whole session (recent turns are protected).
  - `strategies.*.enabled` may be `false`.
  - You may be hitting protected tools (`write`/`edit`/etc. are never deduped).

**See what's happening under the hood**

```jsonc
{ "debug": true }
```

Restart pi. Logs land at `~/.pi-dcp/dcp.log`:

```
[2026-05-13T...] INFO pi-dcp initialized {"mode":"range",...}
[2026-05-13T...] INFO pipeline applied {"dedupPruned":2,"errorInputsPurged":1,"tokensSaved":3214}
```

**Compress tool refuses with `protected_window_overlap`**
- The model picked tool-call IDs that live inside `turnProtection.turns`. Either lower `turnProtection.turns`, disable it, or tell the model to pick older calls.

## Develop

```bash
cd ~/.pi/agent/extensions/pi-dcp

# Set up dev deps (peer + typescript)
npm install --no-save typescript @earendil-works/pi-coding-agent

# Typecheck + test
npm run check    # tsc --noEmit + 55 unit tests
npm run test     # tests only — Node ≥ 22, --experimental-strip-types
```

CI on GitHub Actions runs the same on Node 22 and 24 against every push and PR.

## How it differs from opencode-dcp

| | opencode-dcp | pi-dcp |
|---|---|---|
| Tokenizer | `@anthropic-ai/tokenizer` | `ctx.getContextUsage()` (built-in) |
| Auto-update | npm latest check | `git pull` |
| Soft/hard nudges | per-request injection | `before_agent_start` system-prompt addendum (functionally equivalent) |
| `compress.mode` | range \| message | ✅ both |
| `turnProtection` | runtime skip | ✅ + upfront refusal of compress tool overlap |
| `modelMin/MaxLimits` | ✅ | ✅ |
| `iterationNudgeThreshold` | ✅ | ✅ |
| `nudgeForce` | ✅ | ✅ |
| `compress.nudgeFrequency` | ✅ | ✅ + per-turn `nudgeEveryTurns` |
| Prompt overrides | ✅ | ✅ |
| `manualMode.automaticStrategies` | ✅ | ✅ |
| Skipped | — | `pruneNotificationType:"toast"`, `compress.{showCompression,summaryBuffer}`, `experimental.allowSubAgents`, `protectedFilePatterns` |

## Project layout

```
pi-dcp/
├── index.ts                          extension entry — wires hooks, tool, /dcp command
├── config.json                       runtime config (auto-generated; tracked)
├── lib/
│   ├── config.ts                     loader, DEFAULT_CONFIG, % + per-model resolution
│   ├── logger.ts                     ~/.pi-dcp/dcp.log writer (gated by config.debug)
│   ├── state.ts                      per-session in-memory state
│   ├── stats.ts                      ~/.pi-dcp/stats.json lifetime counters (atomic write)
│   ├── messages.ts                   AgentMessage helpers + canonical JSON + cloneForMutation
│   ├── pipeline.ts                   orchestrates strategies + applies compressions
│   ├── nudges.ts                     soft/strong/hard/iteration system-prompt addendums
│   ├── strategies/
│   │   ├── deduplication.ts          drop redundant tool calls
│   │   └── purge-errors.ts           strip errored tool inputs after N turns
│   ├── tools/
│   │   ├── compress-message.ts       LLM tool — per-id mode
│   │   ├── compress-range.ts         LLM tool — span mode
│   │   └── shared.ts                 preflight, storeCompression, branchToolCallIds
│   ├── prompts/
│   │   └── index.ts                  PromptStore + defaults + override loader
│   └── commands/                     /dcp subcommand handlers
│       ├── help.ts
│       ├── context.ts
│       ├── stats.ts
│       ├── manual.ts
│       ├── sweep.ts
│       └── decompress.ts             decompress + recompress
├── test/                             55 unit tests, zero external deps
│   ├── pipeline.test.ts              dedup, purge, mutation safety, idempotency
│   ├── misc.test.ts                  config % parsing, nudge throttling, parseStrictId
│   ├── features.test.ts              range mode, prompt overrides, manual modes, nudgeFreq
│   ├── parity.test.ts                turnProtection, modelMin/Max, iterationNudge, nudgeForce
│   └── audit.test.ts                 edge cases (no-user, iter-refire, protected overlap)
├── skills/pi-dcp/SKILL.md            documentation surface pi reads at session start
├── prompts/defaults/                 regenerated on every init (read-only reference)
├── prompts/overrides/                you put files here when customPrompts:true
├── .github/workflows/ci.yml          Node 22/24 matrix typecheck + test
└── README.md
```

## Credits & license

Concept and prompt design ported from [`@tarquinen/opencode-dcp`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) by tarquinen. Pi adaptation and tests by [@Davidcreador](https://github.com/Davidcreador).

**License:** AGPL-3.0-or-later — inherits from upstream. See [LICENSE](LICENSE).
