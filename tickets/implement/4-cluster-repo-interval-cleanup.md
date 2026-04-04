# ClusterRepo setInterval Cleanup

description: Add dispose() to ClusterMember that clears interval and timeout handles, and wire it into the node stop lifecycle
dependencies: none
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/cluster-repo.spec.ts
----

## Design

`ClusterMember` creates two `setInterval` timers in its constructor (lines 101-103) and individual `setTimeout` handles per-transaction in `TransactionState.promiseTimeout` and `TransactionState.resolutionTimeout`. None of these are cleaned up when the instance is no longer needed.

### Changes

**`cluster-repo.ts`** — Store interval handles and add `dispose()`:

- Add two private fields to store the `NodeJS.Timeout` handles returned by the `setInterval` calls in the constructor (lines 101-103).
- Add a `dispose(): void` method that:
  1. Calls `clearInterval()` on both stored handles.
  2. Iterates `activeTransactions` and calls `clearTimeout()` on each entry's `promiseTimeout` and `resolutionTimeout`.
  3. Clears the `activeTransactions` map and `cleanupQueue` array.
- No changes to `ICluster` — `dispose()` is only on the concrete `ClusterMember` class (which is what `clusterImpl` is typed as in `libp2p-node-base.ts`).

**`libp2p-node-base.ts`** — Wire `clusterImpl.dispose()` into node shutdown:

- Near the end of the function (around line 442-449), before `return node`, override `node.stop` to call `clusterImpl.dispose()` during shutdown, following the same pattern already used for `clearInterval(monitorInterval)` at line 398-403.
- Since there's already a conditional `node.stop` override for the Arachnode monitor interval, the new override should wrap the current `node.stop` (whether already overridden or original) to also call `clusterImpl.dispose()`.

### Test expectations

- After constructing a `ClusterMember` and calling `dispose()`, the intervals should be cleared (verifiable by checking no further invocations occur, or by inspecting timer state).
- After `dispose()`, `activeTransactions` should be empty.
- A basic test: create a `ClusterMember`, start a transaction to generate timeouts, call `dispose()`, and verify the instance is cleaned up.

## TODO

- [ ] Add private `expirationInterval` and `cleanupInterval` fields to `ClusterMember`
- [ ] Store the `setInterval` return values in these fields in the constructor
- [ ] Add `dispose(): void` method that clears intervals, clears all active transaction timeouts, and empties the maps/queue
- [ ] In `libp2p-node-base.ts`, wrap `node.stop` to call `clusterImpl.dispose()` before stopping
- [ ] Add test in `cluster-repo.spec.ts` verifying that `dispose()` clears timers and empties active state
- [ ] Run `yarn test:db-p2p` to verify all tests pass
