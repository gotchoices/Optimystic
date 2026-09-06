description: When a write is rejected because a newer version already exists, the client refreshes to catch up — but that refresh can be answered by an out-of-date machine, so the client learns nothing and its write can never succeed. Let the refresh insist on an answer at least as new as the version it was already told about.
prereq:
files: packages/db-core/src/collection/collection.ts (updateInternal), packages/db-core/src/network/struct.ts (BlockGets.context), packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-p2p/src/repo/coordinator-repo.ts
difficulty: hard
tradeoffs: A read that can be refused for being too old is a new failure mode on the most heavily used path in the system, and a client that demands a version nobody can serve gets a hard error where today it merely gets an old answer — which may be worse for availability than the wedge it fixes.

# Let a refresh demand an answer no older than a revision it has already been told about

## The gap

A client that loses a write is told, in the rejection, the revision the responder actually holds
(`StaleFailure.staleAt`). It then refreshes to catch up. That refresh reads "latest" —
`Collection.updateInternal` builds a `TransactorSource` with no action context, so the read is
served by whichever peer answers, at whatever revision that peer happens to hold.

If the peer that answers is behind the peer that rejected the write, the refresh learns nothing.
The client's revision does not move, the next write asks for the same taken number, and the loop
repeats. There is no way to say "I already know revision 9 exists; do not answer me with revision 8."

`BlockGets.context` exists and is honoured, but it **pins** a read to a revision (materialize as of
this moment) rather than setting a **floor** (answer only if you are at least this current). Those
are different requests and the second one has no representation on the wire today.

## Why it matters

This is the difference between a write that fails fast and a write that can succeed. The sibling
work `implement/sync-fail-fast-on-a-stalled-revision-view` makes the wedge detectable and turns a
~21 s livelock into a sub-second named error, which is strictly better — but it deliberately does
not, and cannot, make the write land. Making the refresh authoritative is what would.

Two known consumers of that outcome:

- A downstream project (`sereus`) has a control-database scenario that fails roughly one case in ten
  because of exactly this: the node that rejects the write is the node holding the newer revision,
  and the refresh is answered by its sibling, which is not.
- The upstream fix for coordinator selection being poisoned at boot
  (`coordinator-cache-poisoned-by-boot-time-self-selection`, landed 2026-08-01) reduced but did not
  remove the problem, because which peer answers a read is still a race even with a healthy cache.

## What a design would have to settle

- **How a floor travels.** A new optional field on the read request, distinct from `context` — and
  what an older peer that does not understand it does when it arrives.
- **What a peer that cannot meet the floor does.** Refuse (and let the transactor try another peer),
  or answer with a marker saying how far behind it is. Refusal is a new failure mode on the hottest
  path in the system; that is the main cost.
- **What the client does when no peer can meet the floor.** A confirmed revision that nobody will
  serve is itself diagnostic — it may mean the confirming peer is partitioned, or that the client is
  on a forked lineage where the number it holds was never assigned by this cluster.
- **Whether this belongs to reconciliation instead.** On a genuinely forked lineage, a floor-read
  does not help: both sides are internally consistent and neither is behind the other. Fork handling
  is owned by `backlog/more-design/6.5-partition-healing`; this ticket is the *lag* half, and the
  boundary between them needs to be stated before either is built.
