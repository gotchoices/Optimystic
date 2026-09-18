description: A write that is told to wait for someone else's in-flight change keeps retrying against the out-of-date copy of the data it first read, so once that other change lands the write is refused instead of succeeding. It happens only on clusters of four or more machines, when the first read came from a machine that had missed the other change.
architecture: docs/correctness.md
files: packages/db-core/src/collection/collection.ts (the sync retry loop and `restageIfBasesMoved`), packages/db-p2p/src/repo/coordinator-repo.ts (`pend-held-uncorroborated`, which answers the writer without the rival's action id), packages/db-p2p/src/storage/pending-claim.ts (`isReservationAgainst`, whose NOTE names this residual), packages/db-p2p/test/rival-superseded-only-by-a-writer-that-built-on-it.spec.ts (phase 4 reproduces it)
difficulty: hard
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The write is refused, never saved over the other change, so nothing is silently lost; the fix sits on the client's retry path, the busiest path in the system, and a maintainer may prefer to leave a four-machine timing window alone until it is seen in the field.

# A writer held by a change it never saw retries on its stale copy

## What happens

On a cohort of four or more machines, one machine (call it D) can miss a write R's pend entirely: the pend only needs a super-majority of promises. While R's data-block commit is still in flight — its log entry has landed, its data block has not — a freshly opened collection handle whose reads go through D gets the log with R's entry in it, but gets the data block from D *without* R's change (D holds no pending record for R, so it has nothing to promote). A fresh handle has walked no log entry, so it has no floor for that block and accepts the answer.

The handle's writer N then pends. Since `a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it`, the members that hold R's record see that N's declared base for the block is below R's slot and answer `held`. That part is right: before, they approved and N's commit landed over the stale copy, losing R's change.

What is wrong is the retry. N's handle never re-reads the data block: the held refusal gives it no reason to, its log refresh finds nothing new (it already saw R's entry), and `restageIfBasesMoved` compares the pinned base with a cached copy that has not moved. So once R's data-block commit lands, N re-pends on the same stale base. Nothing holds it any more (R's record was promoted), the pend is admitted, N's tail commits, and the fork guard (`StorageRepo.internalCommit`) refuses N's data-block commit on every member. N's write ends in `TornActionError` — "whether the write is saved could not be established" — with its log entry stored and its change on no machine. An application-level retry from a fresh handle then succeeds.

Measured on the in-process mesh (`packages/db-p2p/test/rival-superseded-only-by-a-writer-that-built-on-it.spec.ts`, phase 4): N read the data block once, at revision 1 while R held revision 2, and every one of its nine pends declared base 1 — the first held, the other eight admitted and each refused at commit with `commit-not-durable: 0 of 4 cohort member(s) report holding rev 3`.

## Where the signal is lost

- The held answer reaches the writer bare when the coordinating machine's own storage cannot corroborate the rival (`CoordinatorRepo`'s `pend-held-uncorroborated` arm returns only a reason string). In this shape the coordinator is D, which by construction holds no record for R, so it is always uncorroborated here — and the rival's action id, which the members did sign (`Signature.heldBy`), is dropped.
- A held refusal naming a rival whose action the handle's own log already lists as committed is proof that the handle's copy of that block is behind: the rival's change is committed (the log says so) and the handle's copy lacks it (or the rival's record would have been superseded). Today nothing on the client reads it that way.

## Expected behaviour

After a held refusal on a block whose holder the handle's log already names as committed, the writer's next attempt re-reads that block, from a machine that has the change or with a floor at the holder's revision, and re-stages over it, so it lands once the rival commits instead of ending torn. A held refusal on a rival the log does not name (a genuinely in-flight rival) keeps today's behaviour.

Related, not the same: `feat-refresh-can-demand-a-revision-floor` (a refresh of the *collection* answered by a behind machine) and `bug-a-refused-write-can-leave-its-log-entry-behind` (the leftover log entry this shape also produces).
