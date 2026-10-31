# Design

## Context

The extension has a single config-resolution point: `loadConfig(ctx.cwd)` at
the top of the `session_before_compact` handler, whose result feeds
`scaleBudgets(...)` and then the untouched compaction pipeline (head split,
tail re-cut, summarizing, `details` marker, fallbacks). See proposal.md — Why
for the motivation.

Constraints that shape the approach:

- **Where the extension can run as a child.** `pi-subagents` hosts async
  children as in-process `AgentSession`s inside a runner process
  (`src/runs/shared/child-session.js`), and only that host loads ambient
  extensions (`child-launch.js:199`; foreground children set
  `noExtensions`, `child-launch.js:106`). The extension therefore never
  registers in a foreground/sync child, so role support is only ever needed
  for runner-hosted sessions.
- **A role signal already exists for exactly that population.** The runner
  sets `process.env.PI_SUBAGENT_CHILD = "1"` at startup
  (`subagent-runner.js:89`), and every child session it hosts inherits it.
  Interactive sessions, and sessions forked or cloned from them, do not.
- **Session lineage is not a role signal.** pi's `SessionHeader.parentSession`
  is also set by `/fork`, `/clone` and `newSession({ parentSession })`
  (`docs/session-format.md`), so lineage would misclassify user forks.
- Everything the pipeline needs per session (`ctx.model.contextWindow`,
  `ctx.cwd`) is already the *child's* inside a child session, so scaling,
  project-config resolution and the summarizer model are correct today. Only
  the numbers are wrong.

## Goals / Non-Goals

**Goals:**

- Resolve budgets per session role with zero behavior change when the new
  config key is absent.
- Keep the change to a config parse + one pure resolution function, so the
  pipeline and its fallbacks stay as they are.
- Make a child's effective profile observable without reading the session file.

**Non-Goals:**

- Per-agent-name profiles (`scout` vs a writer). The config shape must not
  block them, but no name discovery, no `<active_agent>` prompt-tag parsing.
- Role-specific environment variables.
- Supporting role budgets in foreground/sync children, which cannot load the
  extension at all.
- Correcting the `Tail retention` requirement's `prepareCompaction` drift.

## Decisions

**1. Role = `process.env.PI_SUBAGENT_CHILD === "1"`, evaluated per compaction.**
Alternatives: (a) parse the child's `<active_agent name="...">` prompt tag —
only needed for per-name profiles and couples us to a prompt format; (b)
`ctx.sessionManager.getHeader().parentSession` — misclassifies forks and clones;
(c) a pi-subagents launch option that names the role — requires a coordinated
release of another package for a boolean we can already read. The env var is
read on every compaction rather than cached, because it cannot change within a
process and caching would only add invalidation surface.

**2. The override key is `subagent` and it accepts the full key set.**
It is shallow-merged over the base config, so `model`/`maxTokens`/
`minMiddleTokens` can differ for children (a cheap summarizer for a worker is a
reasonable want) at no code cost: one merge loop covers every key. Restricting
it to `headTokens`/`tailTokens` would need an explicit allowlist to enforce,
i.e. more code for less capability.

**3. Precedence stays env-last:** `global → project → role merge → env`.
`PI_KEEP_HEAD_TOKENS` continues to mean "this session's head budget" and wins
for both roles. Adding `PI_KEEP_HEAD_TOKENS_SUBAGENT` would double the
precedence matrix for a knob nobody has asked for.

**4. Identity default, no shipped divergent profile.** An absent `subagent`
block resolves to the base config, so upgrading changes nothing for existing
users. The alternative — shipping e.g. `subagent: {headTokens: 12000,
tailTokens: 6000}` as a built-in default — would silently change every existing
user's child sessions on version bump.

**5. Reuse the existing stand-down as the opt-out.** With `headTokens: 0`,
`splitHead` returns an empty head and the handler's existing
`head.length === 0 && prior === undefined` early return yields `undefined`, so
Pi's default compaction runs. This is pre-existing behavior, not new code; it
gets documented because `headTokens: 0` reads like "no head" but behaves like
"opt out of this extension".

**6. Validation is lenient, matching the base keys.** Non-integer, negative,
non-numeric-string and non-object values are treated as absent, exactly as the
top-level keys already are (`parseNonNegativeInteger` + the `model` string
check), so a typo degrades to the base value instead of throwing inside a
compaction hook.

## Risks / Trade-offs

- **`PI_SUBAGENT_CHILD` is owned by another package** → treat it as a
  best-effort signal: absent means `parent`, which is today's behavior. Add the
  runtime check (a real async child printing the variable) to the tasks so a
  renamed variable fails loudly at verification time, not silently in
  production.
- **A nested `pi` launched from a child's shell tool inherits the variable** and
  would resolve as `subagent` → acceptable: nested CLIs are rare, and the
  consequence is a smaller head, not a broken compaction.
- **A child with a tiny window and a large configured head** can scale down to
  a head too small to hold its brief → mitigated by the existing proportional
  scaling plus `minMiddleTokens` stand-down; document the ratio behavior rather
  than add a floor (a floor would silently break `scaleBudgets`' guarantee that
  head + tail fit the window).
- **Two config surfaces invite confusion** (`headTokens` vs
  `subagent.headTokens`) → mitigated by the notification naming the resolved
  role, and by the README showing one worked example rather than a key list.
- **Notifications are per-compaction noise in a child** → the message already
  fires once per compaction today; adding a role tag costs nothing.

## Migration Plan

None required: the key is optional, defaults preserve current behavior, and a
downgrade simply ignores the block. Rollback is deleting the `subagent` block
(or pinning the previous version).
