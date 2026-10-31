description: A machine watching tables for changes checks every watched table on a timer (every 20–30 s), and each check still asks the other machines in the group over the network even when nothing has changed. Make the routine check read only this machine's own copy, hear this machine's own storage changes directly, and ask the other machines only on every tenth check, so an idle check costs no request beyond the registration renewal.
prereq: a-read-can-skip-the-background-consult
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`, `CollectionTailReader`, `committedTailReader`, `armTick`, `tick`, `readGroup`, `onDelivered`, `wakeIfNewer`), packages/db-p2p/src/libp2p-node-base.ts (the `new ReactivityCollectionWatch` site), packages/db-core/src/transactor/change-notifier.ts (`IBlockChangeNotifier`, `CollectionChangeEvent`), packages/db-p2p/test/reactivity/collection-watch.spec.ts, docs/reactivity.md, docs/internals.md
----
GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48), the part still open. The reporter (Taleus on Sereus) said what landed in 1.19.0 and 1.21.0 is enough for them; the maintainer wants the remaining idle requests gone.

## Where it stands

`ReactivityCollectionWatch` runs one timer for all watched collections at the renewal cadence (T = 30 s Core, 20 s Edge). Each tick renews every registration in one `renewMany` call and reads every watched collection's tail in one `readTails` call per reader. On a node that holds the collections (every member of a group no larger than one cohort) the read is answered locally, but because it is always past the 10 s read-repair window it starts a background cohort consult: one or two `sync` requests per tick per machine with nothing changed. The `NOTE:` on `armTick` describes that cost.

## Decision

Three parts, chosen over the alternatives listed at the end.

**1. The routine tick reads without the consult.** Every tick's batched read passes `skipWindowConsult: true` (prereq ticket), except a **verified** tick, below. On a holding node the read is then answered from its own copy with no request. `CollectionTailReader.readTails` gains an optional second argument, `{ readonly skipWindowConsult?: boolean }`, which `committedTailReader` hands to `Collection.readCommittedTails`. A host's own reader that ignores it stays correct (it just keeps paying the consult).

**2. A verified read every N ticks.** A group's read is an ordinary (consulting) read when any subscription in it has gone `verifyEveryTicks` ticks (new option on `ReactivityCollectionWatchOptions`, default 10) since its last verified read; a verified read resets the count for every subscription it named. A new subscription starts at zero, because its first read (`checkTail`) is already a full read. The event-driven single reads — the first read, `reAnchor`'s re-read after an unservable gap, `moveThenRecheck`'s re-read after a registration lands — stay full reads: they are rare and each follows a reason to doubt. A subscription that sits a verified tick out (`tickQueued`) is simply still due on its next tick.

**3. The service hears this node's own storage changes.** New optional option `localChanges?: Pick<IBlockChangeNotifier, 'onCollectionChange'>`; the node passes its block change notifier (the per-collection feed of `StorageRepo`, whose events are held until the action's other collections pending here have landed). Each subscription subscribes when it opens and unsubscribes when it closes. On an event: wake the listeners when `event.rev >= sub.lastSeenRevision` (then set `lastSeenRevision = max(...)`). Note the `>=`: a local landing is the moment this node's copy can show a revision, so it wakes even for a revision a notification already announced — on a holding node the network notification routinely arrives before the local apply, and a watcher that re-queried its local replica on the notification saw the old data. Notifications and tail reads keep waking only on a strictly newer revision; change `onDelivered` to go through `wakeIfNewer` (today it wakes unconditionally), so a notification for a revision a local landing already woke for is not a second wake. The feed does not follow tails; the tick and notifications still do that.

## Delay bounds (T = tick interval, V = `verifyEveryTicks` × T, 5 min Core / 200 s Edge by default)

On a node that stores the collection (the two-member case):

| Failure | Before | After |
|---|---|---|
| Lost notification, commit applied here | ≤ T | at once (local event); ≤ T if the event is missed |
| Commit never announced, applied here | ≤ T | same as above |
| Failed registration | retried next tick, watcher woken by the tick | unchanged; watcher woken by the local event |
| Tail rotation nobody announced | ≤ T | ≤ T (the local copy holds the header) |
| Commit this node's storage missed AND its notification lost | 2T (T + latency with the Quereus storage listener) | at once when storage brings the copy current — the under-replication drain on reconnect for a commit acknowledged below `full`, reconcile on the next commit, or any read's window consult — and at worst ≤ V + one consult, through the verified tick's consult and the local event its repair emits |

Why the last row is acceptable: in a two-member group a commit acknowledged `full` is held by both members, and one acknowledged below `full` names the missing member in the coordinator's ledger, which the drain pushes to as soon as it connects. Reaching the V bound needs that path to have failed too.

On a node that stores nothing of the collection (pure subscriber): its tail read already goes over the network, so the tick still costs one read request per coordinator plus the renewal. The flag rides to the coordinator, which now answers from its copy without consulting behind it (that saves requests between storage machines, not the subscriber's). Bounds as for a holding node minus the local event: ≤ T when the answering coordinator holds the commit; ≤ V + T when it missed it. Removing the subscriber's read request is backlog `feat-a-renewal-reply-carries-the-tail-revision`.

Idle cost after this, two-member group, per machine: the renewal (no request when the registrations' primary is this node, one per tick otherwise), plus on one tick in ten the consult round (one request per peer per 32 blocks, two blocks per collection). That tenth-tick request is the one that remains, and it is what keeps a bound on the double failure in the last row.

## Rejected

- **Skip a collection's read on a tick when news about it already arrived.** Saves nothing for an idle collection, the case measured, and a holding node's read is now free anyway.
- **Lengthen the whole read interval.** Widens every bound, including the ones that need no network at all.
- **Renewal reply carrying the tail revision.** Changes the cohort-topic wire (`RenewV1`, `renew-batch`) and the application-agnostic member engine; gives a holding node nothing when its registrations' primary is itself (in a two-member group that is one of the two machines for every registration, since the slot does not depend on the topic). Worth it only for pure subscribers — parked in backlog.

## Edge cases & interactions

- Verified-tick cadence across reader groups, including a subscription that joins mid-cycle and one that sat a tick out — verified by test (cadence contract).
- Local event for a revision below `lastSeenRevision` (an older replica landing): no wake — by inspection.
- Local event at a revision a notification already woke for: wakes again — verified by test; notification after a local wake at the same revision: no wake — verified by test.
- A tick reading the revision a local event already woke for: no wake — covered by the same test.
- Held events (table waiting for its index collections): the wake arrives when the commit is consistent here — by inspection; better than the network wake (backlog `feat-a-network-watch-wake-sees-the-whole-commit` unchanged).
- Close during an in-flight registration / `stop()`: the local subscription is released synchronously in `closeSubscription` — by inspection.
- A listener throwing: `notify` already isolates it.
- `localChanges` absent (tests, hosts without storage): behaviour is the tick alone.
- Quereus plugin: unchanged code. Its tables already subscribe to local storage themselves, so a holding node still sees two wakes per remote commit (its own storage listener, and the watch service's), the same count as today's storage-plus-network double wake documented in internals.md. Do not try to remove the plugin's own subscription here.
- Rotation scheduler and `reRegister`: untouched.
- Doubt memo on the local copy: the unflagged-consult read still returns `unconfirmedAheadRev`, and `NetworkTransactor.get` sends a second-chance request to the other member; that is a request only when doubt already exists.

## Tests

In `packages/db-p2p/test/reactivity/collection-watch.spec.ts` (fake timers and reader doubles already there):

- cadence: a reader double records the options of each call; the first read is a full read, ticks 1..N−1 pass `skipWindowConsult: true`, tick N does not (use `verifyEveryTicks: 3`).
- local feed: a fake `localChanges`; an event at revision R wakes once; a tick reading R does not wake again; a notification at R after that does not wake; with the order reversed (notification at R, then event at R) both wake.

Existing specs covering lost notifications, failed registrations and rotations must still pass (they ran through the full read; check whether they need the flag-aware reader double). No mesh-level request-count test: the prereq's spec pins that the flag starts no consult, and the cadence spec pins when the flag is sent.

## Docs

- `docs/reactivity.md` §The node's watch service: the tick bullet, "What a tick costs" (the per-tick consult goes; one in `verifyEveryTicks` ticks remains), "How long a missed commit can go unseen" (the table above, in prose), and a bullet for the local storage feed.
- `docs/internals.md` *A host subscribes through `node.reactivityWatch`*: the "It costs one read per tail reader per tick" sentence.
- The module doc and the `armTick` `NOTE:` in `collection-watch.ts`.

## TODO

- Add `skipWindowConsult` options to `CollectionTailReader.readTails` and `committedTailReader`.
- Per-subscription verified-read counter and `verifyEveryTicks` option; pass the flag from `readGroup`.
- `localChanges` option: subscribe in `openSubscription`, release in `closeSubscription`, wake on `rev >= lastSeenRevision`.
- `onDelivered` through `wakeIfNewer`.
- Wire `localChanges` at the `new ReactivityCollectionWatch` site in `libp2p-node-base.ts` (the node's block change notifier in scope there).
- Specs above; adjust existing specs only where the reader double needs the new argument.
- Doc updates above; `yarn lint:docs`.
- Build, `yarn test` in db-p2p; `yarn test:integration` for the reactivity integration specs if time allows (report if skipped).
