description: Enforcing a UNIQUE column currently re-reads every row in the table for each row you write, so a bulk insert gets quadratically slow; give UNIQUE constraints a small lookup index so each check is a fast point probe instead.
prereq: optimystic-statistics-remove
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/key-encoding.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts
difficulty: hard
----

## Problem

`checkUniqueConstraints` (`optimystic-module.ts`) enforces every declared secondary
UNIQUE constraint by scanning the **entire** main collection once per DML row and
comparing each existing row's serialized unique-key against the new row's. A bulk
insert of N rows into a UNIQUE-constrained table is therefore O(N²). The PK-uniqueness
fix (`optimystic-insert-pk-uniqueness-not-enforced`, completed) already made the
*primary key* check a point `collection.get`, but non-PK UNIQUE checking is still a
full scan.

### Why there is no index to probe today

The obvious fix — "probe the index tree with `findByIndexIn` instead of scanning" —
does not work as stated, because **most UNIQUE constraints have no backing index
tree**:

- A `CREATE UNIQUE INDEX` produces both an entry in `tableSchema.indexes` **and** a
  derived `uniqueConstraint` (`appendIndexToTableSchema` in quereus sets
  `derivedFromIndex`). Only *these* have a tree, because the optimystic vtab builds an
  index tree for each entry in `storedSchema.indexes`.
