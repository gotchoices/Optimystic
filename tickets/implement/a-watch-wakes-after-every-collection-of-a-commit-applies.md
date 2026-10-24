description: When another machine's write reaches this machine, apps watching the table are woken as soon as the table's own data arrives, before the table's indexes have caught up, and nothing wakes them again; a lookup through an index at that moment misses the new row. Hold the table's wake on this machine until every other part of the same write that this machine is due to store has arrived.
architecture: docs/internals.md#change-notification-reactive-wake
files: packages/db-p2p/src/storage/storage-repo.ts (`emitCollectionChanges`, `emitPromotions`, `pend`, `commit`, `cancel`, `saveReplicatedBlock`, `StorageRepoOptions`), packages/db-p2p/src/storage/ (new module for the hold, e.g. `action-change-hold.ts`), packages/db-p2p/src/unref-timer.ts, packages/db-core/src/transactor/change-notifier.ts (`IBlockChangeNotifier` doc), packages/db-p2p/src/testing/mesh-harness.ts (`BuildTransactorOptions`, `meshTransactor`, `MeshFailureConfig.onClusterDelivery`, `createClusterClient`'s `reach`), packages/db-p2p/test/storage-repo.spec.ts, packages/quereus-plugin-optimystic/test/mesh-node-harness.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts (`ensureChangeSubscription` doc comment), docs/internals.md
difficulty: hard
----
# A watch wakes after every collection of a commit applies

GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47) (Sereus repro).

## The defect

A SQL table and each of its indexes are separate collections (`<uri>` and `<uri>/index/<name>`). A transaction writing a row writes one log entry per collection under ONE action id, and `TransactionCoordinator.pendPhase` / `commitPhase` (`packages/db-core/src/transaction/coordinator.ts`) pend and commit each collection as its own consensus record, concurrently. So a member receiving another machine's write applies the table's commit and the index's commit as two separate `StorageRepo.commit` calls, a few hundred ms apart on a relayed link.

`StorageRepo.commit` fires a `CollectionChangeEvent` for each collection at the end of its own call (`emitCollectionChanges`). The vtab subscribes only to its main collection (`OptimysticVirtualTable.ensureChangeSubscription`), and turns the event into `Database.notifyExternalChange`. A query run at that wake and planned through the index (`where K = ?`) reads the index from this node's own replica (`selfReadVerdict`), which does not hold the index commit yet, and finds nothing. The index's own event wakes nobody, so the app sees the row at its next poll or not at all.

## Chosen design: storage holds an action's per-collection wakes while another of its collections is still pending here

What a member knows at the moment it applies the table's commit: the writer pends every collection before committing any (`pendPhase` finishes before `commitPhase`), so a member in every collection's cohort already holds the index's **pending record under the same action id**. That is the signal. No wire change, no knowledge of the log format, and it covers several tables in one transaction as well as a table and its indexes.

