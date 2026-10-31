# Project Context

## Purpose

`pi-keep-head-compaction` is an extension package for the [Pi coding agent](https://pi.dev)
that changes how context compaction treats the two ends of a conversation.

Pi's built-in compaction summarizes everything except a recent tail
(`keepRecentTokens`, default 20k tokens). The beginning of the session —
original instructions, the first plan, early decisions — is reduced to summary
prose. This package keeps the **first** N tokens of the session verbatim (in
addition to pi's kept tail) and summarizes only the middle span.

## Stack

- TypeScript (ES2023, NodeNext), loaded directly by Pi's extension runtime.
- Host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`)
  are peer dependencies — never bundled, never in `dependencies`.
- Node 26 LTS ('Lithium') is the reference runtime; CI pins Node 26.
- Typecheck: `npm run typecheck` (tsc --noEmit, strict).

## Conventions

- One extension entry point: `extensions/keep-head-compaction.ts`.
- Extension state that must survive across compactions lives in the
  `CompactionEntry.details` field, versioned via `DETAILS_KIND`/`DETAILS_VERSION`.
- Any failure to produce a head-keeping compaction (no model, empty summary,
  aborted, too-small middle) stands down and returns `undefined` so Pi's
  default compaction runs — the extension must never break compaction.
- Specs live in `openspec/specs/`; proposed changes go in `openspec/changes/<name>/`
  (proposal.md, design.md, tasks.md, specs/ deltas) and are merged into
  `openspec/specs/` when archived.
