# Design

## Context

The `session_before_compact` handler is a pipeline: role config resolution,
window-aware budget scaling, head split, tail re-cut, middle summarization,
`details` marker, stand-downs. Everything except the third step is the product.
Step three duplicates Pi, and Pi has moved on: the extension was written against
the 1.4.0 host API and the deployed host is 1.5.2.

Facts this design rests on, all read from the installed host
(`@earendil-works/pi-coding-agent` 1.5.2), not inferred from a third-party
package:

- `compact()` is exported at runtime. Verified with
  `node -e "import('./dist/index.js').then(m => ...)"`; it appears alongside
  `findCutPoint` and `serializeConversation`, which the extension already uses.
  (`prepareCompaction` is *not* runtime-exported; that constraint still holds and
  is why the handler works from `event.preparation`.)
- Pi's own automatic and manual paths call the same function, with the same
  argument order we would use:
  `agent-session.js:2305` -
  `compact(preparation, model, apiKey, headers, customInstructions, signal,`
  `thinkingLevel, streamFn, env, retrySettings, retryCallbacks, sessionId)`.
- Inside it (`compaction/compaction.js:688-727`): one history summary, or - when
  `isSplitTurn` and a turn prefix exists - a second, separate turn-prefix
  summary merged as `historyText + "\n\n---\n\n**Turn Context (split turn):**"`
  `+ prefixText`; then `computeFileLists` + `formatFileOperations` appending
  `<read-files>` / `<modified-files>`; returns
  `{ summary, firstKeptEntryId, tokensBefore, usage, details: { readFiles,`
  `modifiedFiles } }`.
- No output cap exists any more: the `generateSummary*` parameter is named
  `_reserveTokens` and commented "Unused. Kept for existing callers; summaries
  use the model's output limit (#9512)".
- Credentials are reachable from an extension: `ModelRegistry` exposes
  `getApiKeyAndHeaders(model)` (`core/model-registry.d.ts:33`) and `compact()`
  accepts `streamFn` as optional (`completeSummarization` falls back to
  `completeSimple`), so the host's streaming function is not needed.
- `prepareCompaction` sets `previousSummary` to the newest projected compaction
  entry's **raw `summary`** (`compaction.js:619-622`). For an entry this
  extension wrote, that raw summary *includes the verbatim head block*.
- Hook compactions are appended with `fromHook: true` (`agent-session.js:649`)
  and Pi's file-list accumulation skips those (`compaction.js:21`), so Pi
  neither feeds us nor inherits our file history.
- The event carries `customInstructions`, `reason` and `willRetry`
  (`core/extensions/types.d.ts:622-631`).

## Goals / Non-Goals

**Goals:**

- One summarizer implementation: Pi's. This extension stops being a second
  copy of Pi's prompt and request semantics.
