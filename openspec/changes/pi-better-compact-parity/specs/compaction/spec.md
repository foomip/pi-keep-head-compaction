# Spec Delta

## MODIFIED Requirements

### Requirement: Tail retention

The extension SHALL keep a verbatim tail. When config `tailTokens` differs from
the session's effective `compaction.keepRecentTokens`, the extension SHALL
recompute the cut with the host's own `findCutPoint(branchEntries, 0, length, tailTokens)` and
use that cut's entry as the returned `firstKeptEntryId` (overriding pi's
setting), extending or trimming the summarized span to match. Under a split turn
the re-cut is skipped and the event's preparation is used unchanged.

#### Scenario: Tail override differs from the session setting

- **WHEN** `tailTokens` is 40000 while the session's `keepRecentTokens` is
  20000
- **THEN** the returned compaction keeps roughly 40000 recent tokens verbatim,
  cut at a valid cut point by pi's own cut-point logic

### Requirement: Middle summary

The extension SHALL generate the middle summary by delegating to Pi's exported
`compact()` function, called with the preparation this extension adjusted, the
resolved summarizer model, credentials from the host model registry, the abort
signal, and the session's thinking level. It SHALL NOT build its own summary
prompt or issue its own summary request. The returned usage SHALL be stored on
the compaction entry.

#### Scenario: Configured summarizer model

- **WHEN** config sets `model` to `provider/model-id` and compaction summarizes
  the middle span
- **THEN** the delegated call uses that model and the returned usage is stored
  on the compaction entry

#### Scenario: Abort signal is honored

- **WHEN** the abort `signal` fires while the summary request is in flight
- **THEN** the extension does not emit a summary and falls back to default
  compaction

### Requirement: Head survives repeated compactions

The extension SHALL re-emit the previously preserved head unchanged on every
subsequent compaction, reading it from the prior compaction entry's `details`
(the first marker found scanning `branchEntries` backwards). It SHALL pass the
stored prior **middle** summary, never the wrapped head text, to the delegated
summarizer as its previous-summary input, and SHALL exclude the head's own
messages from the span handed to the summarizer.

#### Scenario: Second compaction after a head-keeping compaction

- **WHEN** compaction fires again on a session already compacted by this
  extension
- **THEN** the new summary contains the same verbatim head plus a fresh middle
  summary merged over the stored prior middle summary

#### Scenario: The head is never handed over to be summarized

- **WHEN** the extension delegates summarization of a span it also preserved a head
  for
- **THEN** the span handed to the host summarizer excludes every message carried in
  the verbatim head

#### Scenario: The wrapped head is not the previous-summary input

- **WHEN** the delegated summarizer is invoked on a session with a carried head
- **THEN** its previous-summary input contains no `<verbatim-conversation-start>`
  block and none of the head's serialized messages

### Requirement: Configuration

The extension SHALL read configuration from
`<project>/.pi/keep-head-compaction.json` (wins) over
`~/.pi/agent/keep-head-compaction.json` over built-in defaults, accepting the
keys `headTokens` (20000; legacy alias `keepHeadTokens`), `tailTokens` (20000),
`model`, `maxTokens` (unset), `minMiddleTokens` (500) and `subagent` (absent).
`PI_KEEP_HEAD_TOKENS` overrides `headTokens` after role resolution, so it
applies to both roles.

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

### Requirement: Graceful fallback

