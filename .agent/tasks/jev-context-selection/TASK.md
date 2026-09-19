# Jev context selection — first implementation slice

Goal: use narrow typed Jev judgments to reduce total workflow cost/latency without degrading task correctness. Existing routing, preparation/classification and advisory verification remain unchanged; this slice addresses the missing DCP context-selection path.

## Authority and scope

Original implementation authorization: Dave approved implementation and an isolated worktree. Installed extension/config, unrelated panes, staging, delivery and real-session disclosure were out of scope. The later activation authorization below supersedes only those explicitly expanded permissions. Worktree: `feat/jev-context-selection`, baseline `7ae24be`. Design: `/tmp/jev-compaction-design.md` revision 2.

First slice uses explicit owner-triggered batches, not autonomous uploads. Default disabled; shadow scoring until an evaluated cutoff is explicitly configured. Exact project/file allowlist plus full immutable payload preview/confirmation before each request. No API key lookup when disabled/no candidates/declined. No cross-session context.

## Evidence and risk

Baseline: 57 tests PASS; strict source typing PASS using TypeScript 5.9.3 (`npm exec` cache). Initial `npm run check` could not find tsc; no baseline code failures. Existing dependencies are linked for resolution only. Subsequent tests use isolated HOME because existing tests call DCP lifetime-stat helpers.

High implementation risk: external disclosure, asynchronous state and durable pins. The original implementation checkpoint was neither staged nor formally approved. Delivery requires authorized staging and fresh required-role evidence; do not mistake mocks or this plan for approval.

Observed seams: `index.ts` context/command/lifecycle hooks; `lib/pipeline.ts` shared recency set already reaches compression/dedup/purge; `lib/messages.ts` clones; `lib/persistence.ts` sidecars expire. Pi 0.74.0 supports `getBranch`, exported `buildSessionContext`, `appendEntry` and `sendMessage`.

SourceInfo does not attest every runtime override; truncation metadata absence alone is insufficient. V1 supports observed whole-file text `read` only, no offset/limit, exact owner-allowlisted canonical file. Verify full output equals a bounded local file snapshot, then bind content/arguments; later output changes are not certified. Unobserved, non-builtin-tagged, altered, image, partial and truncated outputs stay visible. Arbitrary runtime overrides cannot be attested: a trusted runtime remains a prerequisite. No core-tool replacement or directory crawling.

## Flow

    original branch/results -> shared protection -> complete approved snapshots
      -> owner payload confirmation -> one bounded Jev batch
      -> validated task/data-bound scores -> request-view-only omission

Network never runs or blocks inside the context hook. Native compaction remains intact. New task/input/navigation/compaction cancels stale work; pins survive cache resets. No automatic retries or duplicate scoring.

## Bounded implementation

1. Protection/recovery Module: stable references, validated metadata pin/release actions, current-branch replay, protected call arguments/results across all DCP strategies. Restore present pairs in place; archived results require explicit labelled custom-message recall, never an orphan toolResult. Fail closed on invalid metadata; no original entry rewrites.
2. Selection Module and TypeSafe Adapter: closed response schema, bounded requests/responses/deadline, lazy literal credentials, fixed HTTPS/no redirects/retries. Owner-triggered previewed batches; local cutoff (null means shadow), fixed batch/body/request caps, per-session request budget. Keep uncertain/stale/failed/unapproved content.
3. Integrate commands/hooks and metrics. Record Jev tokens/roundtrip and current-view estimated savings without logging bodies. Fixture comparisons are not real provider billing/cache or task-quality evidence.

## Test contract

RED then GREEN for each changed behavior. Protect pinned older duplicates, failed-call arguments and mixed compression spans. Preserve source objects, exact content and protocol pairs. Replay pins across compaction/reload; navigation never silently imports other branches. Reject malformed pin/response/config schemas, unexpected IDs, bad/huge/nonfinite numbers and stale references. Zero requests on disabled/declined/no-candidate paths. Full payload contents must exactly match preview; no hidden reasoning, arbitrary arguments, paths or unrelated outputs. Deadline/cancel must retain content; repeated hooks do not duplicate inference/counters. Recall has explicit unavailable/over-budget outcomes and no automatic model turn.

## Verification and limits

Ponytail full and semantic-directness loaded before first code edit. Manual source sweep: no unapproved TypeSafe code uploads. Strictly type source and new tests; run complete regressions with isolated HOME. No calibrated relevance cutoff, real-world accuracy, net savings, formal review or activation claims without the corresponding later evidence.

## Implemented contract and findings

