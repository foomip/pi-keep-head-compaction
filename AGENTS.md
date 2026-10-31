# AGENTS.md — pi-keep-head-compaction

Guidance for agents working in this repository.

## Branch policy

- **Work in a branch.** Never commit feature work directly to `main`. Create a
  descriptive branch first (for example `feat/subagent-role-budgets`,
  `fix/tail-cut-point`, `docs/config-table`), do the work there, and propose a
  pull request.
- Keep one logical change per branch. Rebase or merge `main` rather than
  stacking unrelated fixes on the same branch.
- Do not force-push a branch someone else may have based work on.

## Before committing

Run the same gates as CI:

```bash
npx tsc --noEmit
npm test
```

Both must pass on the tree being committed. If the change touches OpenSpec
artifacts, also run:

```bash
openspec validate <change-name> --strict
```

## Tests

- Unit tests live in `test/` and run with Node's built-in test runner:
  `npm test` (`node --test test/*.test.ts`).
- Prefer testing exported pure helpers directly instead of driving the Pi
  extension host. `extensions/keep-head-compaction.ts` exports its config and
  role-resolution helpers for this reason.
- Every behavior a spec scenario names should have a test or an explicitly
  recorded manual observation.

## Code conventions

- TypeScript, strict mode, ESM, tabs for indentation (matches the existing
  extension source).
- Keep the compaction pipeline (head split, tail re-cut, summarizer, `details`
  marker, fallbacks) isolated from config plumbing. New config keys should be
  parsed and resolved before the pipeline starts.
- Config validation is lenient by contract: an invalid value is treated as
  absent so a typo degrades to the base value instead of throwing inside a
  compaction hook.
- Role detection uses the process environment (`PI_SUBAGENT_CHILD=1`), never
  session lineage.

## OpenSpec

- Planning artifacts for a change live in
  `openspec/changes/<change-name>/` (`proposal.md`, `design.md`, `tasks.md`,
  `specs/**/spec.md`).
- Mark a task `- [x]` only when its specified behavior is fully implemented and
  verified; record any owed manual observation in the task itself.
- Do not silently narrow or defer specified behavior. Pause and surface scope
  changes instead.

## Commits

Use lowercase semantic prefixes: `feat:`, `fix:`, `docs:`, `chore:`,
`refactor:`, `perf:`, `test:`.
