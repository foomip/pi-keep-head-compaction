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

- [ ] 4.1 Drop the `turnPrefixMessages` fold and let the preparation reach
      `compact()` untouched under `isSplitTurn`, leaving the tail re-cut still
      skipped for split turns; verify 2.4 passes and the split-turn output
      contains Pi's `**Turn Context (split turn):**` separator verbatim
- [ ] 4.2 Extend `MarkerDetails` with `readFiles` / `modifiedFiles`, bump
      `DETAILS_VERSION` to 2, read v1 markers as empty lists, and pass the union
      into `compact()` as the preparation's `fileOps`; verify 2.5 passes and
      `npm test` reports the whole suite green
- [ ] 4.3 Add a test that a session compacted twice by this extension keeps the
      head byte-identical across both entries and grows the file lists
      monotonically

## 5. Status command

- [ ] 5.1 Register `/keep-head-status` (mode-guarded) printing role and its
      signal, winning config source, configured vs scaled budgets, whether a head
      is carried with its size, cumulative file counts, the effective output
      budget, and the last stand-down reason; verify by exercising it in a TUI
      run and recording the observed output in this file
- [ ] 5.2 Record the last stand-down reason (and its cause: `headTokens <= 0`,
      middle below `minMiddleTokens`, empty summary, sentinel failure, missing
      model) in a module-scope field set by the existing stand-down branches, and
      add a pure helper test for the formatting of each reason
- [ ] 5.3 Update `README.md`: add the command, a "Relationship to Pi's
      summarizer" section stating the delegation and its host coupling, the
      `maxTokens` override semantics, and the two owed live observations this
      change turns into checks (child compaction shows the pinned head, not a
      re-narration; parent in the same cwd reports the parent profile)

## 6. Packaging, CI, spec sync

- [ ] 6.1 Bump `package.json` to `0.2.0` and dev dependencies to
      `@earendil-works/pi-ai` / `pi-coding-agent` `^1.5.2`; verify
      `npm ci && npx tsc --noEmit && npm test` against the upgraded types
- [ ] 6.2 Add a Node `22.19` leg to `.github/workflows/ci.yml` beside Node 26,
      matching `engines.node`; verify the workflow YAML parses locally and both
      legs run the same two commands
- [ ] 6.3 Verify the docs corrections this change's delta already carries:
      `Tail retention` names `findCutPoint` (the drift flagged by the previous
      change) instead of `prepareCompaction(...)`, and `Role-scoped budgets` is
      split into `Subagent override merging` plus `Role signal is the process
      environment` with all five of its scenarios copied verbatim. Verify
      `openspec validate pi-better-compact-parity --strict` is clean, and after
      sync/archive that `openspec validate --specs` reports no >500-character
      requirement infos

## 7. Release (Nelson's action, recorded not executed by the agent)

- [ ] 7.1 Create the npm trusted-publishing config for package
      `pi-keep-head-compaction`: publisher type GitHub Actions, organization
      `foomip`, repository `pi-keep-head-compaction`, workflow `release.yml`,
      "Allow npm publish" enabled; complete the first trusted publish within 2
      days of creating it
- [ ] 7.2 Tag `v0.2.0` on the merged `main` commit and push the tag, then verify
      the run published with provenance: `npm view pi-keep-head-compaction@0.2.0`
      shows the version and `dist.attestations`, and the `badges` branch numbers
      refresh from the CI run
- [ ] 7.3 Reinstall on each box (`pi update` or `pi install
      npm:pi-keep-head-compaction`) and confirm the tuned global config on maui
      (`headTokens 28000, tailTokens 12000, maxTokens 16284`) still resolves and
      is now applied as an override rather than a fixed budget
