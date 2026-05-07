description: Realigned IndexManager static types with the runtime tuple shape
files:
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
----

## What was built

`IndexManager`'s declared tree entry type had drifted from its runtime shape:
- The type said `Tree<IndexKey, PrimaryKey>` (entry = bare `string`)
- The runtime stored `[treeKey, primaryKey]` tuples so the tree's `keyExtractor` (`entry[0]`) returns the composite tree key needed for sort/range-scan correctness with non-unique indexes

`yarn tsc --noEmit` flagged two assignment errors at `index-manager.ts:105` and `:157`. The factory closures in `optimystic-module.ts` were papering over the same mismatch with `as unknown as Tree<string, string>`.

### Changes

`packages/quereus-plugin-optimystic/src/schema/index-manager.ts`
- New `IndexEntry = [IndexKey, PrimaryKey]` type
- `IndexTreeFactory` returns `Promise<Tree<IndexKey, IndexEntry>>`
- `indexTrees` map → `Map<string, Tree<IndexKey, IndexEntry>>`
- `getIndexTree()` returns `Tree<IndexKey, IndexEntry> | undefined`
- `findByIndex()` and `scanIndexRange()`: dropped the defensive bare-string fallback (entries are always tuples at runtime); read paths now simply `yield entry[1]`

`packages/quereus-plugin-optimystic/src/optimystic-module.ts`
- Imports `IndexEntry` alongside `IndexManager`
- The two factory closures (init at ~line 184 and `addIndex` at ~line 654) cast to `Tree<string, IndexEntry>` instead of `Tree<string, string>`

### Why the casts remain

`CollectionFactory.createOrGetCollection` is hard-coded to `Promise<Tree<string, RowData>>` (`RowData = [string, string]`). Threading a type parameter through it, `Tree.createOrOpen`, the keyExtractor, and the `TransactionState.collections` cache would touch every call site — not a trivial change, so the casts are kept in place. Structurally `RowData` and `IndexEntry` are both `[string, string]`, so the cast is a type-level adjustment only.

## Validation

- `yarn tsc --noEmit` in `packages/quereus-plugin-optimystic`: both originally-flagged errors at `index-manager.ts:105` and `:157` are resolved. The pre-existing `manual-mesh-test.ts` `PeerId` cross-package type mismatch remains and is not part of this ticket.
- `yarn build` (tsup ESM + DTS): succeeds.
- Full plugin test run: **185 passing, 4 pending**. The `test/index-support.spec.ts` suite (16 tests) is fully green — covers single/multi-column indexes, unique indexes, equality and range queries, INSERT/UPDATE/DELETE maintenance, populating an index from pre-existing rows via `addIndex` (exercises the closure with the second cast), ORDER BY with index, NULLs/empty strings, and duplicate values in non-unique indexes.

## Review notes

- **String-fallback removal safety (verified)**: A grep across the package shows every index-tree write goes through `IndexManager.{insert,update,delete}IndexEntries`, all of which write the `[treeKey, primaryKey]` tuple. No call path produces a bare-string entry, so removing the fallback is sound.
- **Plumbing entry type through `CollectionFactory` (not done)**: Out of scope per the ticket — would require generic-izing `createOrGetCollection`, the keyExtractor, and the txnState collections cache. The two `as unknown as Tree<string, IndexEntry>` casts remain.
- **Pre-existing latent smell (not addressed)**: `(this.indexManager as any).indexTrees.set(...)` and `(this.indexManager as any).schema = ...` in `optimystic-module.ts:660-661` (the `addIndex` flow) bypass type safety. Predates this ticket — flagged for future cleanup, not introduced or worsened here.

## Usage

No public API change. The `IndexEntry` type alias is now exported from `schema/index-manager.ts` for callers that build factory closures (used by `optimystic-module.ts`).
