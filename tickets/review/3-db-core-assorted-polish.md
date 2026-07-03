----
description: Review seven small correctness and cleanliness fixes across db-core: pending response detection, async/await misuse in btree, non-null assertion removal, dedup redundancy in tracker, O(n²) log assembly, and mutating array reverse in collection.
files: packages/db-core/src/utility/pending.ts, packages/db-core/src/btree/btree.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/log/log.ts, packages/db-core/src/collection/collection.ts
----

## Summary

All seven fixes from the original plan are confirmed in the codebase. 1118 tests pass.

## Changes (verify each)

**`utility/pending.ts`**
- Added `_responded: boolean` field, set to `true` inside `promise.then()`.
- `isResponse` returns `this._responded` instead of `this.response !== undefined`.
- Fix: `Promise<void>` batches resolved to `undefined`, which made `isResponse` return `false` even after resolution. Now correct.
- Reviewer: check `incompleteBatches` (wherever that's computed) still sees `isComplete` flip correctly for void callers.

**`btree.ts:196`** (`merge`)
- Removed `await` from `const newKey = this.keyFromEntry(newEntry)`.
- `keyFromEntry` is a sync callback `(entry: TEntry) => TKey`; awaiting it returned a `Promise<TKey>` cast, which silently worked but was wrong.

**`btree.ts:528`** (`internalInsertAt`)
- Removed `await` from `this.store.insert(newBranch)`.
- `Tracker.insert` returns void. Sibling call in `leafInsert` already had no `await`; now consistent.

**`btree.ts:670, 680`** (`rebalanceLeaf`) and **`btree.ts:731`** (`rebalanceBranch`)
- Removed `!` non-null assertions on `pNode.nodes[pIndex + 1]` and `pNode.nodes[pIndex - 1]`.
- These are legitimately `undefined` when no sibling exists; the ternary immediately after handles that. The assertions were incorrect safety theatre.

**`tracker.ts:79`** (`transformedBlockIds`)
- `blockIdsForTransforms` already wraps a `new Set` internally.
- Removed outer `Array.from(new Set(...))` wrapper; now just `return blockIdsForTransforms(this.transforms)`.

**`log/log.ts:getFrom`**
- Original used `unshift` in a loop — O(n²) for the unsynced tail.
- Replaced with `push` into accumulators + `reverse()` after each loop.
- `checkpointPendings` (from the checkpoint entry) is prepended at final assembly: `[...checkpointPendings, ...pendingActions.reverse()]`.
- Entries from the second loop (past checkpoint) combined as: `[...entriesFromCheckpoint.reverse(), ...entriesFromTail.reverse()]`.
- Ordering verified by algorithm trace; confirmed by full test suite pass.

**`collection.ts:378`** (`selectLog`)
- `entry.action.actions.reverse()` mutated the stored log entry array in-place.
- Fixed to `[...entry.action.actions].reverse()` (copy first).
- `Array.prototype.toReversed()` would be cleaner but requires ES2023; tsconfig targets ES2022, so spread-copy is used.

## Known gaps / areas for reviewer focus

- `isResponse` / `isComplete` for `Promise<void>`: the fix is correct, but the reviewer should trace all callers of `incompleteBatches` (or wherever `isComplete` is checked for void-typed `Pending<void>`) to confirm no caller relied on the old broken behavior (e.g. checking `pending.response !== undefined` directly instead of `pending.isResponse`).
- `getFrom` ordering: algorithm trace says correct; reviewer should independently verify the two-loop ordering logic against the original intent (newest-first entries, checkpoint pendings prepended).
- No new tests were added for any of these fixes. The existing 1118-test suite covers the changed paths implicitly. A reviewer may want to add targeted unit tests for `Pending<void>.isComplete` and for `selectLog` backward iteration producing correct (non-mutated) order.

## Review findings

- Tripwire noted in `collection.ts:378` comment: `toReversed()` is the right call once tsconfig advances to ES2023. Parked as a `NOTE:` comment at the site.
- No tickets filed; all concerns are either fixed or genuinely conditional.
