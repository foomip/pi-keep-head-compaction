# pi-keep-head-compaction

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
