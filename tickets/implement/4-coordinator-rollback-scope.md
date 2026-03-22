# Coordinator Rollback: Scope by stampId

description: Fix coordinator.rollback(stampId) to only discard transforms belonging to the given stampId, preserving other sessions' state
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transform/helpers.ts
  - packages/db-core/test/transaction.spec.ts
----

## Root Cause

`TransactionCoordinator.rollback(_stampId)` (coordinator.ts:155) ignores its `stampId` parameter and calls `collection.tracker.reset()` on every collection. This is a blanket wipe of all transforms. The `Tracker` class stores all transforms in a single flat `Transforms` object with no per-session partitioning. When multiple sessions share a coordinator, their transforms are interleaved in the same tracker, and rollback of one session destroys all sessions' state.

The comment at line 158-159 even acknowledges this:
```
// TODO: In the future, we may want to track which collections were affected by
// a specific stampId and only reset those trackers
```

## Fix: Per-stampId delta tracking in the coordinator

The coordinator should track each stampId's contributed transforms (deltas) so they can be selectively removed on rollback. The approach:

### 1. Add `subtractTransforms` helper (helpers.ts)

A new utility that removes one set of transforms from another:
```ts
function subtractTransforms(base: Transforms, toRemove: Transforms): Transforms
```
- Remove `toRemove.inserts` keys from `base.inserts`
- Remove `toRemove.updates` keys from `base.updates`
- Remove `toRemove.deletes` entries from `base.deletes`

This is the inverse of `mergeTransforms` for the non-overlapping case. Two sessions modifying the same block is inherently conflicting and doesn't need special handling here (it's already problematic regardless of rollback).

### 2. Add per-stampId delta tracking to the coordinator (coordinator.ts)

Add a private field:
```ts
private stampDeltas = new Map<string, Map<CollectionId, Transforms>>();
```

### 3. Modify `applyActions()` to capture deltas

Before applying actions for a stampId, snapshot each affected collection's tracker transforms. After applying, diff to compute the delta (new block IDs in inserts/updates/deletes). Store the delta keyed by stampId.

```ts
async applyActions(actions: CollectionActions[], stampId: string): Promise<void> {
    // Snapshot affected collections' transforms before applying
    const beforeSnapshots = new Map<CollectionId, Transforms>();
    for (const { collectionId } of actions) {
        const collection = this.collections.get(collectionId);
        if (collection) {
            beforeSnapshots.set(collectionId, copyTransforms(collection.tracker.transforms));
        }
    }

    // Apply actions (existing logic)
    for (const { collectionId, actions: collectionActions } of actions) { ... }

    // Compute and store deltas
    const deltas = new Map<CollectionId, Transforms>();
    for (const { collectionId } of actions) {
        const collection = this.collections.get(collectionId);
        if (collection) {
            const before = beforeSnapshots.get(collectionId)!;
            const after = collection.tracker.transforms;
            deltas.set(collectionId, diffTransforms(before, after));
        }
    }

    // Merge with existing deltas for this stampId (in case of multiple execute() calls)
    const existing = this.stampDeltas.get(stampId);
    if (existing) {
        for (const [collectionId, delta] of deltas) {
            const prev = existing.get(collectionId);
            existing.set(collectionId, prev ? mergeTransforms(prev, delta) : delta);
        }
    } else {
        this.stampDeltas.set(stampId, deltas);
    }
}
```

### 4. Modify `rollback()` to subtract only the given stampId's deltas

```ts
async rollback(stampId: string): Promise<void> {
    const deltas = this.stampDeltas.get(stampId);
    if (deltas) {
        for (const [collectionId, delta] of deltas) {
            const collection = this.collections.get(collectionId);
            if (collection) {
                const remaining = subtractTransforms(collection.tracker.transforms, delta);
                collection.tracker.reset(remaining);
            }
        }
        this.stampDeltas.delete(stampId);
    }
}
```

### 5. Clean up stampDeltas on commit

After a successful commit in `commit()` and `execute()`, clean up the stampId's deltas:
```ts
this.stampDeltas.delete(transaction.stamp.id);
```

### 6. Update the test (transaction.spec.ts:2657)

Change the bug-documenting test to assert correct behavior:
- After rolling back session 1, `coordinator.getTransforms()` should still contain session 2's transforms (size = 1)
- Session 2's specific insert (key: 2, name: 'Bob') should be present in the remaining transforms
- Rename the test to remove the "(BUG: stampId ignored)" suffix

### 7. Add `diffTransforms` helper (helpers.ts)

Compute the delta between a before and after `Transforms`:
```ts
function diffTransforms(before: Transforms, after: Transforms): Transforms
```
- `inserts`: keys in `after.inserts` not in `before.inserts`
- `updates`: keys in `after.updates` not in `before.updates` (or with more operations)
- `deletes`: entries in `after.deletes` not in `before.deletes`

## Key interfaces

- `Tracker.reset(newTransform?)` — already supports replacement transforms (tracker.ts:64)
- `copyTransforms(t)` — deep copy of transforms (helpers.ts:61)
- `mergeTransforms(a, b)` — union merge of two transforms (helpers.ts:69)
- `emptyTransforms()` — empty transforms factory (helpers.ts:50)

## Limitation

If two concurrent sessions modify the **same block**, rollback of one may remove the other's updates to that block. This is inherent to the shared-tracker architecture and is not a regression — the current code already has undefined behavior for this case (it destroys everything). The fix improves the common case (non-overlapping transforms) without making the edge case worse.

## TODO

- [ ] Add `subtractTransforms(base, toRemove)` to `packages/db-core/src/transform/helpers.ts`
- [ ] Add `diffTransforms(before, after)` to `packages/db-core/src/transform/helpers.ts`
- [ ] Export both new helpers from `packages/db-core/src/index.ts` (if helpers are re-exported there)
- [ ] Add `private stampDeltas` field to `TransactionCoordinator`
- [ ] Update `applyActions()` to capture and store per-stampId deltas
- [ ] Update `rollback(stampId)` to subtract only that stampId's deltas via `subtractTransforms`
- [ ] Clean up `stampDeltas` entries on successful `commit()` and `execute()`
- [ ] Update test "should destroy concurrent session transforms on rollback" to assert correct behavior (transforms.size === 1, session 2 data survives)
- [ ] Remove the `_stampId` underscore prefix and TODO comment from `rollback` parameter
- [ ] Run full test suite to ensure no regressions
