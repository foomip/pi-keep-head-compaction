# Compaction Specification

## Purpose

Defines how `pi-keep-head-compaction` intercepts Pi's `session_before_compact`
event and which guarantees a head-keeping compaction provides.

Rationale: the beginning of the conversation carries the durable instructions
(original task definition, early corrections and constraints, session-start
memory injections, the plan skeleton). Default compaction replaces that head
with a lossy summary optimized for what happened rather than which rules must
keep being obeyed, and long-running agents then drift from those instructions.
Preserving the head verbatim makes the start of the context a fixed point of
compaction.

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
when the context window is unknown or zero. Scaling SHALL apply to the budgets
the session's role resolved to, using the context window of the model that
session is running, so that head and tail are scaled against the window of the
session that is actually compacting.

#### Scenario: Child on a smaller-window model

- **WHEN** a `subagent` session resolves to head 20000 and tail 20000 and its
  model's context window is 32128 with a reserve of 8192
- **THEN** both budgets are scaled to fit 23936 tokens, preserving the 1:1
  head:tail ratio, and the parent's own budgets are unaffected

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

#### Scenario: Configured summarizer model

- **WHEN** config sets `model` to `provider/model-id` and compaction summarizes
  the middle span
- **THEN** the summary request uses that model with the configured `maxTokens`,
  and the returned usage is stored on the compaction entry

#### Scenario: Abort signal is honored

- **WHEN** the abort `signal` fires while the summary request is in flight
- **THEN** the extension does not emit a summary and falls back to default
  compaction

### Requirement: Graceful fallback

The extension SHALL return `undefined` (falling back to Pi's default
compaction) whenever it cannot produce a head-keeping compaction: no model,
configured model not found (with a warning), empty summary, aborted request,
or handler error — and MUST NOT cancel the compaction.

#### Scenario: No active model

- **WHEN** compaction fires and neither the session nor the config supplies a
  usable model
- **THEN** the extension warns and returns `undefined`, and Pi's default
  compaction runs

#### Scenario: Summarizer error

- **WHEN** the summary request throws
- **THEN** the extension reports the error and returns `undefined` instead of
  cancelling the compaction

### Requirement: Configuration

The extension SHALL read configuration from
`<project>/.pi/keep-head-compaction.json` (wins) and
`~/.pi/agent/keep-head-compaction.json`, with the `PI_KEEP_HEAD_TOKENS`
environment variable overriding `headTokens`. Supported keys: `headTokens`
(default 20000; legacy alias `keepHeadTokens`), `tailTokens` (default 20000),
`model`, `maxTokens` (default 8192), `minMiddleTokens` (default 500), and
`subagent` (default absent), an optional object carrying a subset of the same
keys as the base configuration, applied only to the `subagent` role.

`subagent` SHALL be shallow-merged over the base configuration: a key present
in `subagent` replaces the base value, and an omitted key keeps the base value.
Values inside `subagent` SHALL be validated exactly as the corresponding base
keys are, and an invalid value SHALL be treated as absent rather than as an
error. A `subagent` value that is not a JSON object SHALL be ignored.

Because role resolution merges before it applies environment overrides,
`PI_KEEP_HEAD_TOKENS` SHALL override the resolved `headTokens` of both roles.

#### Scenario: Child with an override block

- **WHEN** the merged config contains
  `"subagent": { "headTokens": 12000, "tailTokens": 6000 }` and compaction
  fires in a session whose role is `subagent`
- **THEN** that session's budgets are 12000 head and 6000 tail, while
  `model`, `maxTokens` and `minMiddleTokens` come from the base configuration

#### Scenario: The same block in a parent session

- **WHEN** the merged config contains the same `subagent` object and compaction
  fires in a session whose role is `parent`
- **THEN** the base `headTokens` and `tailTokens` apply unchanged

#### Scenario: Invalid override value

- **WHEN** `subagent.headTokens` is `"lots"` and the base `headTokens` is 20000
- **THEN** the `subagent` role resolves to 20000 head

### Requirement: Role-scoped budgets

The extension SHALL resolve its effective budgets per session from the
session's role. A session running in a process whose environment reports
`PI_SUBAGENT_CHILD=1` SHALL be treated as the `subagent` role; any other
session SHALL be treated as the `parent` role. The parent role SHALL NOT be
affected by the `subagent` configuration block.

Role detection SHALL depend only on the session's own process environment and
SHALL NOT be inferred from session lineage, so that a session created by
forking or cloning a parent session keeps the parent's budgets.

The extension SHALL report the resolved role and budgets in its compaction
notification, so a child's effective profile is observable in the session it
runs in.

#### Scenario: Child session uses the subagent role

- **WHEN** compaction fires in a session hosted by a process with
  `PI_SUBAGENT_CHILD=1` and the config supplies a `subagent` block
- **THEN** the `subagent` block is applied and the notification names the
  `subagent` role

#### Scenario: Parent session does not

- **WHEN** compaction fires in an interactive session with no
  `PI_SUBAGENT_CHILD` in its environment
- **THEN** the base configuration applies and the notification names the
  `parent` role

#### Scenario: Forked session keeps parent budgets

- **WHEN** a session with a parent-session pointer but no `PI_SUBAGENT_CHILD`
  in its environment compacts
- **THEN** the base configuration applies

#### Scenario: No subagent block configured

- **WHEN** a `subagent` session compacts and the config has no `subagent` block
- **THEN** it uses the base budgets, exactly as it would have before this
  capability existed

#### Scenario: Standing down for children

- **WHEN** the config sets `"subagent": { "headTokens": 0 }` and a `subagent`
  session compacts on a span larger than `minMiddleTokens`
- **THEN** the extension stands down and Pi's default compaction runs for that
  session, while parent sessions keep head retention
