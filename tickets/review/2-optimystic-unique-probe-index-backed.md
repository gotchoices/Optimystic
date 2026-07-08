description: A UNIQUE column used to re-read the whole table for every row written (quadratic on bulk inserts); it now checks each value with a fast index lookup instead. Review the change.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-migration.spec.ts
difficulty: hard
----

## What this ticket did

Replaced the full-table scan that enforced every secondary UNIQUE constraint on the
optimystic virtual table with an **index-backed point probe**. Before, each INSERT/UPDATE
row scanned the entire main collection once per DML row (O(N) per row → O(N²) for a bulk
insert). Now each UNIQUE constraint is enforced by a `findByIndexIn` point range over a
backing index tree (~O(log n) per constraint per row).

The core problem was that most UNIQUE constraints have **no backing index tree**: a
column-level `col unique` or table-level `unique (a, b)` produces a `uniqueConstraint`
with no matching entry in `tableSchema.indexes`, so there was nothing to probe. The fix
gives every point-enforceable UNIQUE constraint a tree.

### Mechanism

1. **Unique-enforcement indexes (`IndexManager`).** A second internal list of index
   descriptors (`uniqueEnforcementIndexes`), kept OUT of the persisted
   `StoredTableSchema` and never surfaced to the planner. Iterated alongside
   `schema.indexes` via `getAllMaintainedIndexes()`, so insert/delete/update staging
   maintains their trees automatically. Kept in a separate list (not folded into
   `schema.indexes`) so a later `CREATE INDEX` → `setSchema(...)` cannot silently drop
   them. Their trees live in the same `indexTrees` map as declared indexes, so
   `getIndexTrees()` (and thus dirty-marking / bridge registration / rollback) includes
   them with no extra wiring.

2. **Which constraints get a synthesized tree (`buildUniqueEnforcementIndexes`, in
   `doInitialize`).** Skips partial constraints (`predicate !== undefined`), constraints
   whose columns match the PRIMARY KEY (already structural), and constraints whose columns
   match a declared index (reuse that tree — covers `CREATE UNIQUE INDEX`). Everything
   else gets a descriptor with a reserved name `_uniq_<sorted-col-indices>` (stable across
   restarts) opened at `<collectionUri>/index/_uniq_...`. Runs BEFORE
   `registerCollections()` so the bridge snapshots the new trees.

3. **One-time backfill (`ensureUniquePopulated`).** A table created under this build
   maintains its unique tree from row one. A table whose rows were written by an OLDER
   build never maintained it — its tree is empty while the main table is populated, so a
   probe would silently admit a duplicate. On first probe, if the synthesized tree is
   empty, scan the main table once and stage each non-NULL-bearing row's entry into the
   unique tree in ISOLATION (stage + `sync()` only — never touches the caller's staged
   main-table mutations), mirroring `addIndex`. Runs at most once per tree per process.

4. **The probe (`checkUniqueConstraints`).** Per active constraint: resolve the enforcing
   tree (`resolveEnforcingIndex`, preferring a declared index over a synthesized one),
   backfill if synthesized, `tree.update()` for a LIVE read (sees same-transaction staged
   entries + committed), build the framed probe key via `createIndexKey`, `findByIndexIn`,
   skip `excludeKey` (the row's own PK on UPDATE), fetch any remaining hit via
   `collection.get(pk)`. A defensive full-scan fallback (`scanUniqueConstraint`) remains
   for the should-not-happen case of an unresolvable tree.

5. **`CREATE UNIQUE INDEX` enforcement fix (in `addIndex`).** Quereus builds the derived
   `uniqueConstraint` on a NEW `TableSchema` it swaps into its catalog
   (`appendIndexToTableSchema` → `addTable`), but the cached vtab keeps its ORIGINAL
   `this.tableSchema` reference, so the derived constraint never reached the probe. We now
   mirror the derived constraint onto `this.tableSchema.uniqueConstraints` in `addIndex`
   when the index is unique, so the probe enforces it through the index tree that
   `CREATE INDEX` just built. **This is a behavior change** — it makes the vtab actually
   enforce `CREATE UNIQUE INDEX` duplicates, which the pre-existing full-scan code did
   NOT (same stale-reference gap). Verify this is desirable and side-effect-free.

`resolveUniqueConflict` and the INSERT/UPDATE call sites are unchanged — the probe returns
the same `{ row, columns } | null` shape, so IGNORE/REPLACE/ABORT + ON CONFLICT semantics
are preserved. Only the implementation of *finding* the conflict changed.

## How to validate

Build then run the suite, streaming output:

```
cd packages/quereus-plugin-optimystic
yarn build 2>&1 | tail -3
yarn test 2>&1 | tee /tmp/opt-uniq.log | tail -40
```

Current result: **313 passing, 11 pending, 0 failing**; smoke ok; `yarn typecheck` exits 0.

### Test coverage added (a floor, not a ceiling)

In `test/secondary-unique.spec.ts` (in-memory `test` transactor):
- **bulk-insert scaling** — 300 distinct unique values inserted in one transaction, then a
  duplicate rejected. Asserts CORRECTNESS at a size painfully slow under O(N²); it is NOT
  a strict probe-count assertion (see gaps).
- **UPDATE-move** — moving a row's unique value onto another row's value is rejected;
  setting it to its own current value (self, via `excludeKey`) and to a free value are
  allowed.
- **rollback atomicity** — a rolled-back insert's unique value is free afterward (no
  orphaned index entry).
