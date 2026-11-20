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

## Measured Host Facts (task group 1, 2026-11-20, pi 1.5.2 host + pinned 1.4.0 dev deps)

Probes were run in `/tmp/khp-probe` with a throwaway extension driven over RPC
(4 turns, then a manual `compact` carrying `customInstructions`), against the local
`wolverine/qwen3.8-flash-next` model. The probe is deleted; these are the results.

- **1.1 exports and arity.** `compact` is exported at runtime from the package root in
  both installed copies, with **`compact.length === 12`** matching the `.d.ts`
  parameter list, and the identical function source in 1.4.0 and 1.5.2 (same
  split-turn merge, same `_reserveTokens` "unused" comment). Also exported and
  usable: `generateSummary`, `generateSummaryWithUsage`, `convertToLlm`,
  `findCutPoint`, `estimateTokens`, `serializeConversation`, `SettingsManager`,
  `DEFAULT_COMPACTION_SETTINGS`. **Not** exported at the root: `prepareCompaction`,
  `completeSummarization`, `computeFileLists`, `formatFileOperations`,
  `getSummarizationFailure`. So the single-seam choice in D1 is not a preference,
  it is the only reachable surface plus `generateSummary*`.
- **1.2 credentials from inside an extension (the D1 kill switch).** Passed.
  `ctx.modelRegistry.getApiKeyAndHeaders(model)` resolved for the session model and
  returned `{ ok, apiKey, headers, env }` with a 58-character apiKey and empty
  header/env maps (the local provider uses a plain key). Handing those straight to
  `compact()` produced a normal summarization call.
- **1.3 retry settings reachability.** `ctx` has no settings accessor, but
  **`pi.getSettings()` exists on the ExtensionAPI** and returns merged settings
  (the probe read back its project `.pi/settings.json` compaction block). It returns
  the raw document, so `retry` was `null` when unset rather than defaults; host
  defaults live in `settings-defaults.js` (`retry: { enabled: true, maxRetries: 3,
  baseDelayMs: 2000, maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS, provider: {
  maxRetryDelayMs: 60000 } }`) and are **not** re-exported at the package root.
  D7 therefore reads `pi.getSettings()?.retry` and supplies those literal defaults
  itself when absent.
- **1.4 the cap reaches the wire.** Confirmed, and the model view is the mechanism.
  Ordinary agent requests for this model carried `max_completion_tokens=68601`
  (= `model.maxTokens`, no explicit cap). Passing a summarization model view with
  `maxTokens: 777` bounded the summary to 452 output tokens; a view with
  `maxTokens: 48` produced the host's length failure. Options objects handed to the
  request layer contain `signal, apiKey, headers, env, sessionId, reasoning,
  cacheRetention` and never `maxTokens`, which is exactly why the view works.
- **Correction to D7's failure handling (measured).** A failed or length-capped
  summarization does **not** return sentinel text from `compact()`: it
  **throws** `Summarization failed: ...` (`compaction.js:533-536`, via
  `getSummarizationFailure`, which is not exported). So the stand-down rule is a
  plain try/catch, not string sniffing.
- **Bonus facts worth keeping.** The event carried `customInstructions`
  ("PROBE-FOCUS"), `reason: "manual"`, `willRetry: false`, `isSplitTurn: true` with
  `turnPrefixMessages: 1`, and `previousSummary: null` on the first compaction.
  `before_provider_request` does **not** fire for summarization calls, so any usage
  reporting must come from the `usage` that `compact()` returns (D9). A hook-returned
  compaction reaches the RPC `compact` response without `usage`/`details`, which
  matches the host docs ("may be omitted by custom compaction handlers").

### Live host observation (task 7.1, 2026-11-20, pi 1.5.2 host)

Driven over RPC with an isolated `HOME` (so an installed 0.1.0 copy could not also
hook) and a project config of tiny budgets. Two facts only a live run gives:

- pi 1.5.2 writes its own compaction entries with
  `details: { readFiles, modifiedFiles }` and **no** `kind`. Our marker is keyed on
  `kind`, so `findPriorMarker` ignores pi's entries and a session holding both kinds
  keeps exactly one head.
