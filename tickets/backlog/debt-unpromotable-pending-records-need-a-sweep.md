description: If a client crashes at the wrong moment, a storage node keeps a leftover "write in progress" marker forever, and the node then refuses every later write to that block. Nothing on the node ever cleans such a marker up.
files:
  - packages/db-core/src/transactor/network-transactor.ts (`pend`'s awaited cancel, and `dischargeCancel` — the retried, checked cancel that bounds the client-side hole)
  - packages/db-core/src/transactor/transactor-source.ts (`dischargePend` — the caller-driven cancel on both of `transact`'s abort paths)
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.commit's doc comment, which already records this gap; cancel; dropUnpromotablePendings)
  - docs/repository.md (Invariant P, ~line 132)
difficulty: hard
repro: static
severity: wrong-result
likelihood: normal-use
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

## Arm: the client-side half has LANDED — two statements in the body above are now stale (review, 2026-09-05)

`implement/a-failed-attempt-must-discharge-its-own-pend` landed in commit `28349d2`. Two things this
ticket says about the client are no longer true of the code, and a reader planning the node-side
sweep should not design against them:

- The body's "How a marker gets abandoned → **A refused pend**" bullet says the cancel is fired as a
  background, best-effort microtask whose failure is only logged (and names a method,
  `NetworkTransactor.pendPhase`, that does not exist — the site is `NetworkTransactor.pend`). It is
  now **awaited**, and the cancel underneath it retries and verifies that some peer actually
  answered, throwing when it could not.
- The last bullet of "What a fix has to answer" — "whether the client side should be hardened too,
  so a refused pend's cancel is retried rather than fired once into the background" — is **answered
  and done**. It is no longer an open design question for this ticket.

What remains for this ticket is exactly the residual the 2026-09-05 arm above describes: a fault
that outlasts the client's retry budget (six rounds, ~0.6–1.25 s of backoff, inside
`abortOrCancelTimeoutMs`), or a client that dies mid-window. The client now *reports* that it failed
to discharge, so a node-side sweep can be designed knowing the client-side hole is closed for
transient faults and only the abandoned-writer population is left.

## Arm, 2026-09-06 — the residual this ticket owns has now been OBSERVED, not just reasoned about

The header says `repro: static`. The mechanism below is still reasoned rather than reproduced
in-repo, but its *consequence* has now been measured on a real deployment, which is worth recording
before someone weighs the `tradeoffs:` line again.

**Where.** Eight isolated rounds of `control-write-degraded-cohort-member.integration.ts` in the
sibling `../sereus` checkout, run against this repo's `main` immediately after
`complete/1-a-failed-attempt-must-discharge-its-own-pend` landed. That fix makes a failing attempt
await its own cancel and makes `cancel` throw rather than silently returning undischarged.

**What the run shows, in order:**

```
Control write [self-record-update] failed non-transiently on attempt 1/3, not retried here:
  Some peers did not complete: 12D3KooW…[blocks:1](in-flight) cause=The stream has been reset
  cause: StreamResetError: The stream has been reset
  cancelError: [Error]                       <- the new field from TransactorSource.transact
...
Control write [peer-remove] failed non-transiently on attempt 1/3, not retried here:
  SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10 retries:
  pending conflict: block(s) held by unresolved rival action(s) yRfPLIpAdguxZUfWV8U9YA
```

`cancelError` present is the client-side hole reporting itself exactly as designed: the transport
fault that killed the commit also killed the cancel, so the pend was left standing and the new
contract said so instead of hiding it. The `pending conflict` two operations later is that same
standing record refusing a later, unrelated write — which is what this ticket is about.

**What that does and does not establish.**

- It does **not** reproduce this ticket's stated trigger. The body describes a client that *crashes*
  and never comes back. Here the client is alive and simply could not reach anyone with a cancel.
- It **does** establish the consequence is reachable without a crash at all, which widens the case:
  any fault that outlives the client's bounded cancel effort (`MAX_CANCEL_ROUNDS`, ~0.6–1.25 s of
  backoff) leaves the same permanent marker. A crash is the extreme; a long-enough transport fault
  is enough.
- It **strengthens the argument against the "declare it a client obligation" resolution.** The
  client here did everything the contract asks — awaited its cancel, retried it, reported the
  failure — and the block stayed wedged regardless.

**One thing it does not say.** It is not evidence the landed fix failed. The same gate was 5-red of 5
on every round before it and is 3 clean of 8 after (see the sereus board). The fix removed the cases
where the transport had recovered by the time the cancel ran; what is left is the case where it had
not, which is precisely the hole this ticket was filed to cover.

**For whoever picks this up:** the timing question in the `tradeoffs:` line — how to tell an
abandoned marker from an in-flight one — now has a concrete shape to reason about. In this capture
the abandoning client is still running and still writing to the same collection under a *different*
action id, which a node-side sweep could in principle notice.

## Arm, 2026-09-06 — a second, independent report of the same fingerprint; `likelihood` corrected

The arm above recorded this residual being observed in the sibling `../sereus` checkout. A second
consumer has now reported it independently, and the two do not share a codebase above this library.

**GitHub issue #18**, filed by an outside consumer (VoteTorrent, on-device n=4 replication proof,
2026-09-03, `db-p2p` 0.27.0 / cadre-core 0.12.0). Topology: two Node drones and two Android emulators
in one control network **over circuit relays**. Three successive membership writes, each awaited to
completion and seconds apart, each failed with:

```
sync for collection default/CadrePeer exhausted 10 retries:
pending conflict: block(s) held by unresolved rival action(s) <actionId>
```

That is the same message, on the same collection name, as the sereus capture — from a different
application. They also measured the cost: each failed write spent **30–34 s** burning its ten
retries and still did not clear.

**`likelihood: unusual` was wrong and is now `normal-use`.** Two independent consumers hit this on
ordinary sequential writes that the application awaited one at a time. Nothing contrived is required.
The relay topology in their report is consistent with the mechanism the sereus arm traced: a
transport slow or faulty enough to outlive the client's bounded cancel effort leaves the marker
standing, and relays make that easy.

**Their reproduction attempt is a useful negative.** They could not reproduce at the `db-p2p` level:
a probe driving `Diary.append` through `createMesh` / `buildNetworkTransactor` stayed green across
1 node / 5 sequential, 3 nodes / 5 sequential, 3 nodes / 5 concurrent, and 3 nodes / 3 writes 4 s
apart. They published the probe so the green result can be checked rather than trusted. That negative
agrees with what the sereus arm found from the other side — the in-process mesh heals faster than the
fault does, so the residual is invisible there — and it means **a fixture for this ticket must be
able to make a peer respond late or not at all, not merely fail fast**.

**Two things landed since 0.27.0 that bear on their report, neither of which closes it.**
`complete/1-a-failed-attempt-must-discharge-its-own-pend` makes a failing attempt await its own
cancel, and `complete/2-sync-fail-fast-on-a-stalled-revision-view` stops a hopeless sync burning the
full ten-retry budget — which is the 30–34 s they measured. Measured effect on the sereus gate:
0 clean of 5 before, 3 clean of 8 after. The residual this ticket owns is what remains.
