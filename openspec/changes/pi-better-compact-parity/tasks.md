# Tasks

## 1. Verify the host facts the design depends on (before any code)

- [ ] 1.1 Confirm `compact` is importable at runtime from
      `@earendil-works/pi-coding-agent` and that its parameter list matches
      `dist/core/compaction/compaction.d.ts` (write a throwaway script that
      imports and prints `compact.length`, run it with the installed host, then
      delete it); record the measured arity in design.md so a future host change
      is visible rather than silent
- [ ] 1.2 Confirm `ModelRegistry.getApiKeyAndHeaders(model)` resolves for the
      session model from inside an extension, with a real run of
      `pi -e extensions/keep-head-compaction.ts` and `/compact` on a scratch
      session; if it throws or returns empty credentials, stop here: the whole
      delegation is not viable and design D1 needs revisiting
- [ ] 1.3 Read how `settingsManager` is reachable from an extension context (or
      confirm it is not) and record the answer against D7 in design.md,
      including the fallback used
- [ ] 1.4 Verify the D4 model-view cap actually reaches the request: run a
      compaction with `maxTokens` configured low and assert the provider request
      carries that cap (host logging or a stubbed stream function), and confirm
      an unset value sends no cap

## 2. Failing tests for delegation (RED)

- [ ] 2.1 Add `test/summarizer-delegation.test.ts` with an injected fake for the
      delegated summarizer, and a RED test that `event.customInstructions`
      reaches the summarizer verbatim; verify `npm test` fails on it and passes
      the existing suites
- [ ] 2.2 RED: with no `maxTokens` configured, no output budget is sent; with
      `maxTokens: 4096` configured, the resolved model view carries 4096
- [ ] 2.3 RED: after a head-keeping compaction, the summarizer receives the
      stored **middle** summary as `previousSummary` and never the wrapped head
      text; and a session whose previous compaction was Pi's still receives
      `preparation.previousSummary`
- [ ] 2.4 RED: `isSplitTurn` preparations are handed to the delegated call
      unmodified, with `turnPrefixMessages` no longer folded into the middle
      span
- [ ] 2.5 RED: the emitted `<read-files>` / `<modified-files>` blocks union the
      prior marker's lists with the current span's, de-duplicated and sorted, and
      a v1 marker (no lists) still yields the carried head plus current-span
      lists

## 3. Green: delegate the middle summary

- [ ] 3.1 Replace the private prompt and the direct model request with one
      `compact()` call on the adjusted preparation (credentials from
      `getApiKeyAndHeaders`, `signal`, `ctx.thinkingLevel`, `process.env`),
      delete `buildSummaryPrompt`, and keep the head wrapper + marker write
      around its result; verify `npx tsc --noEmit` and `npm test` pass, and that
      2.1-2.3 now pass
- [ ] 3.2 Apply the D4 model view (`{ ...model, maxTokens: cap }`) only when the
      config sets a cap; verify 2.2 passes and that an unset cap sends no budget
- [ ] 3.3 Handle Pi's failed-summary sentinel text ("... failed: ..." from
      `stopReason` `error`/`length`) as a stand-down alongside the existing
      empty-summary rule, with no stand-down when the signal aborted; verify with
      a test that a sentinel result returns `undefined`
- [ ] 3.4 Pass the retry settings resolved in 1.3 to `compact()` and confirm a
      first-attempt transient failure does not stand down while an exhausted
      retry does; verify with a test using a failing-then-succeeding fake

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