- With a tiny `keepRecentTokens` and short turns the preparation arrives as
  `messagesToSummarize: 0`, `turnPrefixMessages: 10`, `isSplitTurn: true`,
  `tokensBefore: 3514`: pi put the whole conversation in the current turn span, so no
  middle is left for us, and standing down is the specified outcome. The delegated
  summarization still owes a live observation on a session whose spans are larger
  than the budgets; the unit suite is what pins that path today.

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
(`{ enabled, maxRetries, baseDelayMs, maxAgentDelayMs }`) read from
`pi.getSettings().retry`, falling back to Pi's own literal defaults
(`enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs:` the host
constant, `provider.maxRetryDelayMs: 60000`) because `getSettings()` returns the raw
document and reports `retry: null` when unset. Those defaults are not re-exported at
the package root, so they are restated here as literals and pinned by a test.

A failed summarization is then handled as a stand-down by **catching the throw**:
on `stopReason` `error` or `length`, `compact()` throws
`Summarization failed: ...` rather than returning placeholder text, so there is no
sentinel string to match. No new user-facing knob.

### D11 - The seam the tests pin: an exported `summarizeMiddleSpan`

The delegation lives behind one exported function so the unit tests can inject a
fake for it without driving the extension host (AGENTS.md requires testing
exported pure helpers directly):

```ts
summarizeMiddleSpan({
  preparation,      // already re-cut by the tail logic
  model,            // session model; the cap is applied via a view, never mutated
  customInstructions, signal, thinkingLevel, env,
  prior?,           // { priorMiddleSummary } when our marker exists
  priorFileLists?,  // { readFiles, modifiedFiles } from a v2 marker
  maxTokensCap?,    // configured override; undefined = no cap
  deps,             // { compact, resolveAuth, getRetrySettings }
}): Promise<{ summary, usage, readFiles, modifiedFiles } | undefined>
```

- `deps.compact` is the host function; `resolveAuth` wraps
  `ctx.modelRegistry.getApiKeyAndHeaders`; `getRetrySettings` wraps
  `pi.getSettings().retry` with the D7 literals as fallback. Injecting them keeps
  the function pure enough to test and keeps the host bindings in one place.
- It returns `undefined` for every stand-down (thrown summarization, empty
  summary), and the handler then falls back exactly as it does today.
- **No extension-level retry.** The delegate is called once and the retry policy is
  handed to it, because the host retries inside `compact()` already; a second
  retry loop on top would multiply provider calls for no benefit. Pinned by test.

### D12 - The verbatim head is excluded from the span handed to the summarizer

Discovered while wiring the delegation, and the most important correctness detail
in the change: `compact()` summarizes whatever `messagesToSummarize` contains.
Handing it the untouched preparation therefore summarizes the head too, so the
head would be carried verbatim **and** re-narrated in the middle summary - the
exact "pinned head, not a re-narration" failure this package exists to prevent.

So the handler hands the delegate
`{ ...prep, messagesToSummarize: middleSpan }`, where `middleSpan` is what
`splitHead` left after the head, and `turnPrefixMessages` stays untouched for the
host's own split-turn path. Pinned by a test asserting the delegated span excludes
the head and keeps the prefix.

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

### D9 addendum (implementation, 2026-11-20)

The status command reuses the hook's layering: `readConfigLayers` and
`mergedLayers` were extracted from `loadConfig` so the report can name the files
that actually contributed values instead of re-deriving them, and
`buildStatusReport` is a pure helper over an `ExtensionStatus` snapshot so it is
unit-testable without the extension host. The role line names the signal
(`PI_SUBAGENT_CHILD=1` or unset) because that is the only role input that exists.
Session entries are read through `ctx.sessionManager.getBranch()/getEntries()`:
the 1.4.x `ExtensionCommandContext` exposes neither `getBranchEntries` nor
`getAgentMessages`, and `pi.getSettings()` is an `ExtensionAPI` method, not a
context method.

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