- A column-level `col unique` or table-level `unique (a, b)` produces a
  `uniqueConstraint` with **no** matching `indexes` entry and **no** tree. This is the
  common case — e.g. the CadreControl schema's single-use `StampId text unique` — and
  it is exactly what the current full scan exists to handle (see the existing
  `checkUniqueConstraints` doc comment, which acknowledges "no index backs the unique
  columns").

So the real work is: **give every point-enforceable UNIQUE constraint a backing index
tree**, maintain it in lockstep with DML, and turn the probe into a point range over
it. We call these *unique-enforcement indexes*.

## Design

### 1. Unique-enforcement indexes (IndexManager)

Introduce, alongside the declared `schema.indexes`, a second internal list of index
descriptors that exist purely to enforce UNIQUE constraints. Keep them **out of the
persisted `StoredTableSchema`** so schema round-tripping, catalog hydration,
`schemasEqual`, and `getBestAccessPlan`'s `tableInfo.indexes` are all unaffected —
they are an implementation detail of enforcement, not part of the table's declared
shape.

Add to `IndexManager`:

```
// A separate list from `schema.indexes`. Iterated ALONGSIDE schema.indexes in
// insert/delete/update/getIndexTrees so maintenance is automatic, but never
// persisted and never surfaced to the planner.
private uniqueEnforcementIndexes: StoredIndexSchema[] = [];

setUniqueEnforcementIndexes(list: StoredIndexSchema[]): void
getAllMaintainedIndexes(): StoredIndexSchema[]   // schema.indexes ++ uniqueEnforcementIndexes
```

Change the maintenance loops (`insertIndexEntries`, `deleteIndexEntries`,
`updateIndexEntries`) and `getIndexTrees()` to iterate `getAllMaintainedIndexes()` /
include the unique-enforcement trees. **Do not** fold them into `schema.indexes`: a
later `CREATE INDEX` calls `IndexManager.setSchema(...)` with a schema rebuilt from the
persisted (unique-index-free) `StoredTableSchema`, which would silently drop them.
Keeping them in a separate list survives `setSchema`.

Tree keys and probe key use the **same** framing already in use — `createIndexKey` =
`encodeKeyTuple(cols.map(serializeIndexValue))` — so a unique-enforcement index keys a
row identically to how the module's `uniqueKeyFor` builds the probe key. This is what
makes the type-sensitivity / separator-escaping work already landed in
`serializeIndexValue` + `encodeKeyTuple` (`key-encoding.ts`) carry over correctly.

### 2. Which constraints get a unique-enforcement index (module, doInitialize)

After `indexManager.initialize(...)`, compute the enforcement set from
`this.tableSchema.uniqueConstraints`:

- **Skip** partial constraints (`predicate !== undefined`) — unchanged from today;
  the current probe already filters these out and does not enforce them.
- **Reuse, do not duplicate:** if a constraint's `columns` exactly match the PRIMARY
  KEY, it is already structurally enforced (tree key) — skip. If they exactly match an
  existing declared index (`storedSchema.indexes`) — including a `derivedFromIndex`
  UNIQUE index — reuse that tree; do not synthesize a second one.
- **Otherwise synthesize** a unique-enforcement index descriptor:
  - deterministic reserved name, e.g. `_uniq_<sorted-column-indices>` (must be stable
    across restarts so the same tree URI resolves; must not collide with a
    user-index name — reserve the `_uniq_` prefix),
  - `columns` = the constraint's columns (preserve declared order),
  - its tree opened via the same factory the declared indexes use
    (`<collectionUri>/index/<name>`).

Register the synthesized trees with `IndexManager.setUniqueEnforcementIndexes(...)`
and with the transaction bridge (`registerCollections()` already iterates
`getIndexTrees()`, so once the unique trees are included there this is automatic —
verify the ordering: they must be present before `registerCollections()` runs).

### 3. One-time population for pre-existing rows (correctness-critical)

A table **created** under this code maintains its unique-enforcement index from the
first insert (the insert path stages into every maintained index), so it is always in
sync. The danger is a table that **already has rows** written by an older build that
never maintained such an index: its unique tree is empty while the main table is
populated, so a probe would find no collision and **silently admit a duplicate**.

Handle this with a one-time lazy build, mirroring `addIndex`'s populate loop:

- Before the first probe (or during init) for each synthesized unique index, if its
  tree is empty **and** the main collection is non-empty, scan the main table once,
  stage each row's entry into the unique tree, then `tree.sync()` it — exactly as
  `addIndex` does after a `CREATE INDEX`. This is a single O(rows) cost per table
  lifetime, not per row.
- **Do the population against the unique index tree in isolation** (stage into that
  tree + `sync()` only), never touching the caller's staged main-table mutations. This
  matches `addIndex`, which stages into the index tree and syncs it even though DML may
  be in flight. Do **not** route population through the shared `markDirtyTrees()` /
  commit path.
- `NOTE:` a table whose unique column is NULL in every row leaves the tree legitimately
  empty, so the "empty tree" guard re-runs the (cheap, no-op-staging) scan on each cold
  start. Acceptable; leave a `NOTE:` at the guard so a future reader can add a
  persisted "built" marker if it ever matters.

### 4. The probe itself (checkUniqueConstraints)

Replace the full scan with, per active constraint:

- resolve the tree that enforces it (the reused declared index tree, or the synthesized
  unique tree),
- refresh it (`await tree.update()`) for a LIVE read — the probe must see rows staged
  earlier in THIS transaction plus committed rows, preserving the immediate
  same-transaction semantics the PK fix established (it does **not** read the committed
  snapshot),
- build the framed probe key `encodeKeyTuple(cols.map(serializeIndexValue))` and call
  `indexManager.findByIndexIn(tree, key)`,
- for each primary key returned, skip `excludeKey` (the row being updated, so it does
  not conflict with itself); any remaining hit is a violation — fetch that row via
  `collection.get(pk)` and return `{ row, columns }`.

`findByIndexIn` yields the primary key(s) whose framed index tuple equals the probe key
(range `[key, key + KEY_PREFIX_END)`), so this is ~O(log n) per constraint per row.
Keep the same NULL / partial / all-columns-present filtering the current `active`
computation does (a row is exempt from a constraint when any of its columns is NULL).

Keep a defensive fallback: if a constraint somehow has no resolvable enforcing tree,
fall back to the current full scan for that constraint (should not happen; log it).

### 5. Interaction with ON CONFLICT

`resolveUniqueConflict` and the INSERT/UPDATE call sites are unchanged — the probe
returns the same `{ row, columns } | null` shape it does today, so IGNORE/REPLACE/
ABORT semantics (and consistency with `optimystic-vtab-onconflict-not-honored`) are
preserved. Only the *implementation* of finding the conflict changes.

## Edge cases & interactions

- **Bulk insert of N rows into a UNIQUE column** — assert probes are point range scans,
  not N full scans. A test may spy on `collection.range` full-scan invocations vs
  `findByIndexIn`, or assert timing/scaling; at minimum assert correctness at a size
  (e.g. 200 rows) that would be painfully slow under O(N²).
- **Duplicate detected against a row staged earlier in the same transaction** — the
  existing `secondary-unique.spec.ts` "rejects two rows sharing a unique value staged
  in ONE transaction" test must still pass with the index-backed probe (the unique tree
  sees same-transaction staged entries after `update()`).
