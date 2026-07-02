description: A transaction that writes to several groups of data can permanently save some of them and then report to the caller that the whole thing failed — leaving the caller believing nothing changed when in fact part of it did.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (commitPhase and coordinateTransaction, ~lines 604-612, 745-801)
difficulty: hard
----

# Multi-collection commit half-commits, then reports failure

## The bug

`commitPhase` commits collections one at a time. If collection N fails after its
retry attempts, `coordinateTransaction` cancels only the *un*-committed collections
and reports the transaction as failed — but the earlier collections' commits are
already durable. The GATHER supercluster nominees are threaded into the pend step but
play no role in making the tail commits atomic.

Result: the client is told "failed" for a transaction that actually half-committed.
There is no signal that reconciliation is needed, so the caller assumes a clean abort
and the two halves of the data diverge permanently.

## Expected behavior

Either the whole multi-collection transaction commits or none of it does; or, at
minimum, a partial commit is reported honestly so the caller knows reconciliation is
required rather than assuming a clean rollback.

## Design counterpart / prereq note

This is the implementation counterpart of design finding "D-H4" (multi-collection
commit atomicity) in `docs/review.html`, which the design pass owns. If a plan ticket
for real two-phase-commit / multi-collection atomicity over the supercluster exists
or gets created (expected slug along the lines of a `*-multi-collection-commit-*`
or `*-2pc-*` plan ticket), this fix should add it to its `prereq:` header and adopt
its durable-decision-record design rather than duplicating it. Until then, the
defensible minimum this ticket must deliver is the honest-reporting path: surface the
set of already-committed collections in the failure so callers can reconcile.

Do not re-derive the full 2PC design here — coordinate through the plan ticket.

Severity: HIGH.
