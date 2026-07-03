----
description: After a stored item is deleted and re-added in the same transaction, reads return the old stored version instead of the newly added one — fix tryGet to check inserts before the source.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/test/transform.spec.ts
difficulty: easy
----

## Root cause

`Tracker.tryGet` fetches from `source` first. If the source has the block, it enters the `if (block)` branch, applies pending updates, checks deletes — but **never checks `transforms.inserts`**. The insert branch (`else if`) is only reached when the source returns nothing.

`struct.ts:4-5` documents the precedence order as **insert → update → delete**, so an insert must shadow the source.

Affected path (tracker.ts:14-27):
```
tryGet
  → source.tryGet(id)     // ← fetches from source first
  if (block) {
    apply updates
    check deletes
    // inserts never checked here
  } else if (inserts[id]) { return clone }   // ← only reached on source miss
```

The delete-then-reinsert sequence is the clearest trigger:
1. Block exists in source.
2. `delete(id)` — adds id to `transforms.deletes`, removes from inserts.
3. `insert(newBlock)` — puts new block in `transforms.inserts`, removes id from `transforms.deletes`.
4. `tryGet(id)` — source has the original block; `if (block)` branch runs; deletes list is empty (insert cleared it); source block is returned. **Wrong.**

## Fix

Reorder `tryGet` to check inserts before the source:

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

Notes:
- Inserted blocks already have ops applied in-place by `update()` (tracker.ts:48-54), so no need to re-apply `transforms.updates` for the inserts path.
- Deletes checked before source lookup: if source has a block that is deleted (and not re-inserted), return undefined without hitting the source.

## Existing test that documents the bug

`transform.spec.ts:232-258` — "should ignore Tracker insert when source already has block with same ID (BUG: silent shadow)" — asserts the **wrong** behavior. Flip the expectations to assert the fix.

## TODO

- Fix `tryGet` in `packages/db-core/src/transform/tracker.ts` per the reordered implementation above.
- In `packages/db-core/test/transform.spec.ts:232-258`, update the test to assert the **correct** behavior: inserted block takes precedence over source.  Update description to remove the "(BUG: silent shadow)" label.
- Add a new test case in the same `transform.spec.ts` describe block for the delete-then-reinsert sequence: source has block, tracker deletes it, tracker re-inserts with different content, `tryGet` must return the reinserted content.
- Run `packages/db-core` tests and confirm all pass.
