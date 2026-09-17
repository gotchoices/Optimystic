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

## Evidence added 2026-09-17 — a second consumer, and a floor that needs no wire change

`refreshed-collection-caches-a-block-older-than-its-log-entry` (now in `implement/`) is a measured instance of the same gap on a *data block* read rather than the refresh's tail read: a collection walks a log entry saying revision 7 changed block X, re-reads X pinned at 7, is served X materialized at 6 (a self-coordinated read inside the read-repair window), and caches it with no expiry. There the floor is already known on the client (the entry's revision) and the answer already reports the revision it was materialized at, so the too-old answer is detectable with no protocol change. That ticket takes the client-side check; whether a floor should also travel on the request — this ticket's subject — is left open there and should be settled with it.

## Arm added 2026-09-17 — the storage-side half of that instance is left here

The fix-stage investigation of that ticket split the work three ways. Two parts went to `implement/`: the collection never keeps an answer older than the log entry that changed the block (`refreshed-collection-caches-a-block-older-than-its-log-entry`), and the client-side transactor retries such an answer against a different coordinator (`a-too-old-block-answer-is-retried-against-another-machine`). Both work with no wire change and close the hole whatever the reason a coordinator served old content. The third part — removing the reason — was **deliberately left to this ticket**, because it is the wire-level floor this ticket is about:

- **The cause.** `CoordinatorRepo.get` (`packages/db-p2p/src/repo/coordinator-repo.ts`, the `isStale = !isMissing && this.shouldReadRepair(blockId)` decision) lets a time stamp suppress the cohort consult for a block it holds. The stamp means "this block matched the cohort at some past moment"; it knows nothing about the revision the *reader* has since learned of. In the trace, B's stamp was 2.1 s old when a read arrived whose log entry said the block changed at revision 7 while B held revision 6.
- **Why `context.rev > localRev` cannot be the trigger.** A block legitimately lags its collection's revision whenever later revisions did not touch it, so that test would consult on nearly every read and undo the window.
- **Two shapes that would work.** (a) Carry the client's per-block floor on the read request (the companion implement ticket adds the field to `BlockGets` but does not forward it to the repo); the repo consults when the floor is above its local revision regardless of the stamp. (b) Without a wire change: keep, with the stamp, the highest context revision it was earned under, and consult when a read arrives above it — one consult per block per new revision, only for blocks a reader actually re-reads. Either way the repo must remember the floor (or context revision) it last consulted under, or a log entry whose blocks never landed (`backlog/bug-a-refused-write-can-leave-its-log-entry-behind`) would force a consult on every read of that block forever.
- **What an old peer does with shape (a).** It ignores the unknown field and serves as today; the client-side check and retry from the two implement tickets still catch the answer. So the field can be added without a version gate.
- **Acceptance test if taken:** in `packages/db-p2p/test`, block present at local revision 6, stamped fresh, read carrying floor 7 (or pinned at 7 above the stamp's recorded revision) → the consult fires; a second identical read inside the window does not consult again.
- **Related debt:** `debt-freshness-state-scattered-across-coordinator-repo` — the stamp gaining a second field is a reason to do that consolidation first.

What this arm buys once the two implement tickets have landed is cost, not correctness: it saves the reader one retry round trip per changed block while its own replica lags, and it fixes the replica at the moment of the read instead of at window expiry. The original subject of this ticket — the refresh's *tail* read answered by a lagging machine — is not helped by either implement ticket and remains open here.
