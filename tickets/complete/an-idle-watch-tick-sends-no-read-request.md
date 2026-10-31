description: A machine watching tables for changes used to ask the other machines in its group on every 20–30 s check even when nothing had changed. The routine check now reads only this machine's own copy, the watch hears this machine's own storage changes directly, and only one check in ten (by default) asks the other machines.
prereq: a-read-can-skip-the-background-consult
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/reactivity/collection-watch.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, docs/reactivity.md, docs/internals.md
----
GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48), the remaining idle requests. Landed in `ticket(implement): an-idle-watch-tick-sends-no-read-request`.

## What was built

`ReactivityCollectionWatch` (`node.reactivityWatch`) changed in three ways:

- **Most ticks skip the background consult.** `CollectionTailReader.readTails` takes `CommittedTailReadOptions` (`{ skipWindowConsult }`), and `committedTailReader` passes it to `Collection.readCommittedTails`. On a node that stores the collections, an idle tick now sends no read request.
- **One consulting tick in `verifyEveryTicks`.** The default is `DEFAULT_VERIFY_EVERY_TICKS` = 10, and the value is validated as a positive integer. Each subscription counts the ticks that read it (`ticksSinceVerified`). A group's batched read consults when any of its members is due. When a consulting read's answer is applied (`acceptedTail(…, verified)`), every count it names restarts. The reads the service makes on events (first read, re-anchor, re-read after a registration lands) also consult and restart the count.
- **Local storage feed.** `localChanges` is the node's `StorageRepo`. Each subscription listens to it while open and unsubscribes synchronously on close. A local landing wakes the watchers whatever its revision. A notification or tail read wakes them only for a revision strictly above the newest one anything has woken them for (`wakeIfNewer`).

## Review findings

**Read first:** the implement diff, then the handoff. Checked the code in `collection-watch.ts` (the tick, `readGroup`, `acceptedTail`, `readTail`, `onLocalChange`, `onDelivered`, open/close of subscriptions), the node wiring, both new unit specs, the two integration-spec changes, and the docs.

**Deviation: a local landing wakes whatever its revision. Confirmed, kept.** The plan said `>=`. Wake-always is right for the two cases the implementer named: a held table event released after a later commit's, and non-tail blocks landing after a later tail. There is a third case the handoff did not list. A skip-consult tick reads the local copy, so it can see the table's new tail revision while that revision's per-collection event is still held for the index collections (`ActionChangeHold`). The tick then wakes on R, before a re-read could see the index. The held event's release is the wake that shows the whole commit, and only "wake whatever its revision" delivers it. The cost is an extra whole-table re-query, and it is documented.

**Correctness:**
- Cadence: the first read consults and sets the count to 0; ticks 1–9 skip; tick 10 consults. A failed or omitted answer leaves the subscription due on the next tick. An overtaken (dropped) verified answer always loses to a newer read that also restarts the count: tick reads are serial, and `readTail` always consults. Verified by reading the code; the cadence spec pins it.
- Collection id: the plugin passes `getCollectionId(options)`, the same id as `header.collectionId` on the `StorageRepo` event. So the local feed matches the watch's id.
- Resource cleanup: `closeSubscription` and `stop()` release the storage listener synchronously, and the spec asserts it. `onLocalChange` also guards `closed`.
- The flag reaches every layer: `NetworkTransactor` forwards `skipWindowConsult` to remote repos, and `CoordinatorRepo` skips only the window-only consult. A floor-demanded or missing-block consult still runs.
- `onDelivered` no longer wakes for a revision already woken for. The manager delivers only verified, in-order notifications, so the only wakes this removes are redundant ones.
- Integration specs: `ReactivitySubscriberRegistry.register` supports several handlers per topic. So the test's frame counter sits beside the watch's handler and does not replace it.

**Tests:** the two new unit specs pin behaviour that branches: the consult cadence, including a collection joining mid-cycle, and the local-versus-notification wake rules. Both meet the bar, and none were cut. No test was added: no defect was found, and the `RangeError` guard is a plain argument check.

**Docs:** `docs/reactivity.md` covers the tick, the storage feed, the cost and the delay bounds. `docs/internals.md` covers *Double wake* and the watch-service paragraph. Both match the code. V = 10 × T works out to 300 s on Core and 200 s Edge, as stated. The backlog ticket the docs cite, `feat-a-renewal-reply-carries-the-tail-revision`, exists. `yarn lint:docs` is clean.

**Source hygiene:** `collection-watch.ts` is 772 lines (`wc -l`). It is one cohesive class, and the new code splits into small methods. No split is warranted for this change. Comments explain why, not what.

**Performance / scalability:** the existing tick-cost `NOTE:` on `armTick` was updated, and it still covers the case of hundreds of watched collections. Nothing new to add.

**Tripwires / new tickets:** none filed. The handoff's known gaps are accepted as documented: wake counts on a node holding a tagged Quereus table, `localChanges` bound to `storageRepo` at construction, and a local event before the first read.

**Major findings:** none.

**What was run:** eslint on the changed source and spec (clean), `yarn lint:docs` (clean), and `yarn test` in db-p2p (3566 passing, 74 pending). Not re-run here: the integration specs (the implementer ran both targeted cases with `OPTIMYSTIC_INTEGRATION=1`), the full `yarn test:integration` fan-out, and the quereus-plugin unit suite (no plugin source changed).