**Rule.** A per-collection change event of action A is held on this node while A has an **open pend group** here. A pend group is the set of blocks one `StorageRepo.pend` call saved for A (pass 2's saved blocks — `satisfied` blocks are not part of it; a pend that saved nothing adds no group). One `pend` call is one collection's request, also inside a batch record, which `applyConsensusOperations` applies one operation at a time. A group is **open** until either a block of it lands on this node (a commit, a read-driven promotion, or a replica of A's revision — any path that emits an event of A naming that block), or none of its blocks still holds A's pending record (cancelled, dropped by `dropUnpromotablePendings`, replaced). When A's last open group closes, the held events fire, in the order they were held, ahead of the closing call's own events.

Why groups and not blocks: a group already partly landed is the SAME collection mid-commit — the tail-then-sweep path (`commitTailThenSweep`), or a mid-loop `internalCommit` throw — and the documented eager emission for those (`docs/internals.md` §Change Notification, "Emission guarantee (Option A)", case (a)) must stay as it is. Only another collection's untouched pend holds a wake.

**Scope: per-collection listeners only.** The catch-all feed (`onAnyCollectionChange`) keeps firing at the end of each call, exactly as today. It feeds cohort-topic origination and tail-rotation detection (`makeCohortTopicChangeNotifier`) and the owned-block feed (`libp2p-node-base.ts`), none of which wants a delay, and the commit certificate origination resolves is looked up by action id alone, so releasing a table's event after the index record's certificate was stored would hand origination the wrong record's certificate (backlog `bug-a-commit-cert-is-looked-up-by-action-alone`). Every vtab wiring reaches the per-collection feed: the `local`/`test` transactors delegate to `StorageRepo.onCollectionChange`, the `network` transactor's `localChangeNotifier` is `node.blockChangeNotifier`, whose `onCollectionChange` delegates to the `StorageRepo`.

**Bound.** A held event is released at the latest `changeHoldMs` after it was first held (new `StorageRepoOptions.changeHoldMs`, default 10 000; `0` disables holding entirely). One timer per action with held events, through `unrefTimer`; firing it releases A's held events and forgets A. A wake that is late in the pathological case (a writer that died between its commits) is better than one that never comes; 10 s covers slow relays with margin and is under the 30 s reactivity tick.

**Memory.** In memory only. Per action: its groups (block sets, open flag) and its held events. An action with no held events is forgotten once all its groups close; an entry whose groups never close and that holds no events (a writer that pended and vanished) is dropped when older than a fixed age (a few minutes — pick a named constant, checked lazily on each `pend`), and the map is capped (a named constant, e.g. 4096 actions, evicting oldest; an evicted entry's held events are released, never dropped). A restart forgets everything, which only means the next commit of an action pended before the restart wakes at once, as today.

**Cost.** A single-collection action has one group, which its own commit closes by landing: no storage read, no delay, no timer. For a multi-collection action, after a write group of A ends with groups still open, each open group is checked once by reading its blocks' pending records (`getPendingTransaction(actionId)` on the block storage, outside any latch). Nothing else changes on the commit path.

**Where the checks run.** After the write group's flush, where the call emits today: `commit`, `cancel` (a cancel closes every group intersecting `actionRef.blockIds` without a read), `saveReplicatedBlock`, and the read-driven promotion in `get` (`emitPromotions`). `pend` only records the group. `emitCollectionChanges` may become async for the per-collection half; the catch-all half stays synchronous. Keep the hold's bookkeeping in its own small module (pure state: note a group, close by landed blocks, close by cancel, list open groups, hold/release events, age-out) and keep the storage reads and the timer in `StorageRepo`, so the state logic has no I/O.

## The network-watch path (`node.reactivityWatch`)

It has the same shape, and this ticket does not change it. Origination fires on the root group member when the TABLE's commit applies there (`selfAppliedTail` gate over the catch-all), so the notification can reach a subscriber before the index commit has applied anywhere, and the watch service's tick (`ReactivityCollectionWatch`, `packages/db-p2p/src/reactivity/collection-watch.ts`) compares only the table's tail revision, so it never wakes again for that commit. What this ticket gives the network path: on a subscriber that also stores the collections (every member of a group no larger than a cohort — the Sereus two-member case), the network wake is an early over-wake and the held storage wake that follows is consistent. A subscriber that stores nothing still has the gap; that is backlog `feat-a-network-watch-wake-sees-the-whole-commit`. Record this in docs/internals.md §Reactive Watch Bridge.

## Edge cases & interactions

- **The common two-member case** — both members hold every collection's pend before any commit: the table's event waits for the index's commit, both fire together. Test (the plugin spec below).
- **Single-collection action**, including `Collection.sync` and the tail-then-sweep path and a mid-loop throw: one group, closed by its first landing, events fire at the end of the call as today. Verified by the existing `storage-repo.spec.ts` change-notification cases still passing unchanged.
- **Another collection's pend never commits here** (this member ahead or stale for it, or the writer gave up): the writer's `cancel` closes the group and releases; failing that, the timer. Test (cancel), test (timer).
- **The other collection is not in this node's cohort** (larger groups): no pend group here, nothing held — today's behaviour. By inspection; say so in the docs.
- **A pend delivered after another collection's commit already emitted** (a record owed to this member and delivered late): the first event was not held, and the late group holds nothing already emitted. Accepted residual; a `NOTE:` at the group-recording site.
- **A collection that lands after the timer released**: only its own collection's listeners fire, so the table's watchers are not woken a second time. Tripwire `NOTE:` at the timer: if gaps beyond `changeHoldMs` are ever seen, have the vtab also subscribe to its index collections (wake the table on any of them).
- **Re-delivered or retried pend of A over blocks overlapping an existing group**: extend that group, do not add a second one.
- **Batch record** (several collections of A in one consensus record): each operation's `commit` closes its group; the last releases. By inspection — no writer sends batches yet (`tickets/blocked/a-transaction-pends-and-commits-its-collections-together.md`).
- **Replica landing** (`saveReplicatedBlock`, which deletes A's pending for that block under Invariant P): closes the group by landing, through the same check as a commit.
- **Concurrent commits of two collections of A on one member**: both calls end with checks; the hold's state must be updated synchronously at each check so two releases cannot both fire the held events (release takes the held list and clears it in one synchronous step).
- **A listener added or removed while events are held**: dispatch to the listener set current at release time (`fireChangeListeners` already snapshots).
- **Invalidation and other events with no pend group** (`inv:` action ids): no entry, emitted at once.
- **Timer teardown**: unref'd, so a process or test is not kept alive; no `stop` hook is needed.
- **The writer's own node**: its local Quereus commit wakes its watchers precisely; the coarse storage wake is now possibly later, which is harmless.

## Tests

Storage tier, in `packages/db-p2p/test/storage-repo.spec.ts` (contract on branching logic):
- An action pends two collections (two `pend` calls under one action id, blocks with distinct `header.collectionId`); committing the first fires its per-collection listener nothing while the second's pend stands, while the catch-all fires for it at once; committing the second fires the first collection's event, then the second's.
- The same setup, then `cancel` of the second collection's blocks: the first collection's held event fires.
- The same setup with a small `changeHoldMs`: the first collection's held event fires when it elapses, with the second still pending.

Plugin tier, a two-node spec in `packages/quereus-plugin-optimystic/test/` (the reproduction): table `T (Id primary key, K)` with `index TByK on T (K)`, created on node 0, declared on node 1 the way the existing two-node specs do. Node 1 watches `select Id, K from T`. Node 0 inserts several rows one at a time. At every wake on node 1, look up the newest key both by primary key and through the index (`where K = ?`). Expected: at every wake where the primary-key lookup finds the row, the index lookup finds it too, and every row is seen through the index at some wake. To make it fail deterministically without the fix, node 1's apply of the index's commit must lag its apply of the table's: hold every cluster delivery to node 1 whose record (or a record it carries) holds a commit operation whose `tailId` is the index's log tail (read once on node 0 after setup with `Collection.readCommittedTail`), until a few hundred ms have passed or node 1's wake handler has run its lookup.

That needs three opt-in additions to the mesh harness (`packages/db-p2p/src/testing/mesh-harness.ts`), each off by default so no other spec changes:
- `BuildTransactorOptions.notifyLocalChanges` — give each node's `NetworkTransactor` its node's `storageRepo` as `localChangeNotifier`, as production gives it `node.blockChangeNotifier`. Without it the mesh transactor's change subscription is inert.
- `BuildTransactorOptions.selfFirstReads` — what the `NOTE:` above `buildNetworkTransactors` describes: a node's transactor answers `findCoordinator` with `intent: 'read'` by its own node when that node is in the key's cohort and not excluded, else defers to the mesh key network. Without it node 1's lookup may be served by node 0, which already holds everything, and the spec would pass without the fix.
- `MeshFailureConfig.onClusterDelivery` may return a promise, which `reach` awaits before the delivery proceeds.
`startMockMesh` in `packages/quereus-plugin-optimystic/test/mesh-node-harness.ts` passes them through when asked.

## Docs

- docs/internals.md §Change Notification (Reactive Wake): the hold, its bound, per-collection only, and what "emits exactly once" now means (once, possibly later). §Reactive Watch Bridge: index collections are still not watched; storage holds the table's wake until the action's other collections pending here land; the network-watch finding above.
- `IBlockChangeNotifier.onCollectionChange` doc (`packages/db-core/src/transactor/change-notifier.ts`) and `StorageRepo.emitCollectionChanges` doc: listeners may be invoked after a later call, or from the hold timer.
- The scope comment in `OptimysticVirtualTable.ensureChangeSubscription`.

## TODO

- Hold module: pure state for pend groups and held events per action, age-out, cap.
- `StorageRepo`: record groups in `pend`; route per-collection emission through the hold in `commit`, `cancel`, `saveReplicatedBlock`, `get` promotions; the open-group storage check; the timer; `changeHoldMs` option.
- `NOTE:`s: late pend delivery (group-recording site), release-then-late-landing tripwire (timer), restart forgets holds.
- Three storage-tier tests in `storage-repo.spec.ts`.
- Mesh harness: `notifyLocalChanges`, `selfFirstReads`, awaitable `onClusterDelivery`; pass-through in `startMockMesh`.
- Two-node plugin spec as above; confirm it fails with the hold disabled (`changeHoldMs: 0` cannot be set from the plugin side, so check by temporarily reverting the emission change) and passes with it.
- Docs as above.
- `yarn build`, then `yarn test` in db-p2p and quereus-plugin-optimystic; `yarn typecheck`.