- **CREATE UNIQUE INDEX reuse** — a unique index added after CREATE TABLE rejects
  duplicates of both pre-existing and newly-inserted values, via the declared index tree.

In `test/secondary-unique-migration.spec.ts` (real `local` transactor + `FileRawStorage`):
- **pre-existing rows / migration** — build 1 writes rows to a collection with NO unique
  constraint; build 2 opens the SAME collection URI WITH the constraint (unique tree
  starts empty over a populated table) and rejects a duplicate of a pre-existing value,
  proving the one-time backfill runs.

The pre-existing `secondary-unique` (composite, nullable, in-one-transaction, or-ignore)
and `update-pk-move-uniqueness` tests all still pass unchanged.

### Suggested review probes / things to attack

- **Bulk scaling is correctness-only.** There is no assertion that the probe does a
  bounded range rather than a full scan. If you want a hard guarantee, spy on
  `Tree.range` / count full-scan (unbounded `KeyRange`) invocations during a bulk insert,
  or compare per-insert cost at two sizes. Left as a floor deliberately.
- **Same-transaction visibility** relies on `tree.update()` preserving this-transaction
  staged mutations (the established live-read pattern in `executeIndexScan`). Worth
  re-confirming the in-one-transaction test genuinely exercises the staged path.
- **`createIndexKey` framing parity** between maintenance, backfill, and probe — all three
  route through `IndexManager.createIndexKey(descriptor, row)` on the SAME descriptor, so
  they agree byte-for-byte. Confirm a composite / nullable case still frames identically.

## Known gaps & tripwires (be honest)

1. **Pure-hydrate path does not enforce plain UNIQUE (PRE-EXISTING, important).** The whole
   feature keys off `this.tableSchema.uniqueConstraints`. That is populated when a table is
   (re-)declared with local DDL (`hasLocalColumns` — the common optimystic path, since
   nodes re-CREATE tables), but `StoredTableSchema` does NOT persist unique constraints and
   `storedToTableSchema` does NOT reconstruct them, so a table reached ONLY via
   `hydrateCatalog` (no re-CREATE) has `uniqueConstraints === undefined` → **no secondary
   UNIQUE enforcement at all**. This is unchanged from the old full-scan code (identical
   dependency), but it means the CadreControl single-use `StampId` anti-replay guarantee
   can be silently absent on a pure-hydrate reopen. **Reviewer decision:** file a follow-up
   to persist `uniqueConstraints` in `StoredTableSchema` (or reconstruct them on hydrate)
   if pure-hydrate enforcement is required. Not fixed here — out of this ticket's scope
   (probe efficiency), but surfaced because it undercuts the feature's purpose.

2. **Double-maintenance tripwire** (code `NOTE:` in `resolveEnforcingIndex`). If a
   `CREATE UNIQUE INDEX` lands on columns already carrying a synthesized `_uniq_` tree,
   BOTH trees are maintained on every DML (redundant writes). Only arises from a degenerate
   DDL shape (a plain `unique(a)` plus a later `CREATE UNIQUE INDEX ON t(a)`). Probe
   correctness is preserved (declared index wins). Not filed as a ticket — conditional.

3. **All-NULL table re-scans on cold start** (code `NOTE:` in `ensureUniquePopulated`). A
   table whose unique columns are NULL in every row leaves the tree legitimately empty, so
   the (cheap, no-op-staging) backfill scan re-runs once per process start until a non-null
   row exists. Acceptable; a persisted "built" marker would remove it if it ever matters.

4. **Emptiness detection subtlety (fixed during implementation).** `Tree.isValid(path)`
   reports whether a path survived a concurrent mutation (version check), NOT whether it is
   ON an entry — an empty tree's `first()` is version-valid. The backfill empty-check uses
   `tree.at(await tree.first()) === undefined` instead. Worth a second look that this is the
   right on-entry signal everywhere it's used.

## Coordination note

The probe depends on the type-consistent, separator-safe index-key encoding
(`serializeIndexValue` + `encodeKeyTuple` / `KEY_PREFIX_END` in `key-encoding.ts`), which
had already landed before this ticket. Designed against it as current behavior.
