----
description: When a connection reconnects to an index it had been ignoring, rows it wrote while ignoring the index stay missing from that index forever — lookups by that column never find them, and nothing reports an error. Fill in the missing entries when the connection reconnects.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/index-maintenance-invariant.spec.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts
repro: verified
difficulty: medium
----

# Backfill index entries when reconciliation re-attaches a secondary index

## Confirmed reproduction

Driven to a failing test during the fix stage (scratch spec, not committed — recipe below is
exactly what was run, using the helpers already in `test/index-maintenance-invariant.spec.ts`:
`buildSharedLocalTransactor`, `registerWithSharedTransactor`, `countTreeEntries`, `collectRows`).

Two `Database` instances, A and B, over one `MemoryRawStorage` via a shared `local` transactor:

```
await dbA.exec(ddl);                                   // A declares the table, no index yet
await dbA.exec(`insert into backfill values (1, 'tok-a')`);
await dbB.exec(ddl);
await dbB.exec(`create index backfill_by_token on backfill(token)`);  // B builds + populates
await dbA.exec(`insert into backfill values (2, 'tok-b')`);           // A still detached
await pluginA.hydrate(dbA);
await dbA.exec(`create index backfill_by_token on backfill(token)`);  // A reconciles
select id from backfill where token = 'tok-b'                          // -> [] on BOTH A and B
```

Observed on `main` at `da9d02a`:

```
after A detached insert, index entries = 1
after A re-declare,      index entries = 1     <- backfill never happened
A index seek for tok-b = []
B index seek for tok-b = []
A full scan = [{"id":1,"token":"tok-a"},{"id":2,"token":"tok-b"}]     <- row 2 exists
```

The row is committed and visible to a full scan; the index-driven seek misses it forever, on
both connections, with no error. That is the same user-visible symptom as the original report
`fix/secondary-index-update-never-reaches-the-sibling`.

## Root cause — one site

`OptimysticVirtualTable.reconcileMaintainedIndexes`
(`packages/quereus-plugin-optimystic/src/optimystic-module.ts`, ~line 2133) attaches an index
to this connection's `IndexManager` — folds the descriptor in, opens the tree, registers the
collection with the transaction bridge — and stops. It never adds index entries for rows this
connection committed while it was detached from that index. The first-time build path in
`addIndex` does the same three wiring steps and then walks every existing row; reconciliation
performs the first three and stops.

The stale `NOTE:` block directly above `reconcileMaintainedIndexes` (lines ~2123–2131)
documents this gap and points at this ticket — it must be rewritten, not left behind.

## Decision: backfill

Of the three options the fix ticket weighed (backfill / refuse to attach / attach-and-warn),
**backfill** is the one that restores the invariant "every committed row has an entry in every
index the table declares". The other two only change how visible the violation is.

Backfill was prototyped and validated during the fix stage:

- the repro above flips to `index entries = 2` and both connections' seeks return `[{"id":2}]`;
- the full `quereus-plugin-optimystic` suite stayed green — **464 passing, 0 failing**
  (`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"`), with
  the prototype *also* replacing `addIndex`'s own populate loop (see below).

The prototype was reverted; the working tree is unchanged. Rebuild `dist/` before running the
specs — they import `../dist/plugin.js`.

## Validated shape

Two changes in `optimystic-module.ts`:

**1. `reconcileMaintainedIndexes` reports what it attached.** Compute the newly-attached set
*before* mutating anything (an index is newly attached when the manager has no descriptor for
it **or** no registered tree for it), and return those names:

```ts
private async reconcileMaintainedIndexes(
  storedSchema: StoredTableSchema,
  transactor?: ITransactor
): Promise<string[]> {
  ...
  const attached = storedSchema.indexes
    .filter(idx => manager.getIndexSchema(idx.name) === undefined
                || manager.getIndexTree(idx.name) === undefined)
    .map(idx => idx.name);
  ... // existing setSchema / openIndexTree / registerCollection loop, unchanged
  return attached;
}
```

A warm re-declare with nothing missing returns `[]`, so the common path stays a map lookup per
index and pays no scan.

