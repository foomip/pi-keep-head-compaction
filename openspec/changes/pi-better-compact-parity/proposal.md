# Proposal

## Why

The extension owns two unrelated jobs. It decides **what survives** compaction
(head verbatim, tail verbatim, only the middle summarized) - which is the
product, and Pi has no equivalent. And it also re-implements **how the middle is
summarized**: its own prompt, its own request, its own merge of the previous
summary. The second job duplicates Pi and has silently drifted as the host
evolved past the 1.4.0 API the extension was written against. Measured against
Pi 1.5.2:

- `/compact <instructions>` is discarded. Pi puts `customInstructions` on the
  `session_before_compact` event and appends it as extra focus in its own
  summarizer; the handler destructures only `preparation`, `branchEntries` and
  `signal`, so whenever this extension returns a compaction the user's stated
  focus is thrown away. This is a user-visible bug, not a nicety.
- The summary request pins `maxTokens` (default 8192). Pi removed the fixed
  summary output cap in 1.4.0 (`#9512`): summaries use the model's output limit,
  reduced so input and output fit the window. A pinned cap reintroduces the
  failure Pi fixed, and reasoning-heavy sessions hit it first.
- Split turns lose fidelity. The handler folds `turnPrefixMessages` into the
  single middle summary, while Pi summarizes the turn prefix separately and
  merges it under `**Turn Context (split turn):**`. Our output is a different
  shape from stock Pi's for exactly the turns that are mid-flight.
- File lists stop accumulating. Pi carries `readFiles`/`modifiedFiles` forward
  in a compaction entry's `details`, but skips entries appended by a hook
  (`compaction.js` guards on `!fromHook`, and `agent-session.js` appends
  hook results with `fromHook: true`). After a second compaction, files from
  the first span are gone from the summary.
- The failure path is thinner than Pi's. Pi's summarization calls go through a
  retry policy and retry callbacks; ours is a single `modelRegistry.complete`
  request, so a transient provider error costs us the compaction (we stand down
  and Pi's default summarization wins, losing the head for that cycle).

Meanwhile Pi 1.5.2 exports the function that does all of this - `compact()` -
and it is reachable at runtime with `ctx.modelRegistry.getApiKeyAndHeaders()`
supplying the credentials it needs. Pi's own automatic and manual paths call
exactly that function.

## What Changes

- Delegate middle summarization to Pi's exported `compact()`, called on the
  preparation this extension has already re-cut. The verbatim head, the tail
  re-cut, window-aware scaling, role budgets, the `details` marker and the
  stand-down rules stay here unchanged; the private prompt builder and the
  direct model request are deleted.
- Honor `customInstructions` by passing it to Pi's summarizer (Pi appends the
  focus itself, in its own wording).
- Stop pinning the summary output budget by default, matching Pi's
  output-limit behavior; keep `maxTokens` as an **opt-in override** that, when
  configured, is still passed explicitly.
- Restore split-turn fidelity by handing Pi the untouched preparation instead
  of folding the turn prefix into the middle span.
- Carry cumulative `readFiles`/`modifiedFiles` in this extension's `details`
  marker (version 2), unioned per span, since Pi deliberately ignores
  hook-produced entries.
- Add bounded retry around the delegated call, mirroring the settings Pi itself
  uses, and record `usage` exactly as before.
- Add `/keep-head-status`: resolved role, scaled budgets, config source, whether
  a head is carried and its size, cumulative file counts, and the last
  stand-down reason.
- Read `reason` (`manual`/`threshold`/`overflow`) and `willRetry` for
  observability only (notice and status); no behavior change depends on them.
- Version `0.2.0`, released through the existing OIDC trusted-publishing
  workflow.

Not included (deliberate, see design.md): a DP/economic "when to compact" model
of the kind in `takltc/pi-better-compact`, which requires globally disabling
Pi's compaction; a forked cut-point implementation; env-var-only configuration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `compaction`: `Middle summary` is rewritten to describe delegation to Pi's
  summarizer (format, instructions, output limit, thinking level, retry, usage).
  `Head survives repeated compactions` gains the rule that the stored **middle**
  summary, never the wrapped head text, is what Pi's update path receives.
  `Configuration` lists `maxTokens` as default-unset and points at the new
  `Summary output budget` requirement. `Graceful fallback` names the retry
  attempts that must fail before standing down. `Tail retention` states the
  cut-point function the code actually uses. `Role-scoped budgets` is shortened
  and its rules split into `Subagent override merging` and `Role signal is the
  process environment`. Five new behavioral requirements are added: `Manual
  compaction instructions`, `Summary output budget`, `Split-turn fidelity`,
  `Cumulative file operations`, `Status command`.

## Impact

- `extensions/keep-head-compaction.ts` - the summarizing step of the pipeline
  becomes one delegated `compact()` call plus the existing head wrapper and
  marker write; `buildSummaryPrompt` is deleted; `MarkerDetails` gains two file
  lists and `DETAILS_VERSION` moves to 2 (v1 stays readable).
- `test/` - a summarizer-delegation test (instructions and previous-summary
  routing, no pinned cap unless configured, cumulative lists, split-turn
  hand-off) using an injected fake for the delegated call; the existing head
  split, role config and fallback suites stay.
- `README.md` - config table (`maxTokens` now opt-in), a "Relationship to Pi's
  summarizer" section, and `/keep-head-status`.
- `package.json` - `0.2.0`; dev dependencies move from `^1.4.0` to `^1.5.2` to
  match the host the delegation relies on.
- `.github/workflows/ci.yml` - add the Node 22.19 leg that matches `engines`.
- `openspec/specs/compaction/spec.md` - MODIFIED `Tail retention` (stale
  `prepareCompaction` wording corrected to `findCutPoint`), `Middle summary`,
  `Head survives repeated compactions`, `Configuration`, `Graceful fallback`,
  `Role-scoped budgets`; ADDED `Subagent override merging`, `Role signal is the
  process environment`, `Manual compaction instructions`, `Summary output budget`,
  `Split-turn fidelity`, `Cumulative file operations`, `Status command` (six of
  them; the requirement splits also clear the host's two >500-character lint
  infos).
- Prerequisite for release, outside the repo: the npm trusted-publishing config
  for `foomip` / `pi-keep-head-compaction` / workflow `release.yml` with "Allow
  npm publish" enabled (`0.1.0` was published manually and carries no provenance).
- Fold-in docs correction, already flagged and unrelated to this change's
  behaviour: requirement `Tail retention` still says the cut is recomputed with
  `prepareCompaction(...)`, while the code uses `findCutPoint`.
