description: A machine that watches a table over the network without storing any of it still sends one read request per watched-table check (every 20–30 s) on top of its registration renewal; letting the renewal's answer say what revision the table is at would make that read unnecessary when nothing changed.
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`), packages/db-core/src/cohort-topic/service.ts (`CohortTopicService.renewMany`), packages/db-core/src/cohort-topic/member-engine.ts (`CohortMemberEngine`), packages/db-core/src/cohort-topic/registration/renewal.ts, packages/db-p2p/src/cohort-topic/protocols.ts
tradeoffs: It changes the cohort-topic renewal wire and gives the application-agnostic member engine an application hook, to save one request per tick only on machines that store nothing of the tables they watch; machines that store the tables already read for free after `an-idle-watch-tick-sends-no-read-request`.
----
Follow-up to `an-idle-watch-tick-sends-no-read-request` (GitHub #48).

After that ticket, a watching machine that stores the collection reads its tail from its own copy each tick, at no network cost. A machine that stores nothing of the collection (a pure subscriber, e.g. an edge node outside the table's storage group) still sends each tick:

- one renewal request per distinct registration primary, and
- one tail read request per coordinator its tail blocks map to.

For a registration at the root, the primary is a member of the tail block's storage group (the reactivity root group is that storage group), so it holds the tail block and could report the collection's committed revision and tail id in its renewal answer. The watch service would then wake and do a full read only when the reported revision is above the last one it woke for, or the reported tail differs.

## Expected

- An idle pure subscriber whose registrations sit at the root sends only the renewal per tick.
- The answer is advisory, judged like any single machine's read: an over-report costs one read; an under-report is bounded by the watch service's periodic verified read.
- A primary on an older build sends no revision, and the subscriber falls back to the tick's read.
- Registrations below the root (primary not in the storage group) keep the read.

Open points for planning: how the member engine obtains the revision (an injected per-application callback in the host), whether the plain `register` renewal path and `renew-batch` both carry it, and the wire version.
