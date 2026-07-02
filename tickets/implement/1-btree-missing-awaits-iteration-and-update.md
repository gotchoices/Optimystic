----
description: Add two missing awaits in the B-tree: one in prior() so the cursor finishes moving before being returned, and one in internalUpdate() so the structural delete completes before the subsequent find/insert runs.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/tree.spec.ts
difficulty: easy
----
Two missing `await` calls in `packages/db-core/src/btree/btree.ts`.

## Bug 1 — `prior()` does not await `movePrior` (line 280)

```typescript
// BROKEN
async prior(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>> {
    const newPath = path.clone();
    this.movePrior(newPath);   // <-- missing await
    return newPath;
}
```

`movePrior` → `internalPrior` is async: when the cursor is at leafIndex 0 it must load a sibling leaf from the store before the path is valid. Without `await`, `prior()` returns the path before the store read completes and the path is then mutated underneath the caller. Compare `next()` directly above (line 265–269), which correctly awaits `moveNext`.

Fix: add `await`:
```typescript
async prior(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>> {
    const newPath = path.clone();
    await this.movePrior(newPath);
    return newPath;
}
```

## Bug 2 — `internalUpdate` key-change path does not await `internalDelete` (line 463)

```typescript
// BROKEN
if (newPath.on) {	// insert succeeded
    this.internalDelete(await this.find(oldKey));   // <-- missing await
    newPath = await this.find(newKey);
}
```

`internalDelete` is async (it calls `rebalanceLeaf` / `rebalanceBranch` which load nodes). Without `await`:
- The delete's async rebalance races with the immediately following `find(newKey)`.
- Any rebalance error becomes an unhandled promise rejection, bypassing the `AtomicProxy` rollback and leaving the tree in a partially-mutated state.

Fix: add `await`:
```typescript
await this.internalDelete(await this.find(oldKey));
```

## Tests to add (`packages/db-core/test/tree.spec.ts`)

Two regression tests must be added to the `Tree` describe block:

**Test 1 — `prior()` crossing a leaf boundary**

Insert enough entries to fill more than one leaf node (`NodeCapacity = 64`, so insert at least 65 entries with sequential integer keys). Navigate to the first entry of the second leaf (key 65) using `find`, then call `prior()`. Assert the returned path is `on` and the key is 64 (the last entry of the first leaf). Without the fix this would return a path still pointing to key 65 because the async load hadn't resolved.

**Test 2 — key-changing update that triggers rebalance**

Insert 70 entries (keys 1–70 to ensure multiple leaves), then update the entry with key 35 to have key 1000 (a key that sorts after all existing keys). Assert:
- The old key (35) no longer exists (`tree.get(35)` returns `undefined`).
- The new key (1000) exists with the correct value (`tree.get(1000)` returns the entry).
- All other keys (1–34, 36–70) remain intact.

This exercises the delete-then-reinsert path inside `internalUpdate` and would produce an unhandled rejection (or corrupted tree) without the `await`.

## TODO

- Fix Bug 1: add `await` before `this.movePrior(newPath)` in `prior()` (btree.ts ~line 280)
- Fix Bug 2: add `await` before `this.internalDelete(...)` in `internalUpdate()` (btree.ts ~line 463)
- Add regression test: `prior()` crossing leaf boundary (tree.spec.ts)
- Add regression test: key-changing update with rebalance (tree.spec.ts)
- Run `npm test` in `packages/db-core` and confirm all tests pass
