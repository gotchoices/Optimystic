description: The optimystic-backed table now honors what a table declares should happen on duplicate rows — quietly skipping or overwriting instead of always raising an error — including after a warm restart.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-hydrate.spec.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
----

## What shipped

SQL lets a uniqueness rule declare its own conflict action (`unique on conflict
ignore`, `primary key (…) on conflict replace`, `id integer primary key on
conflict replace`). The optimystic virtual table previously discarded every such
declaration and honoured only the statement-level spelling (`insert or ignore …`).
Three gaps are closed:

**The declared action is read at all four conflict sites.** One resolver,
`resolveConflictAction(stmt, declared)`, implements the precedence *statement-level
`OR` > the rule's own declared action > ABORT* — the same chain the engine's
in-memory table resolves. `pkDeclaredConflict()` supplies the primary key's declared
action (table-level clause first, else the column-level action on any PK column); it
mirrors quereus's unexported `resolvePkDefaultConflict` and carries a `NOTE:` naming
that upstream site.

**REPLACE against a secondary UNIQUE evicts.** A colliding row at a *different*
primary key is deleted (main-table slot plus all index entries) and reported through
`UpdateResult.evictedRows`, so the engine runs its full delete pipeline per evicted
row. Several constraints can each evict a different row in one write.

**The PK's declared action persists.** `StoredTableSchema.primaryKeyDefaultConflict`
and `StoredColumnSchema.defaultConflict` are written on store and restored on both
the hydrate-catalog path and `doInitialize`'s placeholder-rebuild branch. Both hold
`undefined` when absent, which JSON serialization omits, so action-free tables stay
byte-identical with pre-upgrade schemas and keep the no-write short-circuit.

Two resolution decisions are made before anything is staged — the primary-key move
(when the key changes) and then the secondary UNIQUE constraints, the second taking
the first's outcome as an input. A rejected or swallowed write therefore stages
nothing, which matters because this vtab has no statement-savepoint machinery to
undo a partial eviction with.

## Known limits (deliberate)

- **FAIL and ROLLBACK are honoured as ABORT** when resolved from a *declared* action.
  The engine picks the FAIL/ROLLBACK unwind branch from the error subclass, which it
  synthesizes only from the statement-level clause; neither subclass is exported for
  a virtual table to throw, and the engine's own in-memory table has the same limit.
  Recorded as a `NOTE:` on `resolveConflictAction`.
- **An INSERT whose primary key collides and resolves REPLACE never checks the
  secondary UNIQUE constraints**, so it can leave a duplicate in a UNIQUE column.
  This is the engine's documented contract shape for the `replacedRow` channel and
  the in-memory table behaves identically — verified, not filed. See *Review
  findings*.
- **Dangling index entries are unobservable from SQL.** Both the uniqueness probe and
  index-driven scans re-validate every candidate against the main table and skip
  missing rows, so "the evicted row is gone from every index tree" cannot be
  falsified at the SQL level. Tests assert it the strongest observable way instead.

## Validation

`yarn lint` (clean), package `typecheck` + `build`, package tests **411 passing,
11 pending, 0 failing**; root `yarn build` + `yarn test` across all workspaces
**3884 passing, 0 failing**.

## Review findings

### Checked

- Read the implement-stage diff (`3952976`) before the handoff summary: both source
  files and all three spec files, plus every call site the changed helpers touch.
- Verified `pkDeclaredConflict()` against quereus's `resolvePkDefaultConflict`
  (`schema/table.ts:1124`) — an exact clone — and confirmed the symbol really is
  absent from quereus's `index.ts` exports, so the duplication's justification holds.
  (`@quereus/quereus` resolves through a `portal:` link to the sibling repo, so the
  source under `node_modules` is the real thing.)
- Verified `schemasEqual` is `JSON.stringify`-based, so `undefined`-valued keys
  genuinely vanish and the byte-equal claim for the two new schema fields holds. The
  pre-existing hydrate test already pins zero schema writes on reopening an
  action-free table (`secondary-unique-hydrate.spec.ts:341`), which is the assertion
  that claim needs.
- Verified the engine consumes both displacement channels on the INSERT and UPDATE
  paths, and that it does skip its delete pipeline for evictions reported on a
  row-less result (`dml-executor.ts:1208`) — the premise of the implementer's
  documented divergence, which is therefore accurate.
- Differential-tested the vtab against the engine's in-memory table over ~20 conflict
  shapes (declared vs statement action, PK vs secondary, INSERT vs UPDATE vs PK move,
  composite keys, multi-row batches, upsert clauses, explicit-transaction rollback).
- Ran lint, typecheck, build, package tests, root build, root tests.

