description: The optimystic-backed table now honors what a table declares should happen on duplicate rows — quietly skipping or overwriting instead of always raising an error — including after a warm restart; this needs a code-review pass.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-hydrate.spec.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
difficulty: hard
----

## What was implemented

SQL lets a uniqueness rule declare its own conflict action (`unique on conflict
ignore`, `primary key (…) on conflict replace`). The optimystic virtual table
previously discarded every such declaration and honoured only the statement-level
spelling (`insert or ignore …`). All three gaps from the fix ticket are closed:

**1. The declared action is now read (all four conflict sites).** One resolver,
`resolveConflictAction(stmt, declared)` in `optimystic-module.ts`, implements the
precedence *statement-level OR > the rule's own declared action > ABORT* — the
same chain the engine's in-memory table resolves. `pkDeclaredConflict()` supplies
the PK's declared action (table-level `primary key (…) on conflict X` first, else
the column-level action on any PK column); it mirrors quereus's unexported
`resolvePkDefaultConflict` and carries a `NOTE:` naming that upstream site. The
three code comments claiming "No per-constraint default in optimystic" are gone.

**2. REPLACE against a secondary UNIQUE evicts.** Previously `insert or replace`
colliding on a secondary UNIQUE (not the PK) failed. Now the colliding row at its
*different* PK is deleted (main-table slot + all index entries, as the delete arm
does) and reported through `UpdateResult.evictedRows`, so the engine runs its full
delete pipeline per evicted row. Several constraints can each evict a different row
in one write.

**3. The PK's declared action persists.** `StoredTableSchema` gains
`primaryKeyDefaultConflict?` and `StoredColumnSchema` gains `defaultConflict?`
(schema-manager.ts). Written by `tableSchemaToStored`/`columnSchemaToStored`,
restored by `storedToTableSchema` (hydrate-catalog path) and by `doInitialize`'s
placeholder-rebuild branch. Both keys hold `undefined` when absent, which JSON
serialization omits — so action-free tables stay byte-identical with pre-upgrade
schemas and keep the no-write short-circuit (asserted); a table that *does*
declare an action re-writes its schema exactly once, then short-circuits
(asserted). The secondary-UNIQUE action was already persisted before this ticket.

## Key design decisions the reviewer should challenge

- **Two-pass secondary-unique resolution** (`resolveSecondaryUniqueDecision`):
  every binding constraint is probed and its action resolved *before anything is
  staged*, so a blocking outcome (ABORT/FAIL/ROLLBACK) stages nothing — statement
  atomicity never depends on undoing a partial eviction, which this vtab has no
  statement-savepoint machinery for. Constraints are processed in declared order;
  the first IGNORE or blocking hit decides the row (memory-module parity), REPLACE
  hits accumulate evictions and keep scanning.
- **One deliberate divergence from the memory module**, documented in a `NOTE:` on
  that method: in the degenerate shape where an earlier constraint resolves
  REPLACE and a later one IGNORE (both colliding), memory deletes the REPLACE
  collision and *then* swallows the write — and the DML executor skips its delete
  pipeline for evictions reported on a row-less result
  (`dml-executor.ts:1208` returns before `processEvictions`), leaving those
  deletes untracked. Here the swallow discards the pending evictions, so a
  swallowed write changes nothing at all.
- **PK-collision short-circuit retained** (memory parity): an INSERT whose PK
  collides and resolves REPLACE overwrites in place and never checks secondary
  uniques — same as the engine's memory module; a comment in `types.ts` upstream
  documents this exact shape.
- **UPDATE PK-move + secondary evictions**: the row REPLACE displaces at the
  target key travels the `replacedRow` channel; any secondary eviction aimed at
  that same row is filtered out so it is not deleted/reported twice. Evictions are
  deduped by PK across constraints. A swallowed or rejected PK move discards
  pending secondary evictions untouched.
- **UPDATE reachability**: quereus has no `update or <action>` grammar and its
  planner passes no statement action for UPDATE, so the constraint-level
  declaration is the *only* SQL route into the UPDATE IGNORE/REPLACE branches —
  they are now genuinely exercised for the first time (tests below). The stale
  "unreachable-by-construction" comment in `insert-pk-uniqueness.spec.ts` was
  rewritten.

## Known limits (deliberate, not follow-up tickets)

- **FAIL and ROLLBACK are honoured as ABORT** when resolved from the vtab. The
  engine picks the FAIL/ROLLBACK unwind branch from the error subclass, which it
  synthesizes only from the statement-level clause; neither subclass is exported
  for a vtab to throw, and the engine's own memory module has exactly the same
  limitation. Recorded as a `NOTE:` on `resolveConflictAction` per the fix
  ticket's instruction — an upstream API gap, no ticket filed.
- **Dangling index entries are unobservable from SQL.** Both the uniqueness probe
  and index-driven scans re-validate every candidate against the main table and
  skip missing rows, so "evicted row is gone from every index tree" cannot be
  falsified at the SQL level even in principle. The tests assert it the strongest
  observable way: indexed-column queries resolve only the new owner, plus a
  collide → delete → re-insert sequence proving the tree holds exactly one live
  entry.
- **Statement-level matrix cells are not repeated through hydrate** — they read no
  persisted metadata, so the fresh-CREATE coverage is the meaningful one. All 15
  constraint-level cells (5 actions × {secondary, PK-table-level, PK-column-level})
  run through hydrate with no DDL replay.

## Validation performed

- `yarn build`, `yarn typecheck`, `yarn test` in
  `packages/quereus-plugin-optimystic`: **404 passing, 11 pending, 0 failing**
  (was 359 before; +45 new tests).
- Root `yarn build` + `yarn test` (all workspaces, for the schema-format change):
  **3877 passing, 0 failing**.
- No `docs/` page claims only statement-level conflict handling (swept; nothing to
  update).

## Test inventory (where to poke)

- `test/secondary-unique.spec.ts` — 10-cell matrix {statement, constraint} ×
  {ignore, replace, abort, fail, rollback} on a secondary UNIQUE; statement-OR-
  beats-declared precedence; REPLACE eviction through a *declared* unique index
  (indexed lookup, count, collide/delete/re-insert); multi-constraint one-write
  double eviction; UPDATE onto an occupied value under declared ignore/replace.
- `test/insert-pk-uniqueness.spec.ts` — 10-cell PK matrix {table-level,
  column-level} × 5 actions on real file storage; statement-OR precedence over
  declared PK action; `insert or fail` / `or rollback` rejection; UPDATE PK-move
  under declared ignore (swallowed, reopen-verified) and replace (displaces,
  reopen-verified).
- `test/secondary-unique-hydrate.spec.ts` — all 15 constraint-level cells reached
  through hydrate with no DDL replay; PK-action stabilization (pre-upgrade tamper
  → exactly one re-write on re-declare, then zero, enforcement live both times).

Suggested review probes beyond the suite: REPLACE eviction interacting with FK
RESTRICT (the executor's `processEvictions` enforces it post-eviction — untested
here since the package's tests don't exercise FKs); constraint-level actions on a
composite secondary UNIQUE; an eviction inside an explicit transaction that then
rolls back (rollback restores evicted rows via the pre-stage snapshot —
`markDirtyTrees` runs before eviction staging, but no test pins that specific
sequence).
