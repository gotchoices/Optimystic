description: When another machine's write reaches this machine, apps watching the table were woken as soon as the table's own data arrived, before the table's indexes had caught up, and nothing woke them again; a lookup through an index at that moment missed the new row. Storage now holds the table's wake on this machine until every other part of the same write that this machine is due to store has arrived.
architecture: docs/internals.md#change-notification-reactive-wake
files: packages/db-p2p/src/storage/action-change-hold.ts (new, `ActionChangeHold`), packages/db-p2p/src/storage/storage-repo.ts (`emitCollectionChanges`, `closeAbandonedGroups`, `notePendGroup`, `noteCancelled`, `armHoldTimer`, `pendUnderLatches`, `StorageRepoOptions.changeHoldMs`, `DEFAULT_CHANGE_HOLD_MS`), packages/db-core/src/transactor/change-notifier.ts (`IBlockChangeNotifier.onCollectionChange` doc), packages/db-p2p/src/testing/mesh-harness.ts (`BuildTransactorOptions.notifyLocalChanges`, `selfFirstReads`, `MeshOptions.changeHoldMs`, `MeshFailureConfig.onClusterDelivery`), packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (`startMockMesh`, `MockMeshOptions`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`ensureChangeSubscription` doc), packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/action-change-hold.spec.ts (new), packages/quereus-plugin-optimystic/test/two-node-index-wake-consistency.spec.ts (new), docs/internals.md
difficulty: hard
----
# A watch wakes after every collection of a commit applies

GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47). Implemented as the plan ticket chose: storage holds an action's per-collection change events while another collection of the same action still has an open pend group on this node.

## What changed

