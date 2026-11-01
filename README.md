# pi-keep-head-compaction

[![CI](https://github.com/foomip/pi-keep-head-compaction/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/foomip/pi-keep-head-compaction/actions/workflows/ci.yml?branch=main)
[![Branch coverage](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Ffoomip%2Fpi-keep-head-compaction%2Fbadges%2Fbranch-badge.json&query=%24.message&label=branch%20coverage)](https://github.com/foomip/pi-keep-head-compaction/tree/badges)
[![Line coverage](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Ffoomip%2Fpi-keep-head-compaction%2Fbadges%2Flines-badge.json&query=%24.message&label=line%20coverage)](https://github.com/foomip/pi-keep-head-compaction/tree/badges)

A [Pi coding agent](https://pi.dev) extension that changes how context
compaction treats the two ends of your conversation.

Pi's built-in compaction summarizes everything except a recent tail
(`keepRecentTokens`, default 20k tokens) — so the start of a long session
(original instructions, the first plan, early decisions) survives only as
summary prose. This package keeps the **first** N tokens of the session
verbatim **and** the recent tail verbatim (both configurable), summarizing
only the middle:

```
pi default:   [ summary of everything old ] [ last 20k verbatim ]
this package: [ first 20k verbatim ] [ summary of the middle ] [ last 20k verbatim ]
```

Both ends scale to the model: if head + tail + response reserve exceed the
context window, both budgets shrink proportionally (same head:tail ratio)
instead of overflowing.

## Install

```bash
pi install npm:pi-keep-head-compaction
```

Or try it for one session without installing:

```bash
pi -e npm:pi-keep-head-compaction
```

## How it works

Pi's compaction model has a single retention boundary (`firstKeptEntryId`):
everything before it is summarized. There is no built-in way to keep two
windows. This extension hooks `session_before_compact` and:

1. Splits the span-to-summarize into a **head** (first `keepHeadTokens`
   tokens, serialized verbatim) and a **middle**.
2. Summarizes only the middle with the configured model, using the same
   structured format as Pi's default summary (Goal, Progress, Key Decisions,
   Next Steps, Critical Context) plus read/modified file lists.
3. Returns a compaction whose summary is:

   ```
   <verbatim-conversation-start>
   ... serialized head messages, byte-for-byte ...
   </verbatim-conversation-start>

   ## Compacted middle history
   ... LLM summary of the middle ...
   ```

   with `firstKeptEntryId` left unchanged, so the tail is kept exactly as
   Pi would.

**Repeats safely.** The verbatim head is stored in the compaction entry's
`details` and re-emitted unchanged on every later compaction — it is never
re-summarized, never duplicated, and never lost to the
[re-compaction quirk](https://github.com/earendil-works/pi/issues/2608) where
previously kept messages get silently re-summarized.

**Never breaks compaction.** If anything goes wrong (no model, empty summary,
aborted, middle too small to be worth it), the extension stands down and Pi's
default compaction runs instead.

## Why: instruction drift on long-running tasks

The beginning of a conversation is where the durable instructions live:

- the **original task definition** — what was actually asked, in full, before
  any summarization existed;
- **early corrections and constraints** — "not X, do Y", "never touch this
  file", "always run the tests first", stated once in the first exchanges and
  never repeated;
- **memory and injected context** — session-start memory injections,
  AGENTS.md-derived guidance and prior-session handoffs that ride in the first
  messages rather than in the (re-injected every turn) system prompt;
- **the plan skeleton** — the numbered steps and architecture decisions the
  agent is supposed to still be executing hours later.

Compaction is the moment that head is put at risk. Everything before the kept
tail is replaced by a summary, and a summary optimizes for *what happened* —
not for *which rules must keep being obeyed*. Once the exact wording of an
instruction is gone, the agent drifts on long tasks: it re-introduces patterns
it was told to avoid, drops steps from the original spec, quietly relaxes
constraints, or re-litigates decisions that were already settled. Each
subsequent compaction compounds the loss, because summaries are themselves
summarized.

Keeping the head verbatim is cheap insurance against exactly this. The first
~20k tokens are the region where instruction density is highest and narrative
redundancy is lowest — re-including them word-for-word costs little context
and guarantees the rules survive compaction unchanged. That is the entire job
of this extension: make the beginning of the context a fixed point of
compaction.

## Configuration

Optional. Create a JSON config file — project overrides global:

```bash
# project (wins)
.pi/keep-head-compaction.json
# global
~/.pi/agent/keep-head-compaction.json
```

```json
{
  "headTokens": 20000,
  "tailTokens": 20000,
  "model": "google/gemini-2.5-flash",
  "maxTokens": 8192,
  "minMiddleTokens": 500
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `headTokens` | `20000` | Tokens of session start preserved verbatim. Also overridable via the `PI_KEEP_HEAD_TOKENS` env var. Legacy alias: `keepHeadTokens`. |
| `tailTokens` | `20000` | Tokens of session end preserved verbatim. When it differs from pi's `compaction.keepRecentTokens`, it **overrides** the pi setting — the kept tail is re-cut with pi's own cut-point logic at this size. |
| `model` | session model | Summarizer override as `provider/model-id` (e.g. a cheap fast model just for summaries). Falls back to the session model with a warning if not found. |
| `maxTokens` | `8192` | Output budget for the middle summary. |
| `minMiddleTokens` | `500` | Stand down (use default compaction) when the middle span is smaller than this — avoids a no-op compaction loop when head + tail ≈ the whole context. |
| `subagent` | absent | Optional object holding any subset of the keys above, applied only in subagent sessions. See [Subagent sessions](#subagent-sessions). |

### Subagent sessions

**Why children need different budgets.** A subagent is not a smaller copy of
the parent session; it is a different context economy. Its opening messages
are the *contract* — the task brief, file boundaries, acceptance gates, and
"write your report before the clock dies" — and nothing later in the session
restates them. Its recent tail is mostly regenerable working state: tool
output, half-read files, retried commands. A child that loses its head has
lost the task; a child that loses part of its tail usually re-runs one
command. `subagent` expresses that asymmetry without a second config file,
because parent and child share a working directory.

**Example: protect the brief, shrink the tail.**

<!-- subagent-example:start -->
```json
{
  "headTokens": 20000,
  "tailTokens": 20000,
  "subagent": { "headTokens": 12000, "tailTokens": 6000 }
}
```
<!-- subagent-example:end -->

A child keeps 12000 head / 6000 tail while the interactive parent in the same
cwd keeps 20000 / 20000.

**Example: a cheap summarizer for workers.** Children often do routine work,
so a fast small model is usually enough to summarize their middle span. Only
child sessions change; the parent's own summaries stay on the base model:

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "subagent": { "model": "google/gemini-2.5-flash", "maxTokens": 4096 }
}
```

**Example: a worker on a small-window model.** The configured budgets are
scaled to the model that session is actually running, so a child on a smaller
window keeps a proportional head instead of overflowing. Reserving some room
up front is still cheaper than a forced re-compaction:

```json
{
  "subagent": { "headTokens": 8000, "tailTokens": 4000, "minMiddleTokens": 250 }
}
```

**Example: stand down for children entirely.** `headTokens: 0` makes the
extension return `undefined`, so a child gets Pi's default compaction while
parents keep head retention:

```json
{
  "subagent": { "headTokens": 0 }
}
```

**How the merge works.** `subagent` is a shallow merge over the base config:
keys it omits (`model`, `maxTokens`, `minMiddleTokens`, and any budget not
named) keep the base value. Values are validated exactly like the base keys,
so a typo such as `"headTokens": "lots"` is treated as absent and falls back
to the base value instead of breaking compaction. A `subagent` value that is
not a JSON object is ignored.

**How the role is detected.** The only signal is `PI_SUBAGENT_CHILD=1`, set
by the runner process that hosts asynchronous child sessions — never session
lineage. Sessions created with `/fork`, `/clone` or `newSession({ parentSession })`
therefore stay `parent`. Foreground/sync children cannot load extensions at
all, so they never see this feature. A nested `pi` launched from a child's
shell tool inherits the variable and deliberately resolves as `subagent`.

**Precedence.** `global → project → role merge → environment`, so
`PI_KEEP_HEAD_TOKENS` is applied last and overrides the resolved head budget
for **both** parent and child. Window-aware scaling then applies to whichever
budgets the role resolved to, using that session's model. The compaction
notification names the resolved role and budgets, e.g.
`keep-head-compaction: subagent profile: 12000h/6000t ...`, so you can confirm
which profile a child actually used. The same line reports the head as
`head=N messages` when it is carved fresh and as
`head=N chars carried from the earlier compaction` when it is re-emitted from a
prior compaction entry — a carried head is preserved, so a later compaction
never reports the head as `0`.

**Not supported:** per-agent-name profiles (for example different budgets for
`scout` versus a writer) and role-specific environment variables. The config
shape leaves room for the former, but no name discovery or prompt-tag parsing
is performed.

**Small context windows.** If `headTokens + tailTokens + reserveTokens`
exceeds the model's context window, both budgets are scaled down
proportionally (the head:tail ratio is preserved) to fit. An unknown context
window uses the configured values as-is.

## Behavior notes

- The head is carried as text inside the compaction summary (pi's cut-point
  model can't express two verbatim windows natively). The model reads it
  exactly like conversation history; only token accounting differs slightly.
- Keeping the head means compaction frees less context than default. If
  head + tail + summary still exceed your context window, compaction simply
  fires again and compresses the middle harder — the head is always retained.
- Works with manual `/compact`, threshold-triggered auto-compaction, and
  overflow recovery.

## Development

```bash
npm install
npx tsc --noEmit    # types only: strict, no emit
npm test            # node --test over test/*.test.ts
npm run test:coverage
npm run coverage    # writes coverage/report.txt + coverage/badges/*
```

CI (`.github/workflows/ci.yml`) runs the typecheck and the suite on every push
and pull request, then measures coverage with the Node test runner. On `main`
it also publishes `coverage/badges/*.json` to an orphan `badges` branch, which
the shields.io dynamic badges at the top of this file read live — no
third-party coverage service. Line coverage sits lower than branch coverage on
purpose: the `session_before_compact` wiring needs a live Pi extension host to
execute, so it is exercised by hand rather than by unit tests, while the
splitting, budgeting, serialization and config logic that drives it is fully
covered.
