# Compaction Specification

## Purpose

Defines how `pi-keep-head-compaction` intercepts Pi's `session_before_compact`
event and which guarantees a head-keeping compaction provides.

## Requirements

### Requirement: Head retention

The extension SHALL preserve the first `keepHeadTokens` tokens of the
summarized span verbatim by embedding their serialized transcript at the start
of the compaction summary, wrapped in a `<verbatim-conversation-start>` block.

#### Scenario: First compaction with a large span

- **WHEN** compaction fires and `messagesToSummarize` spans more than
  `keepHeadTokens` tokens
- **THEN** the leading messages up to `keepHeadTokens` tokens are serialized
  verbatim into the summary, and only the remaining middle span is summarized
  by the LLM

#### Scenario: Span smaller than the head budget

- **WHEN** the span to summarize is smaller than `keepHeadTokens` plus
  `minMiddleTokens`
- **THEN** the extension stands down and Pi's default compaction runs

### Requirement: Tail retention

The extension SHALL keep a verbatim tail. When config `tailTokens` differs
from the session's effective `compaction.keepRecentTokens`, the extension
SHALL recompute the cut with `prepareCompaction(branchEntries, { enabled:
true, reserveTokens, keepRecentTokens: tailTokens })` and return that
preparation's `firstKeptEntryId` (overriding pi's setting); if that
recomputation yields no preparation, it SHALL fall back to the event's
preparation.

#### Scenario: Tail override differs from the session setting

- **WHEN** `tailTokens` is 40000 while the session's `keepRecentTokens` is
  20000
- **THEN** the returned compaction keeps roughly 40000 recent tokens verbatim,
  cut at a valid cut point by pi's own cut-point logic

### Requirement: Window-aware budget scaling

The extension SHALL scale head and tail budgets down proportionally (same
head:tail ratio) when `headTokens + tailTokens + reserveTokens` exceeds the
active model's context window, and SHALL use the configured values unchanged
when the context window is unknown or zero.

### Requirement: Head survives repeated compactions

The extension SHALL re-emit the previously preserved head unchanged on every
subsequent compaction, reading it from the prior compaction entry's `details`
(the first marker found scanning `branchEntries` backwards), and SHALL NOT
pass the previous summary's head text back through the summarizer.

#### Scenario: Second compaction after a head-keeping compaction

- **WHEN** compaction fires again on a session already compacted by this
  extension
- **THEN** the new summary contains the same verbatim head plus a fresh middle
  summary merged over the stored prior middle summary

### Requirement: Middle summary

The extension SHALL generate the middle summary with the configured model
(config `model` override as `provider/model-id`, else the session's current
model), honoring the abort `signal` and the `maxTokens` output budget, and
storing the returned usage on the compaction entry.

### Requirement: Graceful fallback

The extension SHALL return `undefined` (falling back to Pi's default
compaction) whenever it cannot produce a head-keeping compaction: no model,
configured model not found (with a warning), empty summary, aborted request,
or handler error — and MUST NOT cancel the compaction.

### Requirement: Configuration

The extension SHALL read configuration from
`<project>/.pi/keep-head-compaction.json` (wins) and
`~/.pi/agent/keep-head-compaction.json`, with the `PI_KEEP_HEAD_TOKENS`
environment variable overriding `headTokens`. Supported keys: `headTokens`
(default 20000; legacy alias `keepHeadTokens`), `tailTokens` (default 20000),
`model`, `maxTokens` (default 8192), `minMiddleTokens` (default 500).
