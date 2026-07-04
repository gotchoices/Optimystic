description: Behavior-neutral cleanup landed — the SQL plugin no longer pokes private class members through untyped casts, and the reference-peer CLI's duplicated option list is now defined once.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/reference-peer/src/cli.ts
difficulty: medium
----

## Summary

Two independent, **behavior-neutral** refactors. Build + typecheck + full test
suites pass for both packages; no logic changed.

### Item A — removed the `as any` private-member pokes in `optimystic-module.ts`

Four `as any` casts that reached across class boundaries are gone, replaced by
typed methods/interfaces:

1. **Connection registry (`ensureConnectionRegistered`, module.ts:391).**
   `this.db as any` → `this.db as DatabaseInternal`. `DatabaseInternal` is
   Quereus's documented public extension-point interface (exported from
   `@quereus/quereus`, declares `getConnectionsForTable` / `registerConnection`);
   its own docstring shows exactly this `this.db as DatabaseInternal` pattern.
   One typed cast with a comment instead of blanket `any`.

2. **IndexManager internals (`addIndex`, module.ts:1243-1245).** The two pokes
   `(this.indexManager as any).indexTrees.set(...)` and
   `(this.indexManager as any).schema = updatedSchema` now call two new public
   methods on `IndexManager` (index-manager.ts): `registerIndexTree(name, tree)`
   and `setSchema(schema)`. `indexTrees` and `schema` stay private.

3. **Table teardown (`OptimysticModule.destroy`, module.ts:~1907).** The two
   pokes `(table as any).txnBridge?...` / `(table as any).schemaManager...` now
   call a single new method `deleteOwnSchema(tableName)` on
   `OptimysticVirtualTable`, which reads its *own* `txnBridge`/`schemaManager`
   internally. The best-effort try/catch stays at the call site (unchanged).
   Note: `txnBridge` is a non-optional field always set in the constructor, so
   dropping the old optional-chaining (`?.`) is safe — the same
   `this.txnBridge.getCurrentTransaction()` call is used unconditionally
   elsewhere in the class.

Left untouched per ticket scope: the `col.affinity as any` casts at
module.ts:215-216 (enum-narrowing on external Quereus types, not private pokes).

### Item B — de-duplicated the triplicated CLI options in `reference-peer/src/cli.ts`

The ~17 network/storage options that were copy-pasted onto the `interactive`,
`service`, and `run` commands are now defined once in a
`withCommonPeerOptions(cmd: Command): Command` helper applied to each command.
Command-specific options are layered *after* the helper:
- `run` keeps `--stay-connected`, the `requiredOption` `-a, --action`, `--diary`,
  and `--content`.
- `interactive` / `service` add nothing beyond the common set.

Every flag string, description, and default is byte-identical to before, so each
`.action()` receives the same parsed `options` object. The only observable
change is help-text *ordering* of `--bootstrap-file` (it sat mid-list on
`service`, end-of-list on the others; now uniformly end-of-list via the helper) —
does not affect parsing.

## Use cases to validate (reviewer)

**Item A is exercised by existing plugin tests — no new tests added.** Confirm
the touched paths still behave:

- **`addIndex` path (A.2)** — `CREATE INDEX` after data exists must still build,
  register, and populate the index tree. Covered live by the plugin test
  "Multi-collection (table + index)" (create index, insert, update-rekey,
  delete, all replicated 3-node). This passed.
- **Teardown path (A.3)** — `DROP TABLE` / `xDestroy` must still delete the
  persisted schema, best-effort. Confirm a schema-tree write failure during
  destroy is still swallowed (the try/catch is unchanged, but verify the moved
  logic reads the right transactor).
- **Connection registry (A.1)** — first table access still registers/reuses one
  connection per table. Exercised implicitly by every transactional test.

**Item B** — verified by building and running `--help` on all three commands:
option counts are interactive 17, service 17, run 21 (matching pre-refactor).
A reviewer wanting deeper assurance could diff `--help` output flag-by-flag
against the pre-refactor commit, or assert `program.commands` option specs in a
unit test (none exists today — see gaps).

## Known gaps / honest notes

- **No new automated test locks in the refactors.** Both items are covered only
  by *pre-existing* behavior tests plus a manual `--help` smoke check. If someone
  re-introduces an option divergence in one CLI command, or changes `deleteOwnSchema`
  to read the wrong transactor, no test would catch it directly. Judged acceptable
  for a mechanical, behavior-neutral refactor, but flagging it rather than papering
  over it. A `program.commands`-shape assertion for cli.ts and a destroy-path unit
  test would close the gap if the reviewer wants belt-and-suspenders.
- **`updatedSchema` typing in `addIndex`.** It's an inferred object literal spread
  from `StoredTableSchema`; `setSchema(updatedSchema)` typechecks clean, but the
  old `as any` had masked any drift here — worth a glance that the inferred shape
  is genuinely `StoredTableSchema`-assignable (it is, per `tsc --noEmit` exit 0).

## Tripwires

None introduced. No `NOTE:` comments added — the refactor created no new
conditional concerns.

## Pre-existing (not this ticket)

- **`orderingMatchesPrimaryKey` "declared but never read"** hint in
  `optimystic-module.ts` (~line 1856 after this diff shifted it). Dead private
  method, untouched by this ticket; `tsc --noEmit` still exits 0 (hint, not
  error). Not filed.
- **"Unreachable code" hint** at `cli.ts` ~line 662 (the `break` after
  `process.exit(0)`). Outside this diff; already documented as pre-existing in
  the `optimystic-reference-peer-offline-storage-share` complete ticket. Not
  filed.

No `.pre-existing-error.md` written: no *test* failed — these are editor-level
hints only, and both builds/test suites are green.

## Validation

- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` — clean (exit 0).
- `yarn workspace @optimystic/quereus-plugin-optimystic build` (tsup) — clean.
- `yarn workspace @optimystic/reference-peer build` (tsc) — clean.
- Plugin tests — **296 passing, 11 pending**.
- Reference-peer tests — **6 passing**.
- `node dist/src/cli.js {interactive,service,run} --help` — option counts
  17/17/21 as expected; `run` order: 17 common + stay-connected + action +
  diary + content.
