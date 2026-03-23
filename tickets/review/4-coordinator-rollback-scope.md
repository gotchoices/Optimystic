# Coordinator Rollback: Scope by stampId

description: coordinator.rollback(stampId) now only discards the given stampId's transforms, preserving other sessions' state
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Summary

Fixed `TransactionCoordinator.rollback(stampId)` to only undo the transforms belonging to the given `stampId`, preserving other concurrent sessions' state. Previously, rollback ignored the `stampId` parameter and reset ALL collection trackers — destroying every session's pending transforms.

## Approach: Snapshot + Replay

The initial ticket proposed a diff-based approach (snapshot before, diff after, subtract on rollback). This didn't work because `Tracker.update()` for inserted blocks applies operations **in-place** on the block objects. `copyTransforms()` only shallow-copies insert references, so the "before" snapshot gets contaminated by mutations.

Instead, the implementation uses **snapshot + replay**:

1. **On `applyActions(actions, stampId)`**: Before the first apply for a given stampId, `structuredClone` the full transforms of ALL collections. Store the snapshot and accumulate action batches.
2. **On `rollback(stampId)`**: Restore all collection trackers to the snapshot taken before that stamp. Then replay all later stamps' actions in order to preserve their changes.
3. **On `commit()`/`execute()`**: Clean up the stampData entry for the committed stamp.

This correctly handles:
- Single-session rollback (session data removed, tree structure preserved)
- Multi-session rollback (only the rolled-back session's data is removed)
- Interleaved sessions sharing the same B-tree leaf nodes

## Key Changes

### coordinator.ts
- Added `stampData` map: stores per-stampId `{ order, preSnapshot, actionBatches }`
- Split `applyActions` into public method (with tracking) and `applyActionsRaw` (for replay)
- Rewrote `rollback()`: restores snapshot, then replays later stamps' actions
- Cleanup on `commit()` and `execute()`: deletes stampData entry

### transaction.spec.ts
- Updated "should discard pending changes on rollback" — now verifies session data is gone via tree.get() rather than checking transforms.size === 0 (tree init blocks are correctly preserved)
- Updated "should discard session data across multiple collections on rollback" — same approach
- Renamed bug test to "should only rollback the given session transforms, preserving other sessions" — now asserts Alice is gone, Bob survives

## Limitation

If two concurrent sessions modify the **same block** (e.g., same B-tree leaf), rollback of the earlier session restores the pre-session snapshot and replays the later session's actions. This works correctly since replay re-executes through `collection.act()`. However, if `act()` has side effects beyond the tracker (events, external state), those would be triggered again during replay.

## Testing

- **db-core**: 267 tests passing
- **db-p2p**: 325 tests passing
- **quereus-plugin-crypto**: 50 tests passing

### Key test cases
- Single-session rollback: session data is removed, tree structure preserved
- Multi-collection rollback: data removed from all affected collections
- Multi-session rollback (the bug fix): rolling back session 1 preserves session 2's data
- Already-committed/already-rolled-back guards still work
- Commit after rollback scenarios unchanged

## Usage

No API changes — `session.rollback()` works the same way, just correctly scoped now.
