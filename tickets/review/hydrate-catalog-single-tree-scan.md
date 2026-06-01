description: Implemented — `SchemaManager.listTables` now seeds the per-instance `schemaCache` from the single `range()` traversal it already performs, so `hydrateCatalog`'s follow-up `getSchema(name)` calls hit memory instead of re-walking the schema btree. Collapses `1 listTables + N getSchema = N+1` full tree scans to 1. Unit-proven 4→1 for N=3; the ~10.3s→~1s emulator gain is projected, not measured here (see gaps).
prereq:
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
----

## What changed

Single-file behavioral change in `SchemaManager.listTables` (`schema-manager.ts:149-170`).
`listTables` already walks the **entire** schema btree via `tree.range()` and has each
`StoredTableSchema` in hand as `entry[1]` — but it previously pushed only `entry[0]` (the
name) and never populated `schemaCache`. So every `getSchema(name)` call that follows in
`OptimysticModule.hydrateCatalog` (`optimystic-module.ts:1001-1017`) missed the cache
(`schema-manager.ts:102`), re-ran `getSchemaTree()` + `await tree.update()`, and re-walked the
tree from the root — re-reading the same blocks from storage N more times.

The fix seeds the cache during that one pass:

```ts
const entry = tree.at(path) as [string, StoredTableSchema];
if (entry && entry.length >= 2 && entry[1]) {
    this.schemaCache.set(entry[0], entry[1]);   // seed; getSchema now hits memory
}
if (entry && entry.length >= 1) {
    tables.push(entry[0]);
}
```

After this, the N `getSchema` calls in `hydrateCatalog` return from `schemaCache` (line 102)
and never touch the tree → **N+1 tree scans collapse to 1**. The seeded value is the exact same
`entry[1]` shape (`StoredTableSchema`, from the `[name, stored]` tuple) that `getSchema` itself
caches and returns at `schema-manager.ts:118-121`, so hydrated tables land byte-identical to the
pre-fix path. Tombstones are skipped (`entry[1]` falsy) so a `replace([[name, undefined]])`
delete is never registered as a cache hit.

This also accelerates the runtime per-table read path (`optimystic-module.ts:164/196/669`),
which calls `getSchema` at table-connect / addIndex time — the cache-seeding benefits any caller
that reads after a `listTables`, not just hydrate.

I chose the **cache-seeding** primary approach over the alternative (rewriting `hydrateCatalog`
to build `TableSchema`s directly from the single `listTables` pass), per the ticket's stated
preference: seeding is one localized line and also helps the runtime read path, whereas a local
rewrite would only fix hydrate.

## Cache-coherence audit (the required TODO)

Traced every write path that touches the schema tree (`tree://optimystic/schema`, whose entries
are the `StoredTableSchema` values the cache holds). All keep `schemaCache` coherent with the
seeded entries:

| Write path | File:line | Cache handling |
|---|---|---|
| `storeStoredSchema` | schema-manager.ts:84-95 | `schemaCache.set(stored.name, stored)` **before** `tree.replace`. Coherent. |
| `storeSchema` | schema-manager.ts:74-76 | delegates to `storeStoredSchema`. Coherent. |
| `deleteSchema` | schema-manager.ts:131-136 | `schemaCache.delete(tableName)` **before** `tree.replace([[name, undefined]])`. Coherent. |
| `addIndex` | optimystic-module.ts:659-735 | reads via `getSchema`, re-persists via `storeSchema` → routes through `storeStoredSchema` → updates cache. Coherent. |

`index-manager.ts` writes (lines 105/126/155) target **separate** `tree://.../index/{name}` trees
— they do not carry `StoredTableSchema` and never touch the schema cache. Irrelevant to coherence.

**Conclusion:** no write path mutates the schema tree without updating/invalidating `schemaCache`.
Seeding is safe. (Note: the ticket called the delete method `removeSchema`; the actual method is
`deleteSchema` — same behavior, it invalidates the one cache entry.)

### Staleness note for the reviewer (honest framing)

Seeding makes `listTables` populate the cache exactly the way a `getSchema` cache-miss would have
at that same instant — same committed tree view, same value. After seeding, a later `getSchema`
returns the seeded value rather than re-reading the tree. This is **identical to the pre-existing
per-entry cache semantics**: once `getSchema` caches a value it never re-reads either, and any
write going through *this same SchemaManager* updates the cache. A write made through a *different*
SchemaManager instance (or externally) wouldn't be observed — but that was already true before this
change. So no new coherence hazard is introduced; the only behavioral delta is timing (1 scan vs
N+1). Worth a second look from the reviewer, but I believe the premise holds.

