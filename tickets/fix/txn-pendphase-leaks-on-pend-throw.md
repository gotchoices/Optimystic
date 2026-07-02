description: When a multi-part write fails partway through, the parts that already succeeded are supposed to be released so other writers can proceed — but if the failure arrives as a thrown error rather than a returned status, that cleanup is skipped and the successful parts stay locked until they time out.
files:
  - packages/db-core/src/transaction/coordinator.ts (pendPhase — per-collection pend loop and cleanup, ~lines 706-716)
  - packages/db-core/src/transactor/network-transactor.ts (pend throws on non-stale failure, ~line 489)
difficulty: medium
----

# pendPhase leaks pended actions when transactor.pend throws

## The bug

`pendPhase` pends each collection in turn. Its cleanup — cancelling the collections
that were already pended so they don't block other writers — runs **only** when
`pend` returns `{ success: false }`. But `NetworkTransactor.pend` *throws* on
non-stale failures (e.g. peers unreachable), and `pendPhase` has no try/catch around
the per-collection loop.

So when an early collection pends successfully and a later collection throws, the
earlier successful pends are never cancelled. They stay held until their TTL expires,
blocking other writers on those blocks for the full lease window.

## Expected behavior

Any failure during the pend phase — returned failure *or* thrown error — must run
the same "cancel everything already pended in this phase" cleanup before propagating
the failure. No successful pend should survive a failed transaction.

## Suggested direction (hint, not a mandate)

Wrap the per-collection pend loop in try/catch; on throw, run the same
cancel-already-pended cleanup used on the `{success:false}` path, then rethrow.
Consider interaction with tx-9 (commitPhase retry vs. transactor auto-cancel) so the
two cleanup paths don't double-cancel.

Severity: HIGH.