The extension SHALL return `undefined` (falling back to Pi's default compaction)
whenever it cannot produce a head-keeping compaction: no model, configured model
not found (with a warning), empty summary, a summary the host reported as failed,
a summarizer call whose retries are exhausted, aborted request, or handler error
- and MUST NOT cancel the compaction.

#### Scenario: No active model

- **WHEN** compaction fires and neither the session nor the config supplies a
  usable model
- **THEN** the extension warns and returns `undefined`

#### Scenario: Transient failure is retried before standing down

- **WHEN** the first delegated summarizer attempt fails transiently and a retry
  succeeds
- **THEN** the extension emits a head-keeping compaction using the retried result

#### Scenario: Summarizer error

- **WHEN** every delegated summarizer attempt fails
- **THEN** the extension returns `undefined` so Pi's default compaction runs

### Requirement: Role-scoped budgets

The extension SHALL resolve its effective budgets per session from the session's
role, treated as `subagent` or `parent`. The parent role SHALL NOT be affected by
the `subagent` configuration block. The extension SHALL report the resolved role
and budgets in its compaction notification, so a child's effective profile is
observable in the session it runs in.

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

## ADDED Requirements

### Requirement: Subagent override merging

The `subagent` block SHALL be shallow-merged over the base configuration: a key
present in `subagent` replaces the base value, an omitted key keeps the base
value. Values inside `subagent` SHALL be validated exactly as the corresponding
base keys are, and an invalid value SHALL be treated as absent rather than as an
error. A `subagent` value that is not a JSON object SHALL be ignored.

#### Scenario: Partial block inherits the rest

- **WHEN** `subagent` sets only `headTokens`
- **THEN** that role's `tailTokens`, `model`, output budget and
  `minMiddleTokens` keep their base values

#### Scenario: A non-object block is ignored

- **WHEN** `subagent` is a string or an array
- **THEN** the base configuration applies to both roles

### Requirement: Role signal is the process environment

Role detection SHALL depend only on the session's own process environment
(`PI_SUBAGENT_CHILD=1` means `subagent`) and SHALL NOT be inferred from session
lineage or session identity, so that a session created by forking or cloning a
parent session keeps the parent's budgets.

#### Scenario: Lineage never selects the role

- **WHEN** a forked or cloned session with a parent-session pointer compacts in a
  process without `PI_SUBAGENT_CHILD`
- **THEN** it resolves to the `parent` role and the base budgets

### Requirement: Manual compaction instructions

The extension SHALL pass the `customInstructions` carried on the
`session_before_compact` event to the delegated summarizer unchanged, and SHALL
NOT add its own instruction wording.

#### Scenario: Focused manual compaction

- **WHEN** the user runs `/compact focus on the migration bugs` and the extension
  handles the compaction
- **THEN** the delegated summarizer receives `focus on the migration bugs` as its
  custom instructions

#### Scenario: Automatic compaction has none

- **WHEN** compaction fires from the context threshold with no instructions
- **THEN** the delegated call receives no custom instructions and the summary
  follows the host's standard format

### Requirement: Summary output budget

The extension SHALL treat `maxTokens` as an opt-in override: when unset it SHALL
apply no output cap and let the host's model output limit govern the summary
request; when set it SHALL cap that request at the configured value. The key
SHALL keep lenient validation, an invalid value treated as absent.

#### Scenario: No configured output cap

- **WHEN** `maxTokens` is absent from the resolved config and compaction
  summarizes the middle
- **THEN** the summary request carries no explicit output budget

#### Scenario: Configured output cap

- **WHEN** `maxTokens` is `4096` and compaction summarizes the middle
- **THEN** the summary request is limited to 4096 output tokens

#### Scenario: Invalid value degrades to absent

- **WHEN** config sets `maxTokens` to `"lots"`
- **THEN** the value is ignored and no output cap is applied

### Requirement: Split-turn fidelity

When the preparation is a split turn, the extension SHALL pass the preparation's
turn-prefix messages to the delegated summarizer unmodified and SHALL NOT fold
them into the middle span, and the emitted middle summary SHALL carry the host's
turn-context separator for that prefix.

#### Scenario: Compaction splits a turn

- **WHEN** compaction fires with `isSplitTurn` true and a non-empty turn prefix
- **THEN** the middle summary contains the host's `**Turn Context (split
  turn):**` section and the head is still emitted verbatim

### Requirement: Cumulative file operations

The extension SHALL store the read and modified file lists in its own compaction
marker (`details`, version 2), SHALL union them across compactions, and SHALL
present the union to the delegated summarizer so the emitted file blocks cover
every summarized span since session start. A version 1 marker or a marker-less
host compaction SHALL be read as having no stored lists.

#### Scenario: Files survive a second compaction

- **WHEN** a file was modified in a span summarized by an earlier compaction and
  is not touched by the current span
- **THEN** it still appears in the current summary's modified-files block

#### Scenario: Reading an older marker

- **WHEN** compaction fires after a compaction written by version 1 of the marker
- **THEN** the head is carried unchanged and the file blocks cover the current
  span only

### Requirement: Status command

The extension SHALL provide a `/keep-head-status` command reporting, without
mutating session state: the detected role and the signal that produced it, the
winning configuration source, the configured and the scaled head and tail
budgets, whether a verbatim head is carried and its size, the cumulative read and
modified file counts, the effective summary output budget, and the reason for the
most recent stand-down.

#### Scenario: Status after a stand-down

- **WHEN** the extension stood down because the middle span was below
  `minMiddleTokens` and the user runs `/keep-head-status`
- **THEN** the output names that stand-down reason and the budgets that were in
  effect

#### Scenario: Status in a child session

- **WHEN** `/keep-head-status` runs in a session hosted by a subagent runner
- **THEN** the output reports the `subagent` role and that role's resolved
  budgets