### Found and fixed in this pass

**One correctness defect, three wrong outcomes, one root cause.** The UPDATE path
resolved the secondary UNIQUE constraints *before* deciding the primary-key move, and
its probe counted the row sitting at the target key — the very row a REPLACE is about
to displace — as a live collision. The flaw was latent until this ticket made the
declared PK action reachable: quereus has no `update or <action>` grammar and its
planner passes no statement-level action for UPDATE, so before this change the
UPDATE PK IGNORE/REPLACE branches had no SQL route into them at all. All three
outcomes were confirmed by running the same statements against the in-memory table:

- `primary key on conflict replace` with a default-ABORT secondary whose only
  collision is the row being displaced → the statement was **wrongly rejected**.
- The same shape with the secondary declaring IGNORE → the whole UPDATE was
  **silently swallowed**: wrong result, no error, worst of the three.
- `primary key on conflict ignore` where a secondary would ABORT against a third row
  → **wrongly rejected**, even though the swallowed move means the row never takes
  the colliding value.

Fixed by taking the PK-move decision first and feeding its outcome into the probe's
exclusion set: the new `resolvePkMoveDecision` returns clear / swallow / blocked /
displace, and `excludeKey?: string` became `excludeKeys?: ReadonlySet<string>`
throughout the probe chain. This also let the UPDATE arm's three near-identical
staging tails collapse into one and retired the `pendingEvictions.filter(c => c.pk
!== newKey)` special case (net −10 lines in the module). Four regression tests added
to `insert-pk-uniqueness.spec.ts`, on real file storage with reopen assertions.

**Docs were out of date.** The README's warm-restart section documented persisted
uniqueness metadata but not the declared conflict action, which is new persisted
metadata under exactly the same one-time upgrade caveat. Updated, and added the
declared-vs-statement precedence rule and the FAIL/ROLLBACK-as-ABORT limit — both
things a user hits directly and neither stated anywhere user-facing before.

**Three test gaps filled** in `secondary-unique.spec.ts`. The implementer's suite
covered the matrix well but left three behaviours the handoff itself flagged as
unpinned: the deliberate REPLACE-then-IGNORE divergence (a chosen behaviour with no
test guarding it), an eviction rolled back inside an explicit transaction, and a
declared action on a *composite* secondary UNIQUE. All three pass as designed.

### Checked and deliberately not filed

- **INSERT PK-REPLACE leaves a duplicate secondary UNIQUE value.** Confirmed live:
  `insert or replace` onto an occupied primary key whose new row duplicates another
  row's UNIQUE column produces two rows sharing that value, resolvable through the
  index. The engine's in-memory table does exactly the same, and quereus's
  `common/types.ts` documents this short-circuit as the contract shape. Changing it
  is an engine-wide decision, not this virtual table's to take unilaterally.
- **`ON CONFLICT (col) DO UPDATE` never fires when the constraint declares its own
  action.** The declared action resolves first, so the vtab never returns the
  constraint result the upsert clause is driven from. Verified byte-for-byte
  identical in the in-memory table — an upstream precedence question, not an
  optimystic defect.
- **FAIL/ROLLBACK honoured as ABORT.** An accepted limitation with a `NOTE:` already
  at the site, an upstream API gap (neither error subclass is exported), and exact
  parity with the engine's own table. The fix ticket explicitly asked for a note
  rather than a ticket; nothing has changed to reopen that.

### Tripwires

- Added a `NOTE:` on `resolvePkMoveDecision` recording that optimystic now
  *deliberately* diverges from the in-memory table on the UPDATE path — memory
  returns as soon as a PK REPLACE resolves and leaves a duplicate UNIQUE value
  behind, while optimystic still resolves the secondary constraints and keeps the
  constraint true — and why the INSERT path nonetheless keeps memory's short-circuit.
  Without it, the next reader comparing the two modules reads the asymmetry as a bug.
- No conditional-performance tripwires surfaced. The probe is a point lookup per
  binding constraint per row, unchanged in complexity by this work.

### Accepted tradeoffs encountered

None. No `NOTE:` marking a previously-declined finding sits at any site this review
touched, so nothing was skipped on those grounds.

### Major findings filed as tickets

None. The single defect found was contained to one function's ordering, with a
root cause that named itself and a fix that made the surrounding code smaller; filing
it and shipping a known silent-wrong-result would have been the worse trade.

### Noted, not filed

`optimystic-module.ts` measures 2712 lines (`wc -l`), 10 fewer than the implement
commit left it. That is a large file, but the size is pre-existing and unrelated to
this diff — splitting it is its own architectural call and does not belong to a
drive-by from this review.
