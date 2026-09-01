description: If a client crashes at the wrong moment, a storage node keeps a leftover "write in progress" marker forever, and the node then refuses every later write to that block. Nothing on the node ever cleans such a marker up.
files:
  - packages/db-core/src/transactor/network-transactor.ts (~line 589 — the best-effort background cancel after a failed pend)
  - packages/db-core/src/transactor/transactor-source.ts (~lines 163, 167 — the caller-driven cancel)
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.commit's doc comment, which already records this gap; cancel; dropUnpromotablePendings)
  - docs/repository.md (Invariant P, ~line 132)
severity: wrong-result
likelihood: unusual
tradeoffs: Cleanup depends entirely on a client that may never come back, so any fix has to guess when a marker is abandoned rather than in-flight — and guessing too eagerly deletes a live write, which is worse than the leak it cures.

# A node has no way to clean up an abandoned pending record

## The plain version

Writing to a block happens in two steps. First the node stores a marker saying "a write for this
block is on its way" (a **pending record**). Then, once the write is agreed, the marker is turned
into a real, numbered revision and disappears.

If the write is refused instead, the marker is supposed to be deleted — but the only thing that
deletes it is the **client**, by sending a cancel. So the cleanup of node-side state depends on a
process the node does not control and cannot wait for.

When the client never sends that cancel — it crashed, its network dropped, or the background cancel
it fired off simply failed — the marker stays on the node forever. From then on that node treats the
marker as a live competing write and refuses every later write to that block. It keeps serving reads
and looks perfectly healthy while contributing nothing to that block's writes. A block whose nodes
accumulate these degrades toward being unwritable.

## How a marker gets abandoned

Two known paths, both already understood and documented in the code:

- **A stale commit.** The node is already ahead of the revision the write is for, so it refuses the
  commit and keeps the pending record on purpose — the cure is the client's cancel, routed through
  consensus so every member of the group drops it. A client that dies between receiving the refusal
  and sending the cancel strands the record on every member. `StorageRepo.commit`'s doc comment
  states this outcome explicitly and calls it pre-existing.
- **A refused pend.** `NetworkTransactor.pendPhase` fires the cancel as a *background, best-effort*
  microtask whose failure is only logged. If it fails, the markers it was meant to remove stay.

The commit path already deletes records it knows can never be promoted, but only in the narrow case
where the whole batch is about to be reconciled from a peer (`dropUnpromotablePendings`). Nothing
covers the abandoned-client case.

## What this ticket is not

It is **not** the check-then-act bug in `StorageRepo.pend`, where the node itself wrote a marker for
a revision that had already been taken. That is fixed separately by
`bug-pend-can-strand-a-permanent-write-block`, which makes the node incapable of writing an
unpromotable marker in the first place. This ticket is the leftover class that fix deliberately does
not touch: markers the node wrote correctly, for a write that then walked away.

## What a fix has to answer

The hard part is not the sweeping, it is deciding what counts as abandoned. A marker for a write
that is genuinely still in flight must never be removed — deleting a live one makes the write's
commit fail with a missing-pend error, which the cluster layer treats as this node having diverged
and repairs by copying the whole block from a peer. That is a much more expensive mistake than the
leak.

Things a design would need to settle:

- **What makes a record abandoned.** Age alone is crude but may be enough if the threshold is set
  well past any legitimate pend-to-commit span. A cheaper and more precise signal may exist: a
  record whose revision the block has already passed can never be promoted, which is decidable
  locally with no timing guess at all. Whether that covers enough of the abandoned population to be
  worth it is the open question.
- **Where it runs.** A periodic pass over stored pending records, versus an opportunistic check the
  next write to the block performs anyway (that write is already reading the block's revision and
  already enumerating its pending records, so the comparison may be free).
- **Whether members must agree.** Cancel currently goes through consensus so the whole group drops
  the record together. A purely local sweep would let members diverge on which records exist, which
  matters for the rival-pend check that votes on new writes.
- **Whether the client side should be hardened too**, so a refused pend's cancel is retried rather
  than fired once into the background.

## Why it is filed rather than fixed

Nobody has observed an accumulation in practice; the reasoning is from the code and from the
existing doc comments that already name the gap. The window is real but narrow, and the wrong fix is
actively harmful, so this wants a deliberate design pass rather than an opportunistic patch.