- **Multi-column UNIQUE `(a, b)`** — same (a,b) rejected, same-a/different-b allowed
  (existing composite test); the synthesized index's framed multi-column key must make
  `('x','y')` and `('x','z')` distinct and `('x', null)` exempt.
- **Nullable UNIQUE** — multiple NULLs coexist, duplicate non-nulls rejected (existing
  test). Confirm the null-exemption filter runs before the probe, so a NULL-bearing row
  never probes.
- **UPDATE that moves a row's unique value** — `excludeKey` must exclude the row's own
  entry so an unchanged unique value does not self-collide; a change onto another row's
  value must collide.
- **UNIQUE derived from `CREATE UNIQUE INDEX`** — must be enforced via the *existing*
  declared index tree (no duplicate synthesized tree), and still rejects duplicates.
- **Rollback atomicity** — a rejected insert/update must leave no orphaned
  unique-index entries. The synthesized trees are in `getIndexTrees()`, so
  `markDirtyTrees()` snapshots them pre-stage and the bridge restores them on rollback,
  same as declared indexes. Verify a rejected duplicate inside a transaction, followed
  by rollback, leaves the unique tree consistent.
- **Migration / pre-existing rows** — a table populated by an older build must not
  admit a duplicate after upgrade: the one-time population (section 3) must build the
  unique tree from existing rows before the first probe trusts it. Add a test that
  seeds the main collection directly (or via a first process/build) and then asserts a
  duplicate is rejected on a fresh table instance whose unique tree started empty.
- **`addIndex` after init** — a later `CREATE INDEX` calls `setSchema`; confirm the
  unique-enforcement list survives it (separate list, not folded into `schema.indexes`)
  and that `addIndex`'s `getIndexTrees()` sync loop tolerates the extra unique trees.
- **CREATE UNIQUE INDEX whose columns match an already-synthesized plain UNIQUE** — if
  the same columns are later given a real UNIQUE index, avoid maintaining two trees for
  the same key; document the chosen behaviour (prefer the declared index, drop/ignore
  the synthesized one) and cover it, or explicitly note it as unsupported if it cannot
  arise from the DDL surface.

## Coordination (not blocking)

The probe reads framed index tuples, so it depends on the index-key encoding being
type-consistent and separator-safe. Those fixes have **already landed** in
`serializeIndexValue` (bigint/number unify onto `toExponential(15)`) and
`encodeKeyTuple` / `KEY_PREFIX_END` (`key-encoding.ts`). Design against them as the
current behaviour; if a regression surfaces there, it is that subsystem's bug, not
this ticket's.

## TODO

- `IndexManager`: add the `uniqueEnforcementIndexes` list, `setUniqueEnforcementIndexes`,
  `getAllMaintainedIndexes`, and route insert/delete/update maintenance +
  `getIndexTrees()` through it.
- `optimystic-module.ts` `doInitialize`: compute the enforcement set from
  `uniqueConstraints` (skip partial / PK-covered / already-indexed), synthesize trees
  for the rest, register them with IndexManager and the bridge (before
  `registerCollections`).
- Implement the one-time lazy population (mirror `addIndex`), isolated to the unique
  tree, guarded by "tree empty && main non-empty", with the all-null `NOTE:`.
- Rewrite `checkUniqueConstraints` to probe via `findByIndexIn` per active constraint,
  keeping the null/partial/exclude-key filtering and a defensive scan fallback.
- Extend `test/secondary-unique.spec.ts` with: bulk-insert scaling/probe assertion,
  multi-column, nullable, UPDATE-move, CREATE-UNIQUE-INDEX reuse, rollback-atomicity,
  and pre-existing-rows migration cases.
- Build the package and run the optimystic test suite streaming output
  (`yarn ... 2>&1 | tee /tmp/opt-uniq.log`). All existing `secondary-unique` and
  `update-pk-move-uniqueness` tests must still pass.
