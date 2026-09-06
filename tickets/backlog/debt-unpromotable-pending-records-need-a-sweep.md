description: If a client crashes at the wrong moment, a storage node keeps a leftover "write in progress" marker forever, and the node then refuses every later write to that block. Nothing on the node ever cleans such a marker up.
files:
  - packages/db-core/src/transactor/network-transactor.ts (~line 589 — the best-effort background cancel after a failed pend)
  - packages/db-core/src/transactor/transactor-source.ts (~lines 163, 167 — the caller-driven cancel)
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.commit's doc comment, which already records this gap; cancel; dropUnpromotablePendings)
  - docs/repository.md (Invariant P, ~line 132)
difficulty: hard
repro: static
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

## Triage note (backlog gardening, 2026-09-01)

Added `repro: static` and `difficulty: hard`.

- **`repro: static`** — the body states plainly that no accumulation has been observed; the reasoning
  comes from the code and from the doc comments at `StorageRepo.commit` and
  `NetworkTransactor.pendPhase` that already name the gap. What would confirm it: kill a client
  between a refused pend and its background cancel, then assert the marker survives on every member
  and blocks the next write to that block.
- **`difficulty: hard`** — the ticket's own "What a fix has to answer" section is four open design
  questions (abandonment signal, where the sweep runs, whether members must agree, whether the client
  is hardened too), and the ticket says the wrong fix is worse than the leak.

## Arm: this has now been observed, and one candidate signal is ruled out (2026-09-04)

Filed from `fix/a-half-applied-commit-wedges-a-block-forever`, which reproduced an abandoned marker
**deterministically** on the in-process mesh harness — so `repro: static` above is no longer the whole
picture for the *class*, even though the two client-crash producers this ticket names are still
unobserved.

The producer found there is a third one, not covered by the two listed above:
`NetworkTransactor.commit` commits the collection's tail block first and then sweeps the remaining
blocks in a second call whose transport-shaped failure it deliberately **tolerates**, returning
`{ success: true }`. The writer is therefore told the write succeeded and never sends the cancel that
is the only cure. Every cohort member keeps the marker forever, and every later write to that block
is refused. That producer is being fixed at its own site by
`torn-commit-must-cancel-the-blocks-it-abandoned`, which is why this is an arm here rather than a
merge — but the cancel that fix adds is itself best-effort over the network, so this ticket remains
the backstop for when it does not arrive.

**The cheap signal this ticket hoped for does not cover that case.** The body above proposes "a record
whose revision the block has already passed can never be promoted, which is decidable locally with no
timing guess at all". In the reproduced instance the block sat at revision 1 while the orphaned marker
was for revision 2 — still nominally promotable, so a sweep on that rule finds nothing. Same for the
related idea in the `save`-path tripwire in `packages/db-p2p/src/storage/block-storage.ts`, which
anticipated orphans on blocks "whose committing action id differs": here the committing action id is
the *same* id as the orphan's, because the commit for that block simply never ran.

That leaves the two expensive options the body already lists — a time bound, or a cancel driven from
somewhere that knows the transaction is gone — and removes the cheap third. Worth knowing before the
design pass starts, because "decidable locally with no timing guess" was the reason to think this
might be easier than it looks.

## Arm: the client-side half named in "What a fix has to answer" is being fixed (2026-09-05)

Filed from `fix/a-reset-attempt-leaves-a-pend-the-retry-collides-with`, now promoted as
`implement/a-failed-attempt-must-discharge-its-own-pend`.

The body above asks, as one of its open questions, "whether the client side should be hardened too,
so a refused pend's cancel is retried rather than fired once into the background". That question is
now answered and is being implemented — but the measurement changes the picture for this ticket in
two ways worth recording before the design pass starts.

**The client side was worse than "fired once into the background".** `NetworkTransactor.cancel`
runs `processBatches`, which never rethrows, and — unlike `pend` and `commit` — follows it with no
`everyBatch` completeness check. A cancel whose every peer RPC failed **returns normally**. Verified
on the in-process mesh: all three members still held the record afterwards, and the call reported
nothing. So the two producers this ticket lists are joined by a third that needs no crashed client
at all — an ordinary transient stream reset during the cancel is enough, and nobody upstream ever
learns the cleanup did not happen.

**A retried, checked cancel covers the transient case, and only the transient case.** With the
cancel retrying inside `abortOrCancelTimeoutMs`, a 150 ms transport fault is absorbed and the next
attempt writes normally. What it does not cover is any fault that outlasts that budget, or a client
that dies mid-window — which is precisely the population this ticket exists for. That population is
now smaller and better characterised, not gone: the node-side sweep remains the only cure for a
record whose writer never comes back.
