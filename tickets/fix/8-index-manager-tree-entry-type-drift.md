# IndexManager Tree<IndexKey, PrimaryKey> entry type drifts from runtime shape

description: IndexManager declares `Tree<IndexKey, PrimaryKey>` (entry = string) but stores `[treeKey, primaryKey]` tuples; tsc flags two assignments while runtime relies on the tuple shape
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/db-core/src/collections/tree/tree.ts
  - packages/db-core/src/collections/tree/struct.ts
----

## Errors

`yarn tsc --noEmit` in `packages/quereus-plugin-optimystic`:

```
src/schema/index-manager.ts(105,34): TS2322: Type '[string, string]' is not assignable to type 'string'.
src/schema/index-manager.ts(157,19): TS2322: Type '[string, string]' is not assignable to type 'string'.
```

## Investigation

`IndexManager` (index-manager.ts:18,23,42) declares:

```ts
export type IndexKey = string;
export type PrimaryKey = string;
private indexTrees = new Map<string, Tree<IndexKey, PrimaryKey>>();
```

The upstream `Tree` API in `packages/db-core/src/collections/tree/struct.ts:18-23`:

```ts
export type TreeReplaceAction<TKey, TEntry> = [
  key: TKey,
  entry?: TEntry,
][];
```

So with `Tree<string, string>`, `replace()` expects `[key: string, entry?: string][]`.

But the IndexManager runtime intent (per the comments at index-manager.ts:101-103 and :154-157) is to store a *tuple* `[treeKey, primaryKey]` as the entry, so that the tree's `keyExtractor` can pick `entry[0]` for sort/range scans:

```ts
// Composite tree key: indexKey + primaryKey ensures uniqueness
// Store as [treeKey, primaryKey] so the tree's keyExtractor (entry[0])
// returns the treeKey for proper sorting and range scans
const treeKey = `${indexKey}\x00${primaryKey}`;
await tree.replace([[treeKey, [treeKey, primaryKey]]]);   // <-- L105
```

and for updates (L155-158):

```ts
await tree.replace([
  [oldTreeKey, undefined],
  [newTreeKey, [newTreeKey, newPrimaryKey]]              // <-- L157
]);
```

The factory in `optimystic-module.ts:645-654` further confirms this — it casts the index tree via `as unknown as Tree<string, string>`, papering over the same mismatch on creation.

This is **not** an upstream API drift; the `Tree`/`TreeReplaceAction` shape in db-core has not changed in a way that would accept tuple entries while typed as `string`.

## Hypothesis

Real (latent) type bug: the entry type for the index tree should be the tuple, not `PrimaryKey`. The runtime relies on `entry[0]` being the composite tree key (so insertions sort/range-scan correctly with non-unique indexes); declaring the entry as `string` was an oversight when secondary-index support was added.

The intended type is something like:

```ts
export type IndexEntry = [IndexKey, PrimaryKey];   // already declared at line 28!
private indexTrees = new Map<string, Tree<IndexKey, IndexEntry>>();
```

`IndexEntry` is already exported at line 28 but unused by `indexTrees` itself.

The runtime is correct (otherwise non-unique secondary indexes would be broken in tests). Only the static type and the `as unknown as Tree<string, string>` cast in optimystic-module.ts:654 need fixing — there is no runtime change required.

## Why this isn't blocking the build

The package compiles via `tsup`, which transpiles per-file without full project type checking. `tsc --noEmit` was run incidentally to surface unused-import lints and revealed this latent error.

## TODO

- Change `IndexManager.indexTrees` (and `IndexTreeFactory`, `getIndexTree`) to use `Tree<IndexKey, IndexEntry>` instead of `Tree<IndexKey, PrimaryKey>`. `IndexEntry` is already declared at index-manager.ts:28.
- Audit read sites (`findByIndex`/range scan code below line 162) for any place that assumed the entry was a bare `PrimaryKey` string and adjust to `entry[1]` (or destructure).
- Drop the `as unknown as Tree<string, string>` cast at optimystic-module.ts:654; the factory's declared return type should now align.
- Re-run `yarn tsc --noEmit` in `packages/quereus-plugin-optimystic` and confirm both errors are gone.
- Confirm via existing index/range-scan tests that behavior is unchanged.
