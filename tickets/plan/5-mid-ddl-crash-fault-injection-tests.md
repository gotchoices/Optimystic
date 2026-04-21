description: Add fault-injection tests covering mid-DDL / mid-transaction crashes and partial-state recovery. Mobile clients crash mid-flow routinely (app suspended, OS kill, battery, network lost); the cluster-consensus byzantine suite doesn't cover the local pend→commit boundary. Verify that interrupted DDLs either complete on retry or are cleanly rolled back.
dependencies:
  - tickets/complete/5-get-block-throws-on-pending-only-metadata.md (established that pending-only metadata is a real on-disk state)
  - tickets/plan/2-fresh-node-ddl-integration-harness.md (uses the same harness; this ticket adds crash points to it)
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (pend / commit / savePendingTransaction — crash points)
  - packages/db-p2p/src/storage/storage-repo.ts (pend / commit / cancel — on-disk transitions)
  - packages/db-p2p/src/storage/block-storage.ts (per-block persistence — partial writes)
  - packages/db-core/src/transactor/network-transactor.ts (batch orchestration — mid-batch crash)
  - packages/db-core/src/utility/batch-coordinator.ts (retry after partial-completion)
  - packages/db-p2p/test/byzantine-fault-injection.spec.ts (existing fault-injection seed; scope is adversarial-peer, not local-crash)
  - new: packages/db-p2p/test/mid-ddl-crash.spec.ts
----

## Motivation

The existing `byzantine-fault-injection.spec.ts` covers adversarial-peer scenarios at the cluster-consensus layer. It does not cover the boundary that matters for mobile: what happens when the *local* node crashes between `pend` and `commit` on its own schema block? Between `savePendingTransaction` and the caller seeing success? Between writing metadata for block A and block B in the same batch?

Sereus-health mobile is the poster case: backgrounded apps get killed by the OS at arbitrary points, and the next launch must either pick up where it left off or start cleanly. Neither path is currently tested.

## State boundaries to cover

The DDL/DML write path has several durable boundaries. A crash between any two of these must leave recoverable state:

```
caller.pend(request)
  → CoordinatorRepo.pend
    → savePendingTransaction         [ ⨯ crash-A: metadata written, pending not yet stored ]
    → StorageRepo.pend
      → BlockStorage.pend            [ ⨯ crash-B: some blocks persisted, others not ]
    ← returns success
caller.commit(request)
  → CoordinatorRepo.commit
    → StorageRepo.commit
      → BlockStorage.commit          [ ⨯ crash-C: some blocks committed, others not ]
    → mark pending as committed      [ ⨯ crash-D: blocks committed but pending record not cleared ]
    ← returns success
```

Crash-A is the pending-only metadata state that ticket 5-get already normalized to "empty state" on read. Good. But there's no test that explicitly crashes here and then verifies the next operation (either retry-pend, cancel, or a fresh read) behaves correctly.

Crash-B through Crash-D have no coverage at all.

## Specification

A new `packages/db-p2p/test/mid-ddl-crash.spec.ts` built on the same harness as the fresh-node-ddl ticket. For each crash point:

1. Drive a DDL / DML flow through the real production stack (NetworkTransactor + CoordinatorRepo + StorageRepo).
2. Inject a crash by throwing from an instrumented storage wrapper at the specified boundary, or by dropping the node and its in-memory layers but keeping the raw storage.
3. "Restart" the node (reconstruct the full stack over the preserved raw storage).
4. Assert one of:
   - **Retry-idempotent**: re-running the same `pend` / `commit` produces the same final state.
   - **Cleanly rolled back**: reads show empty state, next operation succeeds.
   - **Cleanly committed**: reads show the committed state even if the crash happened after the durable commit point.

The outcome depends on which side of the durable boundary the crash was on — the test encodes which outcome is correct for which crash point. If no code exists yet that enforces the correct outcome, the test documents the requirement and files follow-up fix tickets.

### Specific cases

- **Crash-A: metadata seeded, pending not stored**. Restart, verify read returns empty state (already guaranteed by ticket 5-get). Verify retry-pend succeeds and leads to a commit. Verify a fresh `cancel(trxRef)` also leaves a clean state.
- **Crash-B: partial pending across multiple blocks**. Pend a 3-block batch, crash after block 2. Restart. Verify retry is either idempotent or cleanly rejects, and that stray pending state for blocks 1-2 doesn't permanently block those block ids.
- **Crash-C: partial commit across multiple blocks**. Harder — the contract may or may not guarantee atomicity. Test documents current behavior; if non-atomic, file a design ticket.
- **Crash-D: committed but pending not cleared**. Restart. Verify a retry of the same commit is a no-op (idempotent) or cleanly rejected as already-committed. Verify the pending record is eventually cleaned up.
- **Crash during `schema` block commit specifically**. The schema block is the one that every subsequent DDL depends on; a corrupted or half-committed schema block bricks the whole database. Explicit coverage warranted.

## Expected outcomes

- Current behavior at each crash boundary is documented as an executable test.
- Gaps where current behavior is wrong become fix tickets.
- Mobile-style "killed mid-launch" bugs surface in CI instead of on device.

## Out of scope

- Disk-corruption / byte-level storage corruption — that's a separate resilience ticket.
- Crashes during cluster-consensus (multi-node) commits — byzantine-fault-injection covers adjacent territory; extending it is a separate ticket if needed.
- Retry limits / exponential backoff / circuit-breakers — this ticket is correctness, not liveness under pathological retry.
