# ClusterRepo setInterval Cleanup

description: Added dispose() to ClusterMember that clears interval and timeout handles, wired into node stop lifecycle
dependencies: none
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/cluster-repo.spec.ts
----

## Summary

`ClusterMember` creates two `setInterval` timers (expiration check every 60s, cleanup queue every 1s) and per-transaction `setTimeout` handles. Previously none of these were cleaned up when the node stopped.

### Changes

**`cluster-repo.ts`**:
- Added `expirationInterval` and `cleanupInterval` private fields to store interval handles.
- Constructor now assigns `setInterval` return values to these fields.
- Added `dispose(): void` method that:
  1. Calls `clearInterval()` on both stored handles.
  2. Iterates `activeTransactions` and calls `clearTimeout()` on each entry's `promiseTimeout` and `resolutionTimeout`.
  3. Clears the `activeTransactions` map and `cleanupQueue` array.

**`libp2p-node-base.ts`**:
- Added a `node.stop` override (wrapping the existing stop, which may already be overridden by the Arachnode monitor) that calls `clusterImpl.dispose()` before the previous stop.

**`cluster-repo.spec.ts`**:
- Added `dispose` test suite verifying:
  - `dispose()` clears active transaction state.
  - `dispose()` clears per-transaction timeouts and is safe to call multiple times (idempotent on empty state).

## Test plan

- [ ] Verify `dispose()` clears intervals and empties `activeTransactions`
- [ ] Verify `dispose()` clears per-transaction timeouts without error
- [ ] Verify double-call to `dispose()` is safe
- [ ] Verify `node.stop` override properly chains with existing arachnode stop override
- [ ] All 379 existing tests continue to pass (`yarn test:db-p2p`)
- [ ] TypeScript compiles cleanly (`yarn tsc --noEmit` in db-p2p)
