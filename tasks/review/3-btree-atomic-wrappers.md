description: Atomic wrappers for BTree mutation methods to prevent store corruption on errors
dependencies: btree, transform/atomic, transform/tracker
files:
  - packages/db-core/src/transform/atomic-proxy.ts (new)
  - packages/db-core/src/transform/index.ts
  - packages/db-core/src/btree/btree.ts
  - packages/db-core/test/btree.spec.ts
----

## Summary

Added `AtomicProxy<T>` — a `BlockStore` wrapper that routes operations through an `Atomic` tracker during scoped mutations. Each BTree public mutation method (`insert`, `upsert`, `merge`, `updateAt`, `deleteAt`, `drop`) is now wrapped in `this.atomic()`, which collects all store operations into a tracker and commits them as a batch on success, or discards them on error.

## Design

**AtomicProxy** (`transform/atomic-proxy.ts`):
- Implements `BlockStore<T>`, delegating to a swappable `_active` target
- `atomic<R>(fn)`: creates an `Atomic` tracker, swaps delegation, runs `fn`, commits/rolls back
- Re-entrant safe: nested `atomic()` calls (e.g., `merge` → `updateAt`) skip creating a new tracker

**BTree integration** (`btree/btree.ts`):
- `BTree.create()` wraps the store in an `AtomicProxy` before passing to both the BTree and the trunk factory — both share the same proxy, so trunk operations (root pointer updates) are part of the same atomic batch
- Private `_proxy` field + `atomic()` helper that delegates to the proxy
- Direct `new BTree()` construction does NOT get atomicity (backward compatible; used by collection system which manages its own tracker)

## Testing

4 new tests in `btree.spec.ts` under `describe('atomic rollback')`:
- **Preserve tree after failed insert**: sabotage `tryGet`, verify tree unchanged
- **Preserve tree after failed delete**: sabotage `tryGet`, verify tree unchanged
- **Preserve tree after failed upsert**: sabotage `tryGet`, verify tree unchanged
- **Roll back partial delete when rebalance read fails**: precise scenario where entry deletion is recorded in Atomic, then rebalance sibling read fails — verifies the deleted entry is still present after rollback

## Validation

- All 248 tests pass (244 existing + 4 new)
- TypeScript compiles cleanly (`tsc --noEmit`)
