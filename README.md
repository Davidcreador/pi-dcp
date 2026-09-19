# Pi-Dynamic-Context-Pruning

Cut LLM token spend in long [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) sessions, automatically. Dedup redundant tool calls, strip errored payloads, and let the model summarize closed work-streams — without rewriting original session entries.

A faithful port of [@tarquinen/opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) tailored to pi's extension API.

License: AGPL-3.0-or-later. Run `npm run check` for local validation.

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Slash commands](#slash-commands)
- [Configuration reference](#configuration-reference)
- [Experimental Jev context selection](#experimental-jev-context-selection)
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

pi-dcp prunes all three before the request hits the model. Pruning changes the request view, not original session entries. Explicit protection/recall controls append metadata or a new reference-data message; native compaction can still remove originals from the active context.

## How it works

A `context` event fires on every outbound LLM request. pi-dcp clones messages it changes and returns a transformed request view. The original entries are not rewritten.

Three independent mechanisms run on the outbound request:

| Mechanism | What it does | When |
|---|---|---|
| Deduplication | Same `toolName + canonical(args)` keeps the newest result and replaces older copies with a `[pruned by pi-dcp: duplicate ... call]` marker. | Every LLM call (auto) |
| Errored input purge | Failed tool calls have their arguments stripped after N turns. Error message is preserved. | Every LLM call (auto) |
| `compress` tool | LLM-callable. Replaces a span of tool results with a technical summary. Two modes: `message` (per-id list) or `range` (start and end span). | When the model decides |

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
| `/dcp decompress <id>` | Confirm durable protection and suspend a compression; archived output requires recall |
| `/dcp recompress <id>` | Release that compression's protection reason; independent owner pins remain |
| `/dcp jev stats` | Runtime judgments, model, attempts, timing and estimated reduction |
| `/dcp jev score <task>` | Review and approve one complete task/source payload for TypeSafe |
| `/dcp jev continue` | Explicitly confirm one agent turn for the scored task |
| `/dcp jev cancel` | Cancel transient decisions; pins remain |
| `/dcp jev restore\|release\|recall <result-entry-id>` | Native-confirmed protection or bounded exact-text recall |

Slash commands work in interactive pi mode only — `pi -p` (print mode) does not dispatch them. The compress tool and auto strategies work in both modes.

## Configuration reference

Defaults are written to `~/.pi-dcp/config.json` on first run. Per-project overrides at `<repo>/.pi/dcp.json` merge on top, except the owner-global-only `jev` namespace. Restart pi after edits.

The shipped defaults are tuned for real-world long sessions — see `config.example.json` in this repo for the exact reference shape and inline comments.

```json
{
  "enabled": true,
  "debug": false,
  "jev": { "enabled": false, "project": "", "files": [], "dropBelow": null, "auto": false, "task": "" },
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
    "turns": 3,
    "maxSteps": 30
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
    "overlapDedup": {
      "enabled": true,
      "protectedTools": []
    },
    "supersession": {
      "enabled": true,
      "protectedTools": []
    },
    "sizeAgeDecay": {
      "enabled": true,
      "minTokens": 1500,
      "minAgeSteps": 12,
      "headLines": 30,
      "tailLines": 15,
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
- `turnProtection.maxSteps`: cap on assistant steps protected within those turns; long agentic turns expose older steps to pruning.
- `compress.minContextLimit` / `maxContextLimit`: number of tokens or a `"X%"` string of the model's context window.
- `compress.nudgeEveryTurns`: per-turn soft-nudge throttle.
- `compress.nudgeFrequency`: per-request soft-nudge throttle (stacks with the per-turn one).
- `compress.iterationNudgeThreshold`: 0 disables; fires after N messages since the last user message.
- `compress.nudgeForce`: `soft` or `strong` wording.
- `strategies.purgeErrors.turns`: turns after which errored args are purged.

Always protected (never pruned, regardless of config): `compress`, `write`, `edit`, `todo`, `task`, `skill`.

## Experimental Jev context selection

**Disabled by default. No accuracy, real cost or latency benefit has been established.**
Jev answers typed relevance questions; local code controls eligibility and omission.
This is not a new supervisor or a native-compaction replacement.

The `jev` namespace is accepted **only from owner-global `~/.pi-dcp/config.json`**.
Repository `.pi/dcp.json` cannot enable it, expand source scope or change the cutoff.
For a separately approved trial, configure an exact canonical project and relative files:

```json
{
  "jev": {
    "enabled": false,
    "project": "/absolute/canonical/project",
    "files": ["src/parser.ts"],
    "dropBelow": null,
    "auto": false,
    "task": ""
  }
}
```

Set `enabled` only when ready for a trial, then reload/restart the trial extension.
`dropBelow: null` is shadow mode. A numeric cutoff is restricted to `[0, 0.1]`;
**none is calibrated or recommended yet**. Only probabilities strictly below it
can omit a result. Enabling this conservative mode also keeps stored compressions,
deduplication and failed-input purge from bypassing unapproved/uncertain results.
It can therefore send **more** context than ordinary DCP in that project. Other
canonical project roots keep ordinary DCP behavior plus independent pins; an
unresolvable configured scope holds pruning closed.

### Eligible data and explicit controls

- Only successful, observed built-in-tagged `read` calls: whole-file text, no offset/limit,
  no result details/truncation, exact matching persisted/current output and file snapshot.
  Unobserved historical reads, images, aliases/symlinks and unknown provenance stay visible.
- Exact source-file allowlist; common hidden, instruction, documentation, test,
  evidence and credential paths are excluded. These checks **are not secret detection**.
  Use only a trusted local runtime: registry tags cannot attest arbitrary tool overrides.
- At least the last three user-bounded turns remain protected, even if legacy turn
  protection is disabled. Fixed tools, pins and suspended compressions also win.
- `/dcp jev score <nonsecret task>` requires native TUI confirmation, then an editor
  showing the **complete actual JSON payload**. Submit unchanged to approve; Esc cancels.
  It contains the supplied task, opaque IDs and complete eligible text, not transcripts,
  arbitrary arguments, memory bodies or added path metadata. Inspect it before sending.
- Bounds: 2,048 task bytes, 512–6,000 bytes/result, four results/batch, 32,768 request
  bytes, 65,536 response bytes, eight seconds/request, four attempted batches per loaded
  session. No automatic retry; reload/session start resets transient budgets and observations.
- Credentials are read only after approval: `TYPESAFE_API_KEY`, then `TYPESAFE_KEY`,
  otherwise one bounded literal `TYPESAFE_KEY` assignment in `~/.zshrc`. No shell evaluation.
- Scoring never waits inside the context hook or starts an agent turn. While idle,
  `/dcp jev continue` explicitly resumes the scored task. Ordinary new input invalidates
  decisions; so do task changes, relevant writes, compaction and navigation. No consent
  or score is imported from another session. Resolved-model changes invalidate reuse.

### Protection and recovery

`/dcp jev stats` lists result-entry IDs for judgments. `restore <id>` writes a pin
and protects a present original pair; `release <id>` removes only its owner reason.
Pins replay from branch-local Pi metadata, not an expiring DCP sidecar.
`/dcp recompress` also lists durable compression protection after sidecar loss;
`/dcp recompress <id>` can release that reason with native confirmation even if
the summary is missing or cached as already active. It cannot recreate a missing
summary, and owner/other compression reasons remain protected. Invalid
metadata or mismatched protected originals retains the incoming view; inspect
`protectionBlocked` in stats. Disabling scoring does not release pins.

For an archived result on the current ancestry, `recall <id>` requires an idle
agent, native confirmation, complete text and conservative headroom. It appends a
new labelled reference-data message immediately to that branch, **without starting
a model turn**. It never inserts an orphan old tool result, re-executes a tool,
searches another session or silently truncates. Unknown budget or oversized/missing
content is refused. Pins cannot stop native compaction later removing active bytes.
Foreign-session pin references inherited through forks hold pruning closed; automatic
reference migration and parent-session lookup are not implemented.

### Measurement limits

`/dcp jev stats` separates attempted/completed requests, reported Jev tokens,
attempt wall time, approval time, and current-view estimated reductions. Failed or
cancelled requests can still incur unknown provider cost. Cached judgments need not
remain eligible. These counters are not invoices or proof of task quality.

`test/jev-benchmark.test.ts` compares original, ordinary-DCP and protected-Jev views
using synthetic data and injected judgments. It includes both reduction and a case
where conservative retention costs more tokens. Before choosing a cutoff or wider
rollout, measure critical-information misses, actual provider/cache costs, recovery,
compaction frequency and end-to-end task latency on explicitly approved data.

### Installed-host verification

Direct `npm run check` uses local dependencies. To verify a different installed
Pi, run `node test/check-host.mjs /absolute/path/to/pi-coding-agent` inside a
credential-free, network-isolated environment with disposable `HOME`/`TMPDIR`.
It loads the extension and every test through that host's real extension loader,
with a separate home/process per test file. The loaded handlers also exercise
context, reload with missing/stale sidecars, native refusal, compaction and exact
recall against a real host in-memory SessionManager and local UI/action adapters.
No model agent session or authentication is initialized. Core imports follow host
aliases; non-core dependencies stay local.

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
  test/                             unit tests and synthetic fixtures
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