- `/compact <instructions>` changes what this extension's summary focuses on.
- Output budget handling identical to Pi's by default, overridable on request.
- Split-turn summaries shaped like Pi's.
- File lists that keep accumulating across our own compactions.
- A status surface that makes the resolved budgets and stand-downs visible.
- Nothing that can break compaction: every new path ends in
  `return undefined` (Pi's default compaction) rather than a thrown error.

**Non-Goals:**

- No change to *when* compaction happens, and no economic/auto-trigger model
  (the `pi-better-compact` DP thesis, `agent_end` trigger, `CHECK_THRESHOLD`,
  `FORCE_THRESHOLD`, `DP_*` env vars). That model requires
  `compaction.enabled: false` globally, which hands correctness of compaction
  timing to a third-party extension. If wanted at all, it is a sibling
  extension, not this one.
- No forked cut-point logic (`findTurnStartIndex`, candidate builders, validity
  checks). `findCutPoint` defines the semantics and we delegate to it.
- No config-surface change beyond `maxTokens` semantics: JSON files, role
  overrides and `PI_KEEP_HEAD_TOKENS` stay as specified.
- No change to head retention, tail re-cut, scaling, or role resolution.

## Decisions

### D1 - Delegate the middle summary to Pi's `compact()`

Call `compact()` with the preparation this extension already adjusted
(re-cut tail, same `firstKeptEntryId`), then wrap its `summary` in the existing
`<verbatim-conversation-start>` head block and write our own `details`.
`buildSummaryPrompt` and the direct `ctx.modelRegistry.complete` request are
deleted.

Why not the narrower option (`generateSummaryWithUsage` only): it fixes the
output cap and instructions but leaves us re-implementing the split-turn merge,
the file-list formatting and the retry shape by hand - the three things most
likely to drift again. `compact()` is the seam Pi keeps stable across its own
two entry points.

Rejected: calling `compact()` *before* re-cutting the tail and adjusting
afterwards - the summary content depends on the span, so the delegation must
come after our span decisions.

### D2 - The update path receives the stored middle summary, never the head

When our marker exists, pass `previousSummary: prior.priorMiddleSummary` and
not `preparation.previousSummary`, whose raw text contains the whole verbatim
head. Feeding the head back as "previous summary" would (a) put head tokens
into the summarization prompt that we exist to keep out of it, and (b) invite
the model to re-narrate the head, which is the failure mode the owed live
observation is specifically checking for.

When the previous compaction was Pi's (foreign marker absent), pass
`preparation.previousSummary` unchanged, as today.

### D3 - `customInstructions` is passed through, not re-implemented

Read `event.customInstructions` and hand it to `compact()` verbatim. Pi appends
its own "additional focus" instruction; we add no wording of our own, so the
manual path and the automatic path stay byte-identical to Pi's behaviour for a
given focus.

### D4 - `maxTokens` becomes an opt-in override (Nelson's call, option b)

Unset (the default, and what the README recommends): omit the budget and let Pi
use the model's output limit. Set: pass it explicitly as the summary request's
output cap.

The key stays in the config surface and keeps its lenient validation (an invalid
value is treated as absent), because a box already runs
`maxTokens: 16284` in its global config - silently dropping the key would change
that box's behavior without a signal, and warning on every compaction would be
noise. `README` states it is an override, that the default follows the model,
and that setting it too low for the model re-opens the truncated-summary
failure Pi removed in 1.4.0.

Since `compact()` exposes no cap parameter, the override is applied by passing
Pi a model view with its output limit set: `{ ...model, maxTokens: cap }`. That
works because the cap is derived from the model, not from an argument: Pi builds
summary options as `{ signal, apiKey, headers, env, sessionId }` plus
`reasoning` (`createSummarizationOptions`), and the request layer resolves
`options.maxTokens ?? model.maxTokens` (`pi-ai/api/simple-options.js:36`), which
`clampMaxTokensToContext` then clamps to the window. Nothing else in the call
career changes: retry, thinking level, split-turn merge and file lists all stay
delegated, and the `compact()` seam stays the single one.

Rejected: driving Pi's lower-level `generateSummaryWithUsage` by hand to inject
an option (forks the split-turn merge and the file-list append, i.e. re-creates
the drift this change removes), and silently ignoring the configured value.

### D5 - Cumulative file lists live in our marker (version 2)

`MarkerDetails` gains `readFiles: string[]` and `modifiedFiles: string[]`.
On each compaction the extension unions the prior marker's lists with
`preparation.fileOps`, and passes the union to `compact()` as a doctored
`{ ...prep, fileOps: unionAsFileOps }` so Pi's own `<read-files>` /
`<modified-files>` block carries the whole history, not just the span.
`DETAILS_KIND` is unchanged; `DETAILS_VERSION` becomes 2, and reading a v1
marker (no lists) must keep working - Pi's marker-less entries and v1 markers
are both treated as "no prior lists".

Sorting and de-duplication happen on emit, so the marker holds a set-shaped
array and the emitted block is stable across runs. This is the only item on the
list Pi cannot do for us: it skips `fromHook` entries by design, and its
`details` shape is `{ readFiles, modifiedFiles }` which we now mirror so the
stored shape is Pi-compatible if Pi ever stops skipping hook entries.

### D6 - Split turns go to Pi untouched

Delete the `middleAll = [...middle, ...prep.turnPrefixMessages]` fold. When
`isSplitTurn`, the head/middle split still runs against the head budget, and the
unmodified preparation reaches `compact()`, which does the two calls and the
`**Turn Context (split turn):**` merge. The tail re-cut stays skipped for split
turns (unchanged conservative choice: moving the boundary inside a split turn is
a different question from who summarizes the prefix).

Cost: one extra summarizer call, only on split turns - the same cost Pi already
pays there.

### D7 - Retry: reuse Pi's, don't build ours

`compact()` takes `retry` and `callbacks`. Pass Pi's shaped retry settings
(`{ enabled, maxRetries, baseDelayMs, maxAgentDelayMs }`, read from the host's
settings manager where reachable) and treat a `compact()` result whose summary
looks failed (Pi returns `"... failed: ..."` sentinel text on `stopReason`
`error`/`length`) as a stand-down, exactly like today's empty-summary rule.

If the host's settings manager is not reachable from the extension context, the
fallback is Pi's documented defaults rather than a new config key, and the
status command reports which was used. No new user-facing knob.

### D8 - `reason` and `willRetry` are observability, not policy

Both go into the compaction notice and the status line. Deliberately no policy
change: the extension already refuses to break compaction, and a stand-down
during overflow recovery is already Pi's default behavior. Wiring policy to
`willRetry` would be a separate, argued change.

### D9 - `/keep-head-status` (slash command, read-only)

Reports: detected role and why (`PI_SUBAGENT_CHILD`), config source that won
(project / global / defaults), configured and scaled head/tail budgets, whether
a head is carried and its size in tokens/chars, cumulative read/modified file
counts, the effective `maxTokens` (model limit or override), and the last
stand-down reason with its cause. No new state: everything is read from config,
the newest marker in `branchEntries`, and the last handler pass. Command
registration is guarded so non-TUI modes are unaffected.

### D10 - Release at `0.2.0` over OIDC trusted publishing

`package.json` to `0.2.0`, dev dependencies to `^1.5.2` (the delegation depends
on 1.5.x exports), CI gains a Node 22.19 leg to match `engines`. Tag `v0.2.0`
only after the npm trusted-publishing config exists (organization `foomip`,
repository `pi-keep-head-compaction`, workflow `release.yml`, "Allow npm
publish" ticked, and the first trusted publish completed within 2 days of
creating the config). `0.1.0` was published manually with no provenance; that is
the reason to move now rather than at some later release.

## Risks / Trade-offs

- **Host coupling.** The extension now depends on `compact()` staying exported
  with this signature. Accepted: Pi calls it from both of its own entry points,
  and it is already in the public type surface. Mitigation: the call is wrapped,
  so a missing export or a signature change is a stand-down, not a broken
  session; the notice names the failure.
- **Pi's prompt is not ours.** Section headings change from the paraphrase to
  Pi's "EXACT format" template. That is the point of the change, but it does
  mean a session's summary shape shifts once at upgrade.
- **The model-view cap trick (D4)** relies on the request layer resolving
  `model.maxTokens`. Documented and pinned by a test that asserts the cap
  reaches the request; if a future host stops deriving it, the override becomes
  a no-op rather than a break.
- **Marker v2 migration.** A v1 marker plus a v2 write must not lose the carried
  head. Pinned by a test that reads a v1 marker and emits a v2 entry.
- **Delegation cost.** We inherit Pi's summarizer choice semantics; a future Pi
  change to summary formatting shows up in our output without a code change. That
  is the intended trade: drift in shape, not drift in bugs.

## Migration

- No config migration required. A `maxTokens` value already on disk (maui runs
  `16284`) keeps working as an override.
- No session migration: existing sessions keep their v1 markers and read them
  fine.
- `pi update` (or reinstall from npm after `v0.2.0`) is the whole upgrade. The
  tuned global config file is untouched by this change.

## Open Questions

1. Does the host expose `settingsManager.getRetrySettings()` to an extension
   context (D7)? Determined by reading the host in task 1.3, not assumed.
2. Should `/keep-head-status` also print the *next* compaction's projected
   budgets, or only the last applied ones? Default: last applied only.
