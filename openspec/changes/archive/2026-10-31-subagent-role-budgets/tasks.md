# Tasks

## 1. Confirm the role signal on a real child

- [x] 1.1 Launch one asynchronous subagent whose only instruction is to run
      `printf '%s' "$PI_SUBAGENT_CHILD"` through its shell tool, and verify the
      output is `1` — this is the load-bearing assumption behind the whole
      design (tasks fail loudly here rather than silently in production)
- [x] 1.2 Run the same `printf` in the parent session and verify it prints
      nothing, confirming interactive sessions are not misdetected as children

## 2. Parse the `subagent` block

- [x] 2.1 Add a `RoleOverrides` type and an optional `subagent` key on
      `ExtensionConfig`, with nested parsing that reuses
      `parseNonNegativeInteger` and the `model` string check so invalid values
      degrade to absent; verify `npx tsc --noEmit` passes
- [x] 2.2 Add `test/role-config.test.ts` covering a full block, a partial block,
      an invalid value (`"lots"`), a non-object block, and an absent block, plus
      a `"test": "node --test test/"` script in `package.json`; verify `npm test`
      reports the cases passing
- [x] 2.3 Add the `npm test` step to `.github/workflows/ci.yml` next to the
      existing typecheck step; verify the workflow runs both commands locally
      (`npx tsc --noEmit && npm test`) and that the YAML lists both steps

## 3. Resolve and apply the role

- [x] 3.1 Add exported pure helpers — role detection from
      `PI_SUBAGENT_CHILD === "1"` and a shallow merge of `subagent` over the
      base config with `PI_KEEP_HEAD_TOKENS` applied last — and extend the unit
      tests to cover: child uses the override, parent ignores it, partial
      override inherits base keys, env var wins for both roles, and no
      `subagent` key resolves identically to the base for both roles
- [x] 3.2 Wire the resolution into the `session_before_compact` handler
      (config lookup only; the head split, tail re-cut, summarizer, `details`
      marker and fallbacks stay untouched) and include the resolved role and
      budgets in the existing `ctx.ui.notify` message; verify `npm test` and
      `npx tsc --noEmit` pass and the handler body changes only at the config
      read and the notification
- [x] 3.3 Update `README.md`: add a `subagent` row to the config table, a short
      "Subagent sessions" section stating the parent/child asymmetry, the
      env-precedence rule, and the `headTokens: 0` opt-out; verify by adding a
      test that parses the README example through the config loader and asserts
      the resulting budgets

## 4. Integration checks

- [x] 4.1 Run `npx tsc --noEmit`, `npm test`, and
      `openspec validate subagent-role-budgets --strict` together and verify all
      three pass on the merged tree
- [x] 4.2 Verify upgrade safety: with the `subagent` key removed from a real
      project config, a child session resolves to exactly the base budgets
      (covered by the 3.1 equality test, re-run here as the gate)
- [x] 4.3 Record the one behavior that cannot be forced cheaply — a real child
      compaction — as an observation owed on the next long worker run: its
      compaction notification must name the `subagent` role and the configured
      budgets
      **Owed observation:** next long worker run — confirm a real child
      compaction notifies `keep-head-compaction: subagent profile: <head>h/<tail>t ...`
      and that a parent compaction in the same cwd notifies `parent profile`. A
      live compaction cannot be forced cheaply in a unit test; role detection
      itself was verified on a real async child (`PI_SUBAGENT_CHILD=1`).
