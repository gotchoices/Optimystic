----
description: When applying an already-agreed transaction hits a temporary error on one member, that member permanently records the transaction as done and then silently skips it forever on retry, dropping it on that node.
files: packages/db-p2p/src/cluster/cluster-repo.ts (handleConsensus ~745-770; markExecuted/wasTransactionExecutedAsync; stateStore interface)
difficulty: medium
----

# Persistent "executed" marker is never rolled back on a transient apply fault

## The bug

`handleConsensus` (`cluster/cluster-repo.ts:745-770`) records that a transaction
has executed in two places: an in-memory guard (`executedTransactions`) and a
durable marker written via `stateStore.markExecuted(...)` (fire-and-forget). It
then applies the operations.

If applying throws an unexpected fault (e.g. transient storage I/O), the catch
block rolls back **only** the in-memory marker (`executedTransactions.delete`).
The durable marker stays written — the state-store interface has no
`unmarkExecuted`. On redelivery, `wasTransactionExecutedAsync` sees the durable
marker and the member skips `handleConsensus` forever. The operation is silently
dropped on that member, even though the rollback in the catch was written
specifically to allow a corrected retry to re-run.

## Expected behavior

A transient apply fault must leave the member able to re-run the transaction on
redelivery. The durable "executed" state must reflect only transactions that
actually applied.

## Suggested-fix hint

Either add `unmarkExecuted(messageHash)` to the state-store interface and call it
in the catch alongside the in-memory delete, or persist the durable marker only
*after* `applyConsensusOperation` succeeds (the synchronous in-memory guard
already covers the apply-window race that the eager durable write was guarding
against).

## TODO
- Reproduce: force `applyConsensusOperation` to throw once, then redeliver the
  same record; assert the member re-runs rather than skipping.
- Implement durable-marker rollback (or defer the durable write to post-apply).
- Verify the concurrent apply-window race is still covered by the in-memory guard.
