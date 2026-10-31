# Proposal

## Why

The extension resolves one head/tail budget for every session it runs in. That
is a poor fit for subagent sessions, which have a different context economy
than an interactive parent session: a child's opening messages are the *contract*
(its task brief, file boundaries, acceptance gates, "write your report before
the clock dies"), while its recent tail is largely regenerable working state
(tool output, half-read files, retried commands). A child with a small context
window can also lose the load-bearing part — nothing else in its session
restates the brief — while spending its budget on low-value tail.

Today the only way to express that difference is a per-project config file,
which cannot distinguish a child from the parent running in the same working
directory. Every asynchronous worker in a lane therefore inherits the parent's
budgets.

## What Changes

- Add an optional `subagent` object to the config file, holding the same keys
  as the top level (`headTokens`, `tailTokens`, `model`, `maxTokens`,
  `minMiddleTokens`), shallow-merged over the base config **only** in sessions
  that are running as a subagent. Absent or partial, unspecified keys keep the
  base value.
- Detect the role per session from `PI_SUBAGENT_CHILD` (already `"1"` in every
  process that hosts child sessions and the only population where the extension
  registers as a child).
- Include the resolved role in the compaction notification so a child's
  effective profile is observable (`... subagent profile: 8000h/6000t ...`).
- Document the semantics, including the zero escape hatch
  (`"subagent": { "headTokens": 0 }` stands the extension down for children, so
  they get Pi's default compaction).
- No change to the parent role, no change to defaults: config that omits
  `subagent` behaves exactly as today.

Not included: per-agent-name profiles (e.g. different budgets for `scout` vs a
writer), and role-specific environment variables.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `compaction`: the `Configuration` requirement gains role-scoped resolution
  (a `subagent` override block, its precedence against the base config and
  `PI_KEEP_HEAD_TOKENS`), and a new requirement defines how the role is
  detected and that unresolved roles fall back to the base config unchanged.
  Requirement `Window-aware budget scaling` gains the clarification that it
  scales whichever budget the role resolved to, per session.

## Impact

- `extensions/keep-head-compaction.ts` — config type, nested parsing/validation,
  a pure role-resolution helper, and the handler's config lookup; the
  compaction pipeline (head split, tail re-cut, summarizing, details marker,
  fallbacks) is untouched.
- `README.md` — config table plus a short "Subagent sessions" section.
- `openspec/specs/compaction/spec.md` — delta modifies `Configuration` and
  `Window-aware budget scaling`, and adds `Role-scoped budgets`.
- Flagged, deliberately out of scope: requirement `Tail retention` describes
  recomputing the cut through `prepareCompaction(...)`, while the code uses
  `findCutPoint`. That drift is unrelated to role budgets and should be
  corrected by its own docs change, not folded in here.
- No dependency, packaging, or Pi-API changes. Existing configs keep working.
