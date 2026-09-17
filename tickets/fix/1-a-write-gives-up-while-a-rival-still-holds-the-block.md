description: When one machine is slow, a write that hits a rival write's hold keeps retrying, runs out of retries, and is reported as a failure the application will not retry — so the write is lost. In one run the rival's hold was still standing five minutes later, with nothing clearing it, and writes to that block kept failing until the scenario timed out.
files:
  - packages/db-core/src/collection/collection.ts (`syncAttempts` — `maxAttempts`, `maxStalledAttempts`, `deadlineMs`, and the `SyncRetryExhaustedError` it throws)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`pend` — the unconditional conversion of a `held` vote into a retryable conflict, `corroborateHeldBlocks`, `noteStuckReservation`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`validatePendOperations` — the pending-conflict branch that now votes `held`)
  - packages/db-p2p/src/storage/storage-repo.ts (`dropUnpromotablePendings` — the sweep that is meant to clear a pending record nobody will promote)
  - packages/db-core/src/transactor/network-transactor.ts (`cancelAbandonedSweepBlocks`)
repro: downstream (reliable)
severity: wrong-result
likelihood: normal-use
----

# What was measured

Reported 2026-09-17 by sereus (`sereus-83`) from its verification run against optimystic `03ffadc4`, scenario `control-write-degraded-cohort-member`, 5 runs. Their evidence is committed at `../sereus/tickets/fix/control-write-refused-when-a-rival-write-holds-the-block.md`.

**The good news first, so it is not re-fixed:** `a-contended-pend-refusal-is-permanent-on-a-small-cohort` worked. `Transaction rejected by validators` does not appear once in any of the 5 runs. A contended pend is now a retryable conflict, as intended.

**The bad news is what it turned into.** Three findings, ours in priority order.

## 1. The retry budget runs out and the failure is final

The writer now retries, exhausts `syncAttempts`, and throws:

```
SyncRetryExhaustedError: sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries:
pending conflict: block(s) held by unresolved rival action(s) <id>
```

alongside `Pend blocks held: 2/3 member(s) hold an unresolved rival action (1/3 approvals)`.

When the machine holding the rival record is the **delayed** one, ten retries is not enough. Sereus treats `SyncRetryExhaustedError` as non-transient and does not re-present the write, so a conflict we deliberately made retryable becomes a lost write one layer up.

Two things to decide, and they are separable:

- **Is exhaustion against a live, named rival the same failure as exhaustion against silence?** It is not: the writer knows precisely who holds the block and that the holder is alive. A distinct error (or a field on this one) saying "a named rival still holds this; retrying later is expected to succeed" would let a consumer re-present it without parsing prose. Note the standing debt ticket `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text` — this is the third consumer-facing distinction we have failed to put in a field.
- **Is the budget itself wrong when the holder is slow rather than gone?** `maxStalledAttempts` exists for the no-progress case. A rival that is demonstrably alive and holding is progress of a kind, and a backoff tuned to the observed holder latency may be more correct than a fixed count. Do not simply raise the count without saying what the new number is for.

## 2. A pending record that never discharged

Run 1: rival action `P6DsRqE3Mj2-escNG0gTvw` was still named as the holder **five minutes later**, and three tests hit the scenario's 120 s ceiling where this class of failure used to come back in about 10 s.

This is the one to chase first, because a hold that never clears makes finding (1) unfixable by any retry budget.

- Neither `dropUnpromotablePendings` nor `cancelAbandonedSweepBlocks` cleared it. Find out which one should have, and why it did not fire — or whether nothing owns this case.
- `noteStuckReservation` is the wedged-block detector, and the review of `a-contended-pend-refusal-is-permanent-on-a-small-cohort` left a `NOTE:` saying it is now fed **less** often: the path that used to throw on an uncorroborated refusal returns quietly instead. So a wedge only remote members can see may now go unnamed. Check whether that is why this one was invisible.
- **This is very likely the same family as `backlog/debt-unpromotable-pending-records-need-a-sweep`,** whose arm describes a stranded sweep record costing later writers the full retry budget and reporting a rival rather than an absent member — the 27.5 s three-machine stall the maintainer is deciding on. If this reproduces as the same defect, say so plainly and fold the two together; that decision then answers itself.

## 3. A green run that lost a write (report, do not necessarily fix here)

Run 4 **passed** while a background `[self-record-update]` failed permanently to contention, with no assertion covering it. That is sereus's coverage gap and theirs to close, but it matters to us for one reason: **a green downstream suite is no longer proof that contention is handled.** Anyone reading these scenarios as evidence for a release should know that.

# Where to start

Reproduce (2) first, in-process. The mesh harness can already inject per-member latency (`concurrent-two-member-writes-do-not-tear.spec.ts`), and `a-contended-pend-refusal-is-permanent-on-a-small-cohort` left a reproducer at 8 concurrent pairs. A three-member cohort with one delayed member, writing repeatedly to one block, should strand a record if this is ours. If it will not strand in-process, say what sereus's topology has that the mesh does not before reaching for real sockets.
