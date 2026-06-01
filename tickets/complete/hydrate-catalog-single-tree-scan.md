description: COMPLETE — `SchemaManager.listTables` now seeds the per-instance `schemaCache` from the single `range()` traversal it already performs, so `hydrateCatalog`'s follow-up `getSchema(name)` calls hit memory instead of re-walking the schema btree. Collapses `1 listTables + N getSchema = N+1` full tree scans to 1. Reviewed, validated, and independently guard-verified (4→1 for N=3).
prereq:
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
----

## Summary of work

Single-line behavioral change in `SchemaManager.listTables` (`schema-manager.ts:163-165`):
the loop that already walks the **entire** schema btree via `tree.range()` now seeds
`schemaCache` from each `entry[1]` (`StoredTableSchema`) it has in hand. The N `getSchema(name)`
calls that `OptimysticModule.hydrateCatalog` (`optimystic-module.ts:1001-1017`) issues afterward
now hit the cache (`schema-manager.ts:102`) instead of each re-running `getSchemaTree()` +
`tree.update()` and re-walking the tree from the root.

Net effect: `N+1` full tree scans → `1`. The seeded value is the byte-identical
`StoredTableSchema` shape that `getSchema` itself caches and returns, so hydrated tables are
unchanged. The shared (memoized) `SchemaManager` means the per-table runtime read path
(`optimystic-module.ts:164/196/669`) also benefits from the seeded cache.

A regression test was added — `catalog-hydration.spec.ts > "hydrateCatalog walks the schema tree
once regardless of table count"` — which persists 3 tables in session A, then in a fresh session B
spies on `tree.update()` for the `tree://optimystic/schema` tree during `hydrate()` and asserts
exactly **1** traversal (was 4) plus full column-shape completeness of all 3 hydrated tables.

## Review findings

**Scope reviewed:** the implement-stage diff (`7f9d0b4`) touching `schema-manager.ts` and
`catalog-hydration.spec.ts`, the consuming `hydrateCatalog` / `doInitialize` / `addIndex` call
sites in `optimystic-module.ts`, the schema-tree write paths, the tree `replace`/`range`/delete
semantics in `db-core`, and the surrounding docs.

### Correctness — no issues found
- **Seed value fidelity:** `schemaCache.set(entry[0], entry[1])` stores the same object reference
  and shape (`[name, StoredTableSchema]` → `StoredTableSchema`) that a `getSchema` cache-miss
  would have cached at the same committed tree view. Hydration output is identical to the pre-fix
  path. ✓
- **Tombstone guard is sound (and, in fact, never exercised):** traced `deleteSchema` →
  `tree.replace([[name, undefined]])` → `tree.ts:31` `btree.deleteAt(find(key))`. Deletes
  **physically remove** the entry, so `range()` never yields a tombstone with `entry[1] ===
  undefined`. The `&& entry[1]` guard is therefore harmless defensiveness, not load-bearing.
  (Note: the pre-existing `tables.push(entry[0])` would surface a deleted name *if* tombstones ever
  appeared in `range()`, but they don't — and that line predates this change. Not a regression.)
- **Cache coherence audited across every schema-tree writer:** `storeStoredSchema` (sets cache
  before write), `storeSchema` (delegates), `deleteSchema` (deletes cache before write), and
  `addIndex` (re-persists through `storeStoredSchema`) all keep `schemaCache` coherent.
  `index-manager.ts` writes target separate `tree://.../index/{name}` trees and never touch the
  schema cache. ✓
- **No reference-mutation/aliasing hazard:** `addIndex` (`optimystic-module.ts:679-689`) builds a
  shallow copy `{...storedSchema, indexes: [...]}` and never mutates the cached object in place.
  The seed introduces no aliasing risk beyond what `getSchema`'s existing by-reference cache
  already had. ✓
- **Staleness:** seeding inherits the exact pre-existing per-entry cache semantics — once a value
  is cached (by `getSchema` today, or by the seed now) it isn't re-read; writes through *this*
  `SchemaManager` keep it fresh; cross-instance/external writes were already unobserved before this
  change. `createSchemaManager` memoizes one manager per fingerprint over the single shared
  `tree://optimystic/schema` URI, so no same-process second instance races a live hydrated one.
  No new coherence hazard. The only behavioral delta is timing. ✓ (Minor, accepted: tables already
  present in the target catalog — skipped by `hydrate`'s `getTable(...) continue` before `getSchema`
  — are now seeded into the cache during `listTables` where pre-fix they weren't. Bounded to the
  hydrate moment and subject to the same staleness semantics as any cached entry; benign.)

### Tests — verified as a genuine guard, not a tautology
- Ran the focused `catalog-hydration.spec.ts`: **5 passing**, including the new test.
- **Independently confirmed the test fails without the fix:** disabled the seed line, rebuilt, and
  the new test failed asserting **actual `4`** (1 `listTables` + 3 `getSchema`) vs expected `1` —
  matching the ticket's predicted pre-fix count. Restored the line; rebuilt; green again. The test
  genuinely guards the behavior.
- Coverage spans happy path (existing hydrate test), the scan-count regression + completeness (new
  test), and cold-start empty storage (existing). Delete/tombstone paths need no new test because
  they cannot reach the seeding branch (deletes physically remove entries).

### Build / typecheck / full suite — pass
- `npm run build` (tsup): success. `npm run typecheck` (tsc --noEmit): clean.
- `npm test` (full mocha suite incl. the 3-node libp2p mesh integration): **190 passing, 4 pending,
  0 failing** — matches the handoff.

### Docs — checked, no updates needed
- No markdown/docs in the package reference `schemaCache` / `listTables` / `hydrateCatalog`. The
  inline doc comments added in `schema-manager.ts:155-162` accurately describe the new seeding
  behavior. No stale documentation.

### Lint
- No lint is configured for this package; the repo-root `lint` script is a no-op echo
  (`package.json:40`). Nothing to run.

### Major findings → new tickets
- **None.** No major issues warranting a fix/plan/backlog ticket were found.

### Accepted gaps (carried from implement, appropriately out-of-band)
- **End-to-end emulator timing not captured.** The ticket's projected ~10.3s→~1s wall-clock gain is
  inferred from the unit-level scan-count reduction (N+1→1), not measured — `sereus-health` is a
  separate Android/emulator project not present in this monorepo (confirmed). A human/CI with the
  emulator should capture the real before/after `[strandDb] hydrate: %dms` line to close the loop.
  This is the single largest unverified assertion and is correctly deferred; it is not actionable
  inside this repo.
- **Per-block LevelDB read-count claim** ("each block read 1× instead of 10×") is the proximate
  model behind the wall-clock projection; the unit test proves traversal count (via an `update()`
  spy), not block-read count. Left to the emulator capture above.
- Out-of-scope db-core block-cache eviction and db-p2p sequential single-block read batching were
  intentionally untouched; no ticket filed (per the original ticket's guidance to file one only if
  a later measurement shows cross-phase cache thrash still matters).

## Disposition
Implementation is correct, well-tested, and coherent. Merged as-is — no inline fixes were required
and no follow-up tickets were filed. The only open item is the human/CI emulator timing capture,
which cannot run in this environment.