**Hold bookkeeping, pure state.** `ActionChangeHold` in `packages/db-p2p/src/storage/action-change-hold.ts` tracks, per action id: its pend groups (the block set one `StorageRepo.pend` call saved, with an open flag), its held events, and when it was first seen. Operations: note a group (a pend whose blocks overlap an existing group extends it), close groups by block ids (landed or cancelled), list and close open groups, hold an event (returns whether it is the action's first, so the owner arms its timer), release (take held events in order and forget the action, one synchronous step), age out event-less entries older than five minutes, and evict the oldest at a 4096-action cap, returning its held events so they are released rather than dropped. No I/O, no timers.

**StorageRepo.** `pendUnderLatches` now also returns the blocks pass 2 saved; a successful `pend` notes them as a group. `emitCollectionChanges` is async and does the dispatch: it closes the action's groups that this call landed blocks of; if no group is open (the single-collection case, the last collection of a transaction, an action it never tracked) it releases whatever was held and fires the call's own events exactly in the order they fired before. Otherwise it fires the catch-all feed at once, reads each open group's blocks' pending records once (`closeAbandonedGroups`, unlatched) to close groups whose records are gone, and then either releases and fires, or holds the events and arms a per-action unref'd timer of `changeHoldMs` (new option, default 10 s, 0 disables). `commit`, `saveReplicatedBlock` and the read-driven promotion in `get` await it; `cancel` closes the groups its block ids intersect without a read and releases if none is left. Held events go to the per-collection listener set current at release.

**Harness.** Three opt-in additions to `packages/db-p2p/src/testing/mesh-harness.ts`, each off by default: `BuildTransactorOptions.notifyLocalChanges` (a node's transactor gets its own storage repo as `localChangeNotifier`, resolved per call so a restarted node's new repo is the one listened to), `BuildTransactorOptions.selfFirstReads` (a node's transactor answers read-intent `findCoordinator` with itself when it is in the key's cohort and not excluded), and `MeshFailureConfig.onClusterDelivery` may return a promise the delivery awaits. One more than the ticket asked for: `MeshOptions.changeHoldMs`, passed to every node's `StorageRepo`, so a spec can run the same scenario with the hold off. `startMockMesh(size, options)` in the plugin's harness passes all four through.

**Docs.** docs/internals.md §Change Notification gains the hold bullet (rule, cost, bound, memory, residuals, why the catch-all is exempt); §Reactive Watch Bridge says what makes the re-query see the indexes and records the network-watch finding (early over-wake on a storing subscriber, a gap on a non-storing one, backlog `feat-a-network-watch-wake-sees-the-whole-commit`). The `IBlockChangeNotifier.onCollectionChange` doc and the `ensureChangeSubscription` scope comment say a listener may now be invoked from a later storage call or from a timer.

## Tests added

- `storage-repo.spec.ts` "holds the first collection's event while the second is pending, then fires both in order when the second lands": two collections pended under one action in two calls; committing the first fires the catch-all and no per-collection listener; committing the second fires the first collection's event then the second's.
- `storage-repo.spec.ts` "releases the held event when the writer cancels the other collection's pend": same setup, a cancel of the second collection's block releases the first's event.
- `storage-repo.spec.ts` "releases a held event when changeHoldMs elapses with the other collection still pending": `changeHoldMs: 40`, the event fires on the timer with the other collection's pending record still present.
- `action-change-hold.spec.ts` (three pure cases): an overlapping pend extends a group rather than adding one and landing any of its blocks closes the whole group; at capacity the oldest action is evicted and its held events are returned, extending a tracked action evicts nobody; age-out drops stale event-less actions and keeps young ones and ones holding events, and a second release finds nothing.
- `two-node-index-wake-consistency.spec.ts` (the reproduction): table `T (Id primary key, K)` with index `TByK`, created on node 0, declared on node 1, node 1 watching `select Id, K from T` with `notifyLocalChanges` and `selfFirstReads`. Every cluster delivery to node 1 carrying a commit of the index's log tail (read once after a seed insert with `Collection.readCommittedTail`) waits on a gate that node 1's wake handler releases after its two lookups, or 400 ms. Case 1: four inserts; at every wake where the primary-key lookup finds the row the index lookup finds it too, and every row is seen through the index at some wake. Case 2, the control: `changeHoldMs: 0` on the mesh, one insert; the wake finds the row by primary key and misses it through the index. The control is what proves case 1 does not pass for want of the race; it is beyond the ticket's list and can be cut if judged not to pay for itself.

## Validation

Run from the repo root after `yarn build`:

```
yarn workspace @optimystic/db-p2p test            # 3530 passing, 74 pending
yarn workspace @optimystic/quereus-plugin-optimystic test   # 1056 passing, 14 pending, smoke ok
yarn typecheck && yarn lint && yarn lint:docs
```

The new plugin spec passed on five consecutive runs (about 2 s each). Not run: `yarn test:integration` (real sockets, env-gated) and `yarn check:rn`; the new module uses only `Map`, `Set` and arrays.

## Known gaps and things to scrutinize

- **Event order on the held path only.** When a storage check runs (another collection of the action still has an open group), the catch-all feed fires before that call's per-collection half, where it used to fire after each collection's listeners. On every other path the order is unchanged. No consumer is known to depend on the relative order of the two feeds; worth a look.
- **`commit`, `saveReplicatedBlock` and `get` now await the dispatch.** The added latency is one unlatched local read per open group of a multi-collection action, and nothing on the single-collection path. A commit that throws still emits nothing, as before.
- **Pure-state tests cover the bound; the end-to-end timer is tested at 40 ms.** Nothing exercises the 10 s default or the five-minute age-out at real timescales.
- **The negative control and `MeshOptions.changeHoldMs`** are additions beyond the ticket's scope, argued for in the spec's header. Reviewer's call.
- **`changeHoldMs` is reachable only through `StorageRepoOptions`.** The production node and the plugin's local transactor take the default; no `NodeOptions` knob was added, per the ticket.
- **Residuals recorded as `NOTE:`s at their sites, not re-filed:** a pend delivered after another collection's commit already emitted holds nothing for that event (`notePendGroup`); a collection landing after the timer released fires only its own listeners, with the tripwire to subscribe the vtab to its index collections if gaps beyond `changeHoldMs` are ever seen (`armHoldTimer`).
- **The network-watch path is unchanged**, as the ticket specified; the finding is recorded in docs/internals.md §Reactive Watch Bridge and tracked by backlog `feat-a-network-watch-wake-sees-the-whole-commit`.
- **Harness coverage.** `selfFirstReads` is exercised only by the new spec; no spec drives `partitionSides` through a self-first transactor (the existing NOTE about the unpartitioned shared view still applies).