**2. A single-index populate helper, modelled on `ensureUniquePopulated`** (same file, ~line
1273 — the existing precedent for "stage into one index tree in isolation, sync only that tree,
never touch the caller's staged main-table mutations"):

```ts
private async backfillIndexTrees(indexNames: string[]): Promise<void>
```

which resolves each name to `{descriptor, tree}` via the manager, refreshes `this.collection`,
walks it once, and for each row stages `createIndexKey(descriptor, row) + pk -> [treeKey, pk]`
into **only** those trees, then syncs **only** those trees. Idempotent by construction: keys
are `indexColumns‖primaryKey`, so re-staging an existing entry writes an identical key and
value.

Call it from both `addIndex` sites, using the names reconcile returned:

- the already-persisted early-return branch, *after* the `effective !== storedSchema`
  `setSchema` — this is the arm that fixes the bug;
- the build branch, replacing the existing `insertIndexEntries` populate loop and its
  `for (const tree of getIndexTrees()) await tree.sync()` flush entirely. Reconcile reports the
  brand-new index as attached (the manager has no descriptor for it yet), so one populate site
  serves both paths. This was the shape the green suite ran under.

Folding the build path onto the same helper also retires the "write volume is rows × indexes"
`NOTE:` on the old loop — the helper stages per-index, so that note becomes false and must be
deleted rather than carried over.

### Comments that must survive or change

- **Delete** the rows × indexes volume `NOTE:` above the old populate loop (no longer true).
- **Keep** the `CREATE UNIQUE INDEX does not reject pre-existing duplicate values` `NOTE:` —
  still true under the new helper, and it belongs wherever the populate now lives.
- **Rewrite** the `reconciliation does NOT backfill` `NOTE:` above `reconcileMaintainedIndexes`
  to state what it now does, and to record the cost (one table scan per re-declare that
  actually attaches something; no scan otherwise).
- Two behaviours differ from the old loop and are worth one line each at the site:
  `backfillIndexTrees` calls `this.collection.update()` first (the old loop did not — matching
  `ensureUniquePopulated` widens coverage to rows a sibling committed), and it syncs only the
  trees it populated rather than every index tree.

## Known limits to state, not to fix here

- `CREATE INDEX` inside an open transaction still force-flushes the trees it populates. This
  caveat exists today on the build path and `ensureUniquePopulated` does the same mid-DML; the
  new helper narrows it (it syncs only newly-attached trees, into which the caller cannot yet
  have staged anything, because they were attached microseconds earlier). Carry the caveat
  forward in the comment; do not try to solve it in this ticket.
- Backfill runs only on a `CREATE INDEX` re-declare that attaches something. A connection that
  opens the table cold and finds the index already in the persisted schema does **not** scan,
  so rows orphaned by some *other* divergent writer stay orphaned until someone re-declares.
  Making every table open pay an O(rows) verification scan is the wrong trade. Record this as a
  `NOTE:` tripwire at the reconcile site rather than filing it.
- Partial indexes (`predicate`) are not honoured by any populate path, old or new —
  `insertIndexEntries` ignores `predicate` too, so backfill matches live DML behaviour. Out of
  scope; do not change it here.

## Coverage: one generalized invariant, not one more bespoke spec

The class is "an index tree that does not account for every committed row", and this is its
second instance. Add a shared assertion to `test/query-helpers.ts`:

```ts
/** Assert an index-routed lookup on `column` returns exactly what a full scan returns. */
export async function expectIndexAgreesWithScan(
  db: Database, table: string, column: string
): Promise<void>
```

It reads every row via a full scan (`select * from <table>`), groups the primary keys by the
value in `column`, then for each distinct value runs the predicate form (`where <column> = ?`)
that the planner routes into the index, and asserts the two row sets match — including for
`null`, where the scan-side expectation is whatever `where <column> is null` should return.
It must fail loudly if the value-form query does not actually go through the index (otherwise a
full-scan fallback would make it vacuous); `test/read-pull-mechanism.spec.ts` shows how plan
selection is observed (`idxStr`/`indexScan` counters) — reuse that mechanism rather than
inventing a second one.

Call it at the end of the index specs listed in `files:`.

## Expected behaviour

After any interleaving of table declaration, index declaration and writes across connections
sharing one collection, a lookup routed through a secondary index returns exactly the rows a
full scan with the same predicate returns.

## TODO

### Phase 1 — the fix

- Change `reconcileMaintainedIndexes` to compute the newly-attached index names before it
  mutates the manager, and return them.
- Add `backfillIndexTrees(indexNames)` next to `ensureUniquePopulated`, sharing its
  stage-then-sync-in-isolation pattern; keep it a no-op for an empty list.
- Call it from the early-return branch of `addIndex` after the `setSchema` fold.
- Replace the build branch's `insertIndexEntries` populate loop and blanket tree flush with the
  same helper.
- Rewrite / delete / keep the three comment blocks called out above; add the "cold open does
  not verify" tripwire `NOTE:` at the reconcile site.

### Phase 2 — coverage

- Add `expectIndexAgreesWithScan` to `test/query-helpers.ts`, with the plan-routing check so it
  cannot pass vacuously via a full scan.
- Add the reattach case to `test/index-maintenance-invariant.spec.ts` — the exact recipe under
  "Confirmed reproduction", asserting both the index entry count (2) and the seek result on
  both connections.
- Call `expectIndexAgreesWithScan` at the end of `index-maintenance-invariant`,
  `two-node-secondary-index-convergence`, `index-support` and `secondary-unique`.

### Validation

- `yarn build` in `packages/quereus-plugin-optimystic` (the specs import `dist/`), then
  `yarn test` in that package — streamed, e.g. `yarn test 2>&1 | tee /tmp/plugin-test.log`.
  Baseline before this ticket: 464 passing / 11 pending with the scratch repro included, i.e.
  463 in the committed suite.
- `yarn typecheck` from the repo root (after `yarn build`).
