description: Review IndexManager Tree<IndexKey, IndexEntry> type alignment fix
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
----

## Summary

`IndexManager`'s declared tree entry type drifted from its runtime shape:
- Type said `Tree<IndexKey, PrimaryKey>` (entry = `string`)
- Runtime stored `[treeKey, primaryKey]` tuples so `keyExtractor` (`entry[0]`) returns the composite tree key for sort/range-scan correctness with non-unique indexes

`yarn tsc --noEmit` flagged two assignment errors at `index-manager.ts:105` and `:157`. The factory in `optimystic-module.ts:654` was papering over the same mismatch via `as unknown as Tree<string, string>`.

## What changed

`packages/quereus-plugin-optimystic/src/schema/index-manager.ts`
- `IndexTreeFactory` return type → `Promise<Tree<IndexKey, IndexEntry>>`
- `indexTrees` Map value type → `Tree<IndexKey, IndexEntry>`
- `getIndexTree()` return type → `Tree<IndexKey, IndexEntry> | undefined`
- `findByIndex()`: removed defensive string-fallback (entry was always a tuple at runtime); now simply `yield entry[1]`
- `scanIndexRange()`: same simplification

`packages/quereus-plugin-optimystic/src/optimystic-module.ts`
- Imported `IndexEntry` type alongside `IndexManager`
- Two factory closures (lines ~184 and ~654) now cast to `Tree<string, IndexEntry>` instead of `Tree<string, string>`

The runtime store/replace calls were already correct; only the static types and the casts needed to align.

## Validation

- `yarn tsc --noEmit` in `packages/quereus-plugin-optimystic`: both originally-flagged errors at `index-manager.ts:105` and `:157` are gone. (One unrelated pre-existing error remains in `test/manual-mesh-test.ts` — a `PeerId` cross-package type mismatch, not part of this ticket.)
- `yarn build`: succeeds (tsup ESM + DTS).
- `test/index-support.spec.ts`: all 16 tests passing — covers single/multi-column indexes, unique indexes, equality and range queries, INSERT/UPDATE/DELETE maintenance, populating an index from pre-existing rows, ORDER BY with index, NULLs/empty strings, and duplicate values in non-unique indexes. This exercises the `findByIndex` and `scanIndexRange` read paths whose simplification needed verification.

## Review focus

- Confirm the string-fallback removal in `findByIndex`/`scanIndexRange` is safe — i.e., there is no path that ever stored a bare string as an index tree entry, including older on-disk data, migration paths, or any code that bypasses `IndexManager.{insert,update}IndexEntries`.
- Confirm the two `as unknown as Tree<string, IndexEntry>` casts in `optimystic-module.ts` are still needed (the underlying `createOrGetCollection` doesn't return a typed `Tree<K,V>`); if there's a way to plumb the entry type through `CollectionFactory`, that would eliminate both casts. Out of scope here unless trivial.
- The `(this.indexManager as any).indexTrees.set(...)` and `(this.indexManager as any).schema = ...` in `optimystic-module.ts:660-661` (in addIndex) are a separate latent type-safety smell — pre-existing, not introduced by this ticket, but worth noting.
