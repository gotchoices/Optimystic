description: Behavior-neutral cleanup landed and reviewed — the SQL plugin no longer reaches into private class members through untyped casts, and the reference-peer CLI's duplicated option list is now defined once.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/reference-peer/src/cli.ts
difficulty: medium
----

## Summary

Two independent, behavior-neutral refactors, implemented in commit `71bd542`
and reviewed here:

- **Item A** — replaced four `as any` private-member pokes in
  `optimystic-module.ts` with typed methods/interfaces:
  - `this.db as any` → `this.db as DatabaseInternal` (connection registry).
  - `(this.indexManager as any).indexTrees.set(...)` / `.schema = ...` → two new
    public `IndexManager` methods `registerIndexTree(name, tree)` /
    `setSchema(schema)`; the fields stay private.
  - `(table as any).txnBridge?...` / `(table as any).schemaManager...` in
    `destroy()` → one new `OptimysticVirtualTable.deleteOwnSchema(tableName)` that
    reads its own bridge/manager internally.
- **Item B** — collapsed the ~17 network/storage options triplicated across the
  `interactive`, `service`, and `run` commands into one
  `withCommonPeerOptions(cmd)` helper in `reference-peer/src/cli.ts`;
  command-specific options are layered after the helper.

Both builds, typechecks, and full test suites are green. No logic changed.

## Review findings

Reviewed the implement diff (`git show 71bd542`) with fresh eyes before reading
the handoff. Adversarial pass across the requested angles:

**Correctness — none found.**
- **A.1 `DatabaseInternal`** — confirmed it resolves and typechecks (plugin
  `typecheck` exits 0); `db.getConnectionsForTable(...)` typechecks against it.
- **A.2 typed index methods** — `registerIndexTree(name, tree: Tree<IndexKey,
  IndexEntry>)` and `setSchema(schema: StoredTableSchema)` typecheck clean.
  `updatedSchema` (an object-spread of `StoredTableSchema` with `indexes`
  overridden) is genuinely `StoredTableSchema`-assignable — the old `as any` had
  masked any drift here; the typed method would now *catch* it. Net safety win,
  not just cosmetic.
- **A.3 `deleteOwnSchema`** — verified `txnBridge` and `schemaManager` are both
  **non-optional** fields (module.ts:100,103) assigned unconditionally in the
  constructor (129,130), so dropping the old double-optional
  (`txnBridge?.getCurrentTransaction?.()`) is safe: the only case where the old
  and new code could differ is `txnBridge === undefined`, which never holds for a
  constructed instance sitting in `this.tables`. `destroy()` calls
  `table.deleteOwnSchema(tableName)` on the same instance it poked before, and
  passes the destroy `tableName` argument (matching the old behavior, which also
  used the param rather than the instance field). Best-effort try/catch at the
  call site unchanged. Behavior-equivalent.
- **Residual `as any`** — only the two `col.affinity as any` enum-narrowing casts
  (module.ts:215-216) remain; explicitly out of scope (external Quereus type
  narrowing, not private pokes). Correct to leave.
- **B CLI** — `withCommonPeerOptions` returns the command so `.action`/
  command-specific `.option` chains correctly. `--help` option counts confirmed
  live: interactive 17, service 17, run 21 (17 common + `--stay-connected` +
  required `--action` + `--diary` + `--content`) — matches pre-refactor. Only
  observable change is help-text ordering of `--bootstrap-file` on `service`;
  parsing unaffected.

**Test coverage — gap acknowledged, concurred, not filed.** No new automated
test locks in either refactor; both rely on pre-existing behavior tests plus a
`--help` smoke check. For Item B the single-source helper makes common-option
divergence *structurally* impossible (one definition, three callers), which is a
stronger guarantee than a regression test would give, so a `program.commands`
shape assertion would add marginal value — not added. For Item A the touched
paths (CREATE INDEX populate, DROP TABLE teardown, connection registry) are
exercised live by existing passing plugin tests. Judged acceptable for a
mechanical behavior-neutral refactor; recorded here rather than papered over.

**Minor — one observation, left as-is.** `deleteOwnSchema(tableName: string)`
takes a `tableName` param that duplicates `this.tableName`. Intentional: it
preserves the exact prior behavior (the old inline poke used the `destroy`
`tableName` argument, not the instance field). No change.

**Tripwires — none.** The refactor introduced no new conditional concerns; no
`NOTE:` comments added.

**Docs — no drift.** No architecture/README docs describe the private-poke
internals or the per-command CLI option lists that changed; nothing to update.

**Pre-existing (not this ticket, not filed):**
- `orderingMatchesPrimaryKey` "declared but never read" hint in
  `optimystic-module.ts` — dead private method, untouched here; `tsc` still exits
  0 (hint, not error).
- "Unreachable code" hint at `cli.ts` (the `break` after `process.exit(0)`) —
  outside this diff; already documented as pre-existing in the
  `optimystic-reference-peer-offline-storage-share` complete ticket.

No `.pre-existing-error.md` written — no *test* failed; these are editor-level
hints only.

## Validation (re-run in review)

- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` — exit 0.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **296 passing, 11 pending**.
- `yarn workspace @optimystic/reference-peer build` (tsc) — exit 0.
- `yarn workspace @optimystic/reference-peer test` — **6 passing**.
- `node dist/src/cli.js {interactive,service,run} --help` — option counts 17/17/21.
- No `lint` script exists in either package; `tsc` (typecheck/build) is the
  static gate, and both exit 0.

## Disposition

Behavior-neutral, type-safe, well-documented. No inline fixes required, no new
tickets, no tripwires. Complete.
