----
description: Review the fix that makes Tracker.tryGet check inserts before the source, so a delete-then-reinsert in the same transaction returns the new block.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/test/transform.spec.ts
----

## What changed

`Tracker.tryGet` (`tracker.ts:14-26`) was reordered so it checks `transforms.inserts` first, then `transforms.deletes`, then falls through to the source. Previously inserts were only checked when the source returned nothing, causing the source block to shadow any pending insert.

### New `tryGet` logic

```typescript
async tryGet(id: BlockId): Promise<T | undefined> {
    if (this.transforms.inserts && Object.hasOwn(this.transforms.inserts, id)) {
        return structuredClone(this.transforms.inserts[id]) as T;
    }
    if (this.transforms.deletes?.includes(id)) {
        return undefined;
    }
    const block = await this.source.tryGet(id);
    if (block) {
        const ops = this.transforms.updates?.[id] ?? [];
        ops.forEach(op => applyOperation(block!, op));
    }
    return block;
}
```

Notes on correctness:
- Inserted blocks already have ops baked in-place by `update()` (tracker.ts:47-54), so no re-application of `transforms.updates` is needed in the insert path.
- Deletes before source lookup: a block that exists in source but is pending-delete returns `undefined` without an unnecessary async fetch.

### Test changes (`transform.spec.ts`)

- Line 232: renamed test from "BUG: silent shadow" → "insert takes precedence"; flipped assertions to expect `from-insert` not `from-source`.
- Added new test "should return reinserted block after delete-then-reinsert in same transaction" — source has block, tracker deletes it, tracker reinserts with different content, `tryGet` must return the reinserted content.

## Test run

`npm test` in `packages/db-core` — **1103 passing**, 0 failing.

## Use cases for the reviewer to exercise

1. **Insert shadows source** — `tracker.insert(block)` where source already has that id; `tryGet` must return the inserted version.
2. **Delete-then-reinsert** — `tracker.delete(id)` then `tracker.insert(newBlock)`; `tryGet` must return `newBlock`, not the source block or `undefined`.
3. **Plain delete** — `tracker.delete(id)` with no reinsert; `tryGet` must return `undefined` even if source has it.
4. **Update on source block** — no insert or delete; `tryGet` must return the source block with ops applied (unchanged behavior).
5. **Insert with subsequent update** — `insert` then `update`; `update()` applies ops in-place on the stored insert; `tryGet` must reflect both.

## Review findings

No concerns flagged. The change is a simple reorder with no logic added.