- Jev configuration is owner-global only; project overrides cannot enable disclosure, widen files or change cutoff.
- Four candidates/batch, 512–6,000 result bytes, 2,048 task bytes, 32,768 request bytes, 65,536 response bytes, eight-second deadline, four attempted batches per loaded session. Session start/reload resets observations and transient budget.
- Preview and wire serialization match. Only native TUI confirmation can authorize the payload editor or pin/recall/continue effects; ordinary RPC dialogs and invented context metadata are not authority.
- Pins and legacy suspended targets share protection. A final protected-output comparison returns the original view and zero Jev reduction on mismatch. Bad/foreign pin metadata holds pruning closed.
- Scoring never starts a model turn. Ordinary input cancels scores; explicit `/dcp jev continue` confirms a turn for the declared task. Recall requires idle, rechecks headroom and appends immediately to the current branch without starting a turn.
- A task-local read-only SDK check found three concrete integration bugs: nonexistent `ctx.mode`, cross-branch `nextTurn` queues, and confirmation not bound to navigation. All were repaired with failing/passing regression evidence. This check is not formal Reviewer/Breaker evidence.
- Additional RED/GREEN fixes cover changed task briefs, global-owner config, declared truncation, exact preview bytes, final protection validation and new-session budgets.
- Pins inherited with foreign session IDs intentionally hold pruning closed. Automatic fork-reference migration and parent-history lookup remain unsupported.

## Manual Ponytail classifications

- Fixed: context-hook `as any` escapes, duplicated suspension lookup and unsupported SDK mode assumptions.
- Retained-required: closed external schemas, full-file observation checks, native owner confirmation, immutable preview, durable pin validation, final guard and lifecycle cancellation. These are trust/data-loss boundaries, not optional polish.
- Skipped: a separate TypeSafe SDK, automatic scoring, new model/gate routing, cross-session caches, source crawling, unsupported output formats, speculative performance refactors and automatic fork migration. No source bundle was sent to TypeSafe for deslop.
- Verification limitation: synthetic judgments prove transformation/protection behavior, not semantic relevance accuracy. Single-run timings include cold tokenizer/concurrent-test effects and are not workflow benchmarks.

## Local evidence

- Runtime under test: Node 26.8.2, worktree SDK 0.74.0, cached TypeScript 5.9.3. Node 22/24 CI and the installed host's loader were not exercised.
- Final verification after manual Ponytail: canonical `npm run check` PASS, 92/92 tests; source and new-test strict typing PASS; whitespace and example JSON checks PASS; index empty. Evidence: `/tmp/jev-dcp-final-check.txt`, `/tmp/jev-dcp-final-types.txt`; actual SDK read/control checks: `/tmp/jev-dcp-sdk-final.txt`.
- Synthetic comparison: approved obsolete fixture reduced serialized estimates from ordinary DCP's 655 to 362; unapproved duplicate fixture increased 807 to 1,115. Required fixture evidence remained intact in both. No provider cost/cache or end-to-end speed conclusion follows.
- Installed checkout still has only its pre-existing untracked `.pi-subagents/`; installed source and live configuration were not edited. Initial baseline tests were not HOME-isolated and may have changed lifetime counters; all subsequent verification was isolated.
- At this implementation checkpoint there was no staging, commit, push, activation, live inference or formal approval. Later separately approved synthetic/API work is recorded externally; it does not authorize real-session disclosure.

## Everyday activation authorization and plan

Dave subsequently requested everyday harness activation, chose manual opt-in shadow scoring, and explicitly approved scoped staging plus required Reviewer/Breaker release checks. He chose project/files later: install commands, keep scoring disabled (`enabled: false`, `project: ""`, `files: []`, `dropBelow: null`). No setup Jev/benchmark inference, commit, push, unrelated changes or broad harness sync is authorized.

Observed evidence: the actual installed Pi 0.85.1 loader registers this extension and returns disabled Jev stats without network; source/new-test types pass against explicit host aliases. Direct unit tests otherwise resolve 0.74.0. Bundled docs mention retainedTail, but installed runtime/declarations implement only firstKeptEntryId; future checkpoint support is not claimed. Enabled shadow policy currently suppresses ordinary DCP outside its configured project.

Selected route: High, because the complete previously unapproved candidate changes disclosure, async lifecycle and durable protection. One writer, existing plan identity, required Reviewer and Breaker, at most two review batches. Remaining rollout budget: 45 minutes for repair, verification, review and activation; stop for material overrun or inconclusive evidence.

