description: A machine watching tables for changes checks every watched table on a timer (every 20–30 s), and each check still asks the other machines in the group over the network even when nothing has changed. Find a way for an idle check to cost no network request without giving up its role as the backstop for lost change notifications.
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/src/repo/coordinator-repo.ts
----

GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48), the part still open. The reporter (Taleus on Sereus) said what landed in 1.19.0 and 1.21.0 is enough for them; the maintainer wants the remaining idle requests gone.

## Where it stands

`ReactivityCollectionWatch` (`packages/db-p2p/src/reactivity/collection-watch.ts`) runs one timer for all watched collections, at the renewal cadence (30 s on a core host, 20 s on an edge host). Each tick:

- reads every watched collection's committed tail in one `CollectionTailReader.readTails` call per reader (one `transactor.get` while no tail moved);
- renews every registration in one `CohortTopicService.renewMany` call, so pings to one cohort member share a request (1.21.0).

On a node that holds the collections, the tail read is answered from its own copy, and that read starts a background consult of the cohort (`CoordinatorRepo`'s held-block consult): one `sync` request per cohort peer per 32 blocks. So an idle two-member group still sends one or two `sync` requests per tick per machine, plus the renewal, with nothing changed. The NOTE on `armTick` describes the cost.

## What the tick is for

The class comment says it: nothing in the push path is trusted to arrive. A notification can be lost, a registration can fail, the log can move to a new tail block that nobody announces, and a commit may never be announced at all. The tick turns each of those into at most one tick of delay. Whatever this ticket does must keep that bound, or state the new bound and why it is acceptable.

## Approaches to weigh (from the issue and the code comments)

- **Skip a collection's tail read on a tick when news about that collection has already arrived since the last tick**: a notification, or a local commit landing (the `StorageRepo` change event). The tick's job for that collection is already done. Note what this does not save: a truly idle collection, the case the issue measured, still reads every tick.
- **Read the tail for the tick from this node's own copy, without the cohort consult.** The consult is what crosses the network. The question is what the tick then still detects: a commit applied on this node shows in its own copy; one this node's storage missed, which is exactly what the backstop exists for, does not, until something else brings the copy up to date. Weigh whether the renewal reply, which already reaches the cohort each tick, could carry the current tail revision instead, so the backstop costs no request beyond the renewal.
- **Lengthen the read interval separately from renewal** (keeping renewal at TTL / 3). Cheaper, but it just widens the delay bound.

Pick one (or a combination), state the delay bound for each failure listed above, and say what a watcher on a machine that stores nothing of the table (a pure subscriber) gets, since there the tail read already goes over the network.

## Expected

- An idle two-member group with watched tables sends no request per tick beyond the renewal, or the ticket explains why one remains.
- The failure cases above are still recovered, each within a stated bound, with tests.
