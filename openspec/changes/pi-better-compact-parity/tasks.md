# Tasks

## 1. Verify the host facts the design depends on (before any code)

- [x] 1.1 Measured: `compact.length === 12` from the package root in BOTH the
      pinned 1.4.0 dev dependency and the installed 1.5.2 host, with identical
      function source (same split-turn merge, same unused `_reserveTokens`). Also
      recorded which neighbours are not root-exported (`prepareCompaction`,
      `completeSummarization`, `computeFileLists`, `formatFileOperations`,
      `getSummarizationFailure`), which is what makes D1's single seam the only
      reachable surface besides `generateSummary*`. Recorded in design.md
- [x] 1.2 Measured with a real compaction inside an extension:
      `ctx.modelRegistry.getApiKeyAndHeaders(model)` returned
      `{ ok, apiKey, headers, env }` (58-character key, empty header/env maps) and
      `compact()` summarized normally with them. Delegation is viable; D1 stands
- [x] 1.3 Measured: `ctx` exposes no settings accessor, but `pi.getSettings()` exists
      on the ExtensionAPI and returns the merged document (project settings were
      read back), with `retry: null` when unset. D7 amended to use
      `pi.getSettings()?.retry` plus Pi's literal defaults, restated in design.md
      because they are not root-exported
- [x] 1.4 Measured live: ordinary agent requests carried
      `max_completion_tokens=68601` (= `model.maxTokens`, no cap sent), a model view
      with `maxTokens: 777` bounded the summary to 452 output tokens, and a view with
      48 produced the host's length failure. Confirms the D4 model view reaches the
      wire. Also corrected: a capped/failed summarization THROWS
      `Summarization failed: ...` (`compaction.js:533-536`), so task 3.3 is a
      try/catch, not sentinel-string matching

## 2. Failing tests for delegation (RED)

- [x] 2.1 Added `test/summarizer-delegation.test.ts` with an injected fake for
      the delegated call (no extension host driven, per AGENTS.md) and RED tests
      that `event.customInstructions` reaches the summarizer verbatim, plus one
      asserting nothing is invented when the event carried none. Measured RED:
      `npm test` = 32 tests, **31 pass, 1 fail**; the new file fails at import
      with `does not provide an export named 'summarizeMiddleSpan'` - the seam in
      D11 does not exist yet, which is the intended failure
- [x] 2.2 RED: no output budget when `maxTokens` is unset (the model is handed
      through with its own limit, unmutated) and the configured cap reaches the
      delegated call via a model view without touching the session model object
- [x] 2.3 RED: after a head-keeping compaction the summarizer receives the stored
      **middle** summary as `previousSummary`, with the
      `<verbatim-conversation-start>` block explicitly excluded, and a session
      whose previous compaction was Pi's keeps `preparation.previousSummary`
- [x] 2.4 RED: an `isSplitTurn` preparation is handed over untouched - the turn
      prefix stays in `turnPrefixMessages` and never joins `messagesToSummarize`
- [x] 2.5 RED: the file blocks union the prior marker's lists with the current
      span's, de-duplicated and sorted, and a v1 marker (no lists) leaves the span
      standing alone. Also pinned: the host retry settings are handed to the
      delegate, the delegate is called **once** (retry belongs to the host policy,
      measured in 1.3/1.4), and a thrown `Summarization failed: ...` stands down

## 3. Green: delegate the middle summary

- [x] 3.1 Replaced the private prompt and the direct model request with the
      exported `summarizeMiddleSpan` helper (D11), which calls the host
      `compact()` on the already-adjusted preparation; deleted
      `buildSummaryPrompt` and the hand-built request, and kept the head wrapper,
      the marker write and the notification around its result. The RED suite
      (2.1-2.5) went green with it; `npx tsc --noEmit` clean
- [x] 3.2 `maxTokens` no longer has a default in `parseConfigObject`: unset
      means no output budget at all, and a configured value is applied as the D4
      model view without mutating the session model. Pinned by a new
      `role-config` test for the unset default and for parent/subagent
      resolution; README config table and example updated
- [x] 3.3 Stand-down on the host's thrown `Summarization failed: ...` plus the
      empty-summary rule, silent when the signal aborted (measured in 1.4: the
      host throws, it does not return sentinel text)
- [x] 3.4 Retry settings are handed to the delegate from
      `pi.getSettings().retry` with the D7 literals as fallback, and the delegate
      is invoked **once** - no extension-level retry loop, because the host
      retries inside `compact()` (pinned by test)

## 4. Green: split turns and cumulative file lists

- [x] 4.1 The turn-prefix fold is gone: the handler hands the delegate
      `{ ...prep, messagesToSummarize: middleSpan }` with `turnPrefixMessages`
      intact, so the host does its own two-call merge (D12 records why the head is
      also excluded - otherwise the head is summarized and re-narrated). Tests
      assert the delegated span excludes the head, keeps the prefix, and that the
      host's `**Turn Context (split turn):**` separator survives into the emitted
      summary
- [x] 4.2 `MarkerDetails` carries `readFiles`/`modifiedFiles`,
      `DETAILS_VERSION` is 2, a v1 marker reads as "head only, no lists", and the
      union is passed into the delegate as `priorFileLists` so the host's file
      blocks carry the whole history
- [x] 4.3 Two-compaction coverage at the handler level: the head is re-emitted
      byte-identically, the marker is rewritten at version 2, and the file lists
      grow monotonically (`earlier.ts` + `later.ts`, `old-change.ts` +
      `new-change.ts`); the v1-marker case is covered too. `npm test` 49/0,
      `npx tsc --noEmit` clean