Bounded changes and acceptance:
1. `lib/jev-selection.ts`: apply Jev retention only in its exact canonical project. Outside projects retain normal DCP plus independent pin/legacy protection. Unresolvable scope still fails closed. Add RED/GREEN regression in `test/jev-benchmark.test.ts`.
2. Test actual host loader/context/compaction/recovery and native refusal/RPC undefined paths offline; no CLI agent session, auth storage or inference setup. Preserve source/new-test strict checks and full isolated regression suite. No new production seam, dependency or scoring command.
3. Complete manual Ponytail/directness, then exact-path staging and High gate evidence. No formal approval is implied by preflight tests or earlier advisory delegates.
4. After approval only: export exact reviewed code to a versioned local package snapshot under `~/.local/share/agent-harness/packages/pi-dcp-jev/`; reuse existing dependencies without edits. Replace only the native global Pi DCP package source, preserving other settings and the old installed checkout. Verify snapshot identity, disabled scoring and a single DCP load, then reload Pi.

Rollback: restore the prior DCP package source from a retained settings backup, preserving concurrent unrelated settings changes, then reload. Do not point live Pi at the mutable development worktree. No harness sync/migration apply or package download is needed. Project-specific package overrides are not inventoried across unrelated repositories.

Pre-review evidence (not approval): `scope-red.log` reproduced outside-project retention and unresolved-scope failures; `scope-green.log` passes after the six-line policy repair. Canonical isolated checks pass 94/94 tests on local SDK 0.74.0. `test/check-host.mjs` passes the full suite plus extension load/stats smoke (95/95) through actual Pi 0.85.1 aliases, including real read provenance, native y/n/Escape, RPC undefined refusal, compaction and recall. Both source/new-test type environments and strict checkJs for the host runner pass. All runtime checks ran with an empty credential environment, isolated HOME/TMPDIR, read-only host tree and a Bubblewrap network namespace. Artifacts: `/tmp/jev-activation-W6tBh5/`. The generated host-runner fixtures exercise runtime API calls; production source/new tests remain strictly typed. No unsupported retainedTail claim.

Manual pre-review Ponytail/directness: prior implementation sweep remains applicable to unchanged files; inspected current changed seams and new runner. Retained-required: canonical scope check, unknown-scope retention, independent pin checks, real host aliases, RPC fault injection and isolated per-test process/HOME. Skipped: bridge extension, mutable-worktree activation, new dependencies, config wizard, live scoring and benchmark reruns. Ignore only generated `.pi-subagents/` metadata; do not stage it. Post-sweep checks must pass again before final-candidate review. Effective default-disabled Jev permits preserving the existing DCP config byte-for-byte if it still has no Jev override.

### Consolidated repair after full review batch 1

Candidate `sha256:bad30d3f9e5884bfba760dd97030e602cafb1be9e734fc411568d2ef287a72b6` received Reviewer FINDINGS and Breaker FAIL, not approval. Both reproduced a durable compression pin stranded after missing/stale sidecar state. Reviewer also distinguished host-loaded unit tests from missing registered-event integration. Dave authorized up to 35 more minutes for these repairs and the one remaining focused batch, preserving this plan identity and the two-batch cap.

Repair: validated reason-level replay retains independent reasons; `/dcp recompress` discovers durable compression IDs and releases the selected reason with native confirmation independently of missing/already-active sidecar state. Missing summaries are not reconstructed. Legacy suspended records still require confirmation. Malformed/foreign metadata and navigation changes remain fail-closed. Confirmation identifies the reason and result entries.

Regression evidence: `recovery-red.log` reproduces the original stuck pin; the new host integration against a frozen batch-1 tree fails the lost-sidecar discovery assertion (`integration-regression-red.log`). Focused repair unit checks and actual-host integration pass. `test/host-integration.mjs` invokes the loaded production handlers with an actual host in-memory SessionManager, covering ordinary context pruning, registered compression/decompression, missing and stale-active sidecar reloads, discoverability, RPC refusal, recompression, compaction, exact recall, agent_end and shutdown. UI/action adapters are synthetic; no model session, credentials, real histories or inference. These tests close the earlier event-boundary coverage gap; they are not human TUI acceptance.

Ponytail repair sweep: shared replay owns validation rather than a second parser; release is independent of cache state, with explicit success/failure types and preserved owner reasons. No generic recovery framework, new command or dependency. Both JS fixtures join strict `tsconfig.tests.json` checks. Re-run complete isolated checks and both SDK type environments before the focused gate. Compiler for activation checks is 7.0.2; historical baseline compiler versions above are not current runtime claims.

Activation changes invalidate the old benchmark's code seal; previous synthetic reports remain historical evidence for their original candidate, not for this release. No measured savings or calibrated cutoff is claimed. Ponytail full and semantic-directness remain active; source sharing with TypeSafe is not permitted during setup.