## Validation performed

All commands run in `packages/quereus-plugin-optimystic`:

- **`npm run build`** (tsup) — success.
- **`npm run typecheck`** (tsc --noEmit) — clean, no errors. (The cast widened from
  `[string, any]` to `[string, StoredTableSchema]`; `StoredTableSchema` is already imported/defined
  in this file.)
- **`npm test`** (mocha, full suite incl. the 3-node libp2p mesh integration) — **190 passing,
  4 pending**, no failures.
- **Focused:** `catalog-hydration.spec.ts` + `schema-migration.spec.ts` — **20 passing**. These are
  the two suites the ticket named as the correctness regression guard (hydrated tables/indexes
  still complete; seeded value equals what `getSchema` would have fetched).

### New test + before/after proof

Added `catalog-hydration.spec.ts > "hydrateCatalog walks the schema tree once regardless of table
count"`:

1. Session A persists **three** tables (`users`, `orders`, `products`) via the shared local
   transactor.
2. Session B (fresh `Database` + plugin, shared storage) wraps `collectionFactory
   .createOrGetCollection` to spy on `tree.update()` for the `tree://optimystic/schema` tree only,
   counting full traversals. (`createOrGetCollection` caches collections only inside an active
   transaction — outside one, each un-cached `getSchema` opens its own schema tree and calls
   `update()`, so wrapping every schema tree returned counts them all.)
3. `pluginB.hydrate(dbB)` runs; asserts `result.tables === 3` and **`schemaTreeUpdateCalls === 1`**.
4. Also asserts all three tables land in the catalog with their correct columns — proving the
   seeded-cache values produce a complete hydration, not just a fast one.

**Verified the test is a genuine guard:** temporarily disabled the seed line, rebuilt, and the new
test failed asserting **actual `4`** (1 `listTables` + 3 `getSchema`) vs expected `1` — exactly the
ticket's predicted pre-fix count. Restored the fix; rebuilt; green again. So the test fails without
the change and passes with it.

## Known gaps / what the reviewer should treat as a floor

- **End-to-end emulator timing not captured.** The ticket's final validation step (rebuild plugin,
  relaunch the `sereus-health` emulator, capture logcat, read `[strandDb] hydrate: %dms`, expect
  ~1s down from 10,322ms) is **not runnable in this environment** — `sereus-health` is a separate
  Android/emulator project, not part of this optimystic monorepo (confirmed: no `sereus-health`
  path in the repo). The **~10.3s → ~1s wall-clock claim is therefore projected** from the
  unit-level scan-count reduction (N+1 → 1, i.e. 10 → 1 for the captured 9-table workload), **not
  measured here.** A human/CI with the emulator should capture the real before/after `[strandDb]
  hydrate` line and the per-block LevelDB read counts (expect ~1× each instead of 10×) to close the
  loop. This is the single biggest unverified assertion in the ticket.
- **Scan-count is proven; per-scan cost is assumed linear.** The unit test proves the traversal
  count drops from N+1 to 1. The wall-clock win assumes each avoided traversal was re-reading the
  same ~18 blocks at ~15-35ms sequential (per the captured perf log). That model is the ticket's,
  not independently re-measured here.
- **Test counts traversals via an `update()` spy, not block reads.** It proves "the tree is walked
  once," which is the proximate cause. It does not directly assert "each LevelDB block is read
  once" — that lower-level claim is left to the emulator capture above.
- **Out-of-scope items left untouched** (as the ticket directed): the db-core block cache eviction
  between scans (19→1) is mooted for the hydrate path by this fix; sequential single-block LevelDB
  reads (batching) remain a separate db-p2p storage-repo concern. Neither was changed; no new
  ticket filed for them (the ticket said file one only if a later measurement shows cross-phase
  cache thrash still matters).

## Suggested review focus

- Confirm the staleness framing above — is there any same-process path that writes the schema tree
  through a *different* `SchemaManager` instance while a hydrated one is live? (My audit says no in
  current usage — `createSchemaManager` memoizes one per fingerprint and `tree://optimystic/schema`
  is the single shared URI — but it's the assumption most worth a second pair of eyes.)
- Sanity-check the new test's `createOrGetCollection` spy: it relies on the schema tree NOT being
  transaction-cached during hydrate (hydrate passes no transactor). If that ever changes, the spy
  would under-count; the 4→1 manual verification above guards against a silently-passing test today.