## 5. Status command

- [x] 5.1 `pi.registerCommand("keep-head-status", ...)` is registered
- [x] 5.2 The report prints the role plus the signal that produced it, the config
      files that contributed values (or `defaults only`), the configured and the
      window-scaled head/tail budgets next to pi's `keepRecentTokens`, the head
      state (carried with its character count, active with its message count, or
      not active), the session entry count, the cumulative read/modified file
      counts, the effective output budget (`model default (no cap)` or the cap)
      and the last outcome including the stand-down reason. Achieved by exporting
      `readConfigLayers`/`mergedLayers` so the command reports the same layering
      the hook uses, and `buildStatusReport` as a pure helper
- [x] 5.3 README gains a `## Commands` section documenting `/keep-head-status`
      and what each line means. `npm test` 52/0 including three status tests
      (budgets and carried head, uncapped budget, stand-down reason); tests isolate
      `HOME` so the operator's own global config cannot leak into them

## 6. Packaging, CI, spec sync

- [x] 6.1 `package.json` is `0.2.0` and the dev dependencies are
      `@earendil-works/pi-ai` / `pi-coding-agent` `^1.5.2`; `npm install` then
      `npx tsc --noEmit` (clean) and `npm test` (52/0) ran against the 1.5.2 types,
      with the installed tree reporting `1.5.2`
- [x] 6.2 `.github/workflows/ci.yml` runs a matrix of Node `22.19` (the
      `engines.node` floor, which is also what pi declares) and `26` (the publish
      job's version); the coverage step is pinned to the 26 leg so the artifact is
      written once. Both legs run `npm ci`, `npx tsc --noEmit` and `npm test`
- [x] 6.3 The docs corrections this change's delta carries are verified:
      `Tail retention` names `findCutPoint` (the drift the previous change flagged),
      and `Role-scoped budgets` is split into `Subagent override merging` plus
      `Role signal is the process environment` with its scenarios copied verbatim.
      `openspec validate pi-better-compact-parity --strict` is clean

## 7. Live observation and release (release is Nelson's action)

- [x] 7.1 Live host observation of the delegation on pi 1.5.2 - **reached and
      passed**. Driver `/tmp/khc-inproc/inproc-run.mjs` (in-process
      `createAgentSession` + `DefaultResourceLoader.additionalExtensionPaths` + an
      observer extension; model `anthropic/claude-haiku-5-5`; project config
      `headTokens 150, tailTokens 250, minMiddleTokens 30`; settings
      `keepRecentTokens 250, reserveTokens 1000`; read tool enabled):
      `session.compact("PROBE-FOCUS-STRING")` produced a compaction entry with
      `details.kind = pi-keep-head-compaction`, `details.version = 2`,
      `headText` 1316 chars, `readFiles ["alpha.txt","beta.txt"]`, and a summary
      carrying the `<verbatim-conversation-start>` wrapper, the
      `## Compacted middle history` section, **pi's own summary format** (its
      `## Goal` / numbered-progress shape, which the extension no longer writes),
      the `**Turn Context (split turn):**` merge, and `usage` from the host. A
      second compaction after four more turns re-emitted the **byte-identical**
      head (`HEAD IDENTICAL ACROSS COMPACTIONS: true`), grew the marker lists to
      `["alpha.txt","beta.txt","gamma.txt"]`, and reported host usage. The
      observer confirmed the hook received `customInstructions`
      ("PROBE-FOCUS-STRING") and `span=18 prefix=1 isSplitTurn=true
      tokensBefore=4242`.
- [x] 7.2 Live role-scoped observation: the same driver with
      `PI_SUBAGENT_CHILD=1` and config `headTokens 0` plus
      `subagent { headTokens: 150 }` - a profile where a parent session stands
      down - produced two compactions both bearing `kind =
      pi-keep-head-compaction` `version 2` with a byte-identical carried head
      (1422 chars) and the verbatim wrapper: the subagent budget was applied and
      the head was pinned rather than re-narrated. (This used the documented
      process-env signal in an in-process host, not a pi-subagents runner; a
      runner-hosted child observation is still available as a cheap follow-up.)

- [x] 7.0 PR opened: https://github.com/foomip/pi-keep-head-compaction/pull/1
      (`main` <- `feat/pi-better-compact-parity`). CI on the PR: `test (22.19)` pass
      20 s, `test (26)` pass 22 s, `publish-badges` skipping (it only runs on `main`)
- [ ] 7.3 Create the npm trusted-publishing config for package
      `pi-keep-head-compaction`: publisher type GitHub Actions, organization
      `foomip`, repository `pi-keep-head-compaction`, workflow `release.yml`,
      "Allow npm publish" enabled; complete the first trusted publish within 2
      days of creating it
- [ ] 7.4 Tag `v0.2.0` on the merged `main` commit and push the tag, then verify
      the run published with provenance: `npm view pi-keep-head-compaction@0.2.0`
      shows the version and `dist.attestations`, and the `badges` branch numbers
      refresh from the CI run
- [ ] 7.5 Reinstall on each box (`pi update` or `pi install
      npm:pi-keep-head-compaction`) and confirm the tuned global config on maui
      (`headTokens 28000, tailTokens 12000, maxTokens 16284`) still resolves and
      is now applied as an override rather than a fixed budget
- [ ] 7.6 After the merge, archive this change (`openspec archive
      pi-better-compact-parity --strict`) so the six MODIFIED and seven ADDED
      requirements land in `openspec/specs/compaction/spec.md`, then re-run
      `openspec validate --specs` and confirm no requirement trips the 500-character
      info threshold

