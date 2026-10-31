description: A machine watching tables for changes used to ask the other machines in its group on every 20–30 s check even when nothing had changed. The routine check now reads only this machine's own copy, the watch hears this machine's own storage changes directly, and only one check in ten (by default) asks the other machines; review the change and its delay bounds.
prereq: a-read-can-skip-the-background-consult
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`, `CollectionTailReader`, `committedTailReader`, `readGroup`, `acceptedTail`, `onDelivered`, `onLocalChange`, `DEFAULT_VERIFY_EVERY_TICKS`), packages/db-p2p/src/libp2p-node-base.ts (the `new ReactivityCollectionWatch` site), packages/db-p2p/test/reactivity/collection-watch.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, docs/reactivity.md, docs/internals.md
----
GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48), the remaining idle requests.

## What changed

`ReactivityCollectionWatch` (the node's collection watch service, `node.reactivityWatch`) runs one timer for every watched collection, at the renewal cadence (T = 30 s Core, 20 s Edge). Each tick renews registrations and reads every watched collection's committed tail. On a node that stores the collections, that read was answered locally but always started a background cohort consult (one or two `sync` requests per tick to the other member of a two-member group). Three parts:

- **Most ticks skip the consult.** `CollectionTailReader.readTails(queries, options?)` takes `CommittedTailReadOptions` from db-core (`{ skipWindowConsult?: boolean }`); `committedTailReader` hands it to `Collection.readCommittedTails`. A reader that ignores it stays correct.
- **One consulting tick in `verifyEveryTicks`.** New option on `ReactivityCollectionWatchOptions`, default `DEFAULT_VERIFY_EVERY_TICKS` = 10, validated as a positive integer (throws `RangeError`). Each subscription counts the ticks that have read it (`ticksSinceVerified`, incremented in `tick()` for every subscription the tick reads). A group's batched read consults when any member's count has reached `verifyEveryTicks`; otherwise it passes `skipWindowConsult: true`. The count restarts when a consulting read's answer is **applied** (`acceptedTail(…, verified)`), for every subscription that read named. So a consulting read that fails, or leaves a collection out, leaves it due on the next tick. The event-driven single reads (`readTail`: the first read, `reAnchor`, the re-read after a registration lands) are consulting reads and restart the count as well, which is how "a new subscription starts at zero" falls out.
- **Local storage feed.** New option `localChanges?: Pick<IBlockChangeNotifier, 'onCollectionChange'>`. The node passes its `storageRepo` directly (not `node.blockChangeNotifier`, which the cohort bridge decorates; its `onCollectionChange` delegates to the same `storageRepo`). Each subscription subscribes in `openSubscription` and unsubscribes synchronously in `closeSubscription`. `onDelivered` (notifications) now goes through `wakeIfNewer`: it wakes only for a revision strictly above `lastSeenRevision`.

### Deviation from the plan: a local landing wakes whatever its revision

The plan said wake on `event.rev >= lastSeenRevision`. `onLocalChange` wakes on **every** local event, and raises `lastSeenRevision` to `max(lastSeenRevision, event.rev)`. A lower revision is still a change that is new to this node's copy, in two cases I found:

- A table's event held until its index collections land (`StorageRepo.emitCollectionChanges`) can be released after a later commit's event. Example: rev 5 inserts a row (table + index), and rev 6 updates a non-indexed column (table only). Rev 6's event fires unheld. Rev 5's held event is released when its index lands, and that is the moment a local re-read sees rev 5's index entry.
- Non-tail blocks of a commit landing after a later revision's tail (the tail-then-sweep path).

With `>=` neither would wake, so the watcher would keep a view missing the index entry until some later change. An extra wake costs one re-query (whole-table invalidation), the asymmetry `docs/internals.md` *Change Notification* already states. In practice an event below `lastSeenRevision` is rare, so the cost is negligible. Reviewer: confirm or revert. Reverting means changing one guard in `onLocalChange`, the edge-case wording in its doc comment, and the "This node's own storage" bullet in `docs/reactivity.md`.

## Use cases to validate

- **Idle two-member group:** a node that stores its watched collections sends no read request on ticks 1–9 and the consult round on tick 10. Renewals are unchanged: none when the registrations' primary is this node, one per tick otherwise.
- **Lost notification, commit applied here:** the watcher wakes when the commit lands locally, without waiting for a tick.
- **Notification before the local apply** (the usual order on a holding node): the notification wakes, then the local landing wakes again, so a re-read after the second wake sees the data.
- **Commit this node's storage missed, and its notification was lost:** the watcher wakes when storage repairs the copy (under-replication drain, reconcile on the next commit, any read's consult). At worst that is ≤ V + one consult, where V = `verifyEveryTicks` × T (5 min Core / 200 s Edge).
- **Pure subscriber** (stores nothing of the collection): still one read request per coordinator per tick. The flag rides to the coordinator, which skips its own consult. Bound is ≤ T when the coordinator holds the commit, ≤ V + T when it missed it.

## Tests

Added, in `packages/db-p2p/test/reactivity/collection-watch.spec.ts`:

- **"a tick consults only when a collection it reads is verifyEveryTicks ticks past its last consulting read, which restarts every count it names"** — two collections share one reader, with `verifyEveryTicks: 3`; the second joins mid-cycle. Pins the exact call sequence and which calls consult: the first read and the post-registration re-read consult, tick 1 skips, the join's reads consult, tick 2 skips, tick 3 consults (the first collection is due) and restarts both counts, tick 4 skips.
- **"a change landing in local storage wakes even for a revision a notification already woke for, and a notification or tick read after it does not"** — landing at R wakes; a tick reading R does not; a notification at R does not. Reversed order: a notification at R+1 wakes and the landing at R+1 wakes again. Closing the last handle leaves no local listener (one assertion, for the release in `closeSubscription`).

The `tailReader` double now records whether each call consulted, and `attachedWatch` / `registeredWatch` take extra options. Existing specs passed unchanged.

Changed integration specs. On a watcher that stores the collection, the new storage feed can now explain a wake that came with no tail read, so "woke with no tail read" no longer proves the notify socket carried the commit. Both specs now also count frames delivered to the watcher's `reactivitySubscribers` for the topic, and require one:

- `substrate-real-libp2p.integration.spec.ts`, "collection watch over real libp2p (every machine in every cohort)". Its `countedTailReader` also forwards `options`.
- `quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts`. Its `countTailReads` monkeypatch also forwards the new third argument of `Collection.readCommittedTails`. Its premise "the watcher's `blockChangeNotifier` is inert, so no storage wake" now holds only for the table's own listener, and the header comment says so.

## What was run

- `yarn build` (db-p2p), `tsc --noEmit` (db-p2p, includes tests), `yarn typecheck` (quereus-plugin-optimystic), eslint on the changed files, `yarn lint:docs`: all clean.
- `yarn test` in db-p2p: 3566 passing, 74 pending.
- Integration, targeted, with `OPTIMYSTIC_INTEGRATION=1`: both db-p2p "collection watch over real libp2p" cases pass (≈5 s each), and the Quereus network-change-notification spec passes (51 s).
- **Not run:** the full `yarn test:integration` fan-out, and the quereus-plugin unit suite (no plugin unit spec builds a cohort-topic node, and no plugin source changed).

## Known gaps and things to look at

- No mesh-level request-count test, as the plan decided: the prereq's spec pins that the flag starts no consult, and the cadence spec pins when the flag is sent.
- **Wake counts on a holding node that watches a tagged Quereus table:** two or three wakes per remote commit. Before this change it was two. The three are the table's own storage listener, the service's landing wake, and the notification when it arrives before the local apply. Documented in `docs/internals.md` (*Double wake from storage and network*) and `docs/reactivity.md`. The plan said not to remove the plugin's own subscription here.
- Because `localChanges` is bound to `storageRepo` at construction, overriding `node.blockChangeNotifier` after startup (only tests do this) does not silence the watch service's local feed.
- A local event before the first tail read raises `lastSeenRevision`, so the first read may not wake again for that revision. Notifications already behaved this way. The module doc's "What a watcher is promised" now says so.
- The rotation scheduler, `reRegister`, renewal and the subscription manager are untouched.
