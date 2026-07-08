description: Add tests for the not-yet-covered corners of the per-transaction coordinator cache — the retry path and the self-healing fallback when a cached network node is no longer reachable.
prereq:
files:
  - packages/db-core/src/transactor/network-transactor.ts (resolveCoordinator, txnCoordinatorsFor, pend population site, commitBlocks)
  - packages/db-core/test/network-transactor.spec.ts ("per-transaction coordinator cache (pend → commit)" describe)
  - packages/db-core/src/testing/test-transactor.ts (FlakyCommitTransactor, TestTransactor)
difficulty: medium
----

# Harden the per-transaction coordinator cache with edge/error-path tests

## Background

Ticket `txn-perf-cluster-cache` added a per-transaction cache so that a distributed
save resolves each block's owning network node once (at "pend") and the follow-up
"commit" reuses that resolution instead of resolving again. Implementation:
`NetworkTransactor.resolveCoordinator` / `txnCoordinatorsFor` in
`packages/db-core/src/transactor/network-transactor.ts`.

The merged feature is correct and passes the full db-core suite (1153 tests). Its
new tests cover the **happy path** (commit reuses pend's resolution; zero commit-time
`findCoordinator`) and **per-transaction isolation** (a commit under a different
transaction id misses the cache and resolves live). Three paths remain uncovered.
None is a known defect — this is test hardening, not a bug fix.

## What to cover

- **Retry-adjusted population.** During pend, if the first-chosen node fails, the
  batch is retried against a different node and the block is re-homed. The cache is
  populated from the *final* (post-retry) assignment, so commit should reuse the
  **retry's** node, not the original. There is no test that forces a pend retry and
  asserts this. The existing `FlakyCommitTransactor` fails *commits*, not *pends* —
  a pend-flaky harness (or a per-node repo whose `pend` fails once then succeeds
  elsewhere) would be new.

- **Self-heal when a cached node is excluded on a commit retry.**
  `resolveCoordinator` deliberately skips a cached node that is already in the
  retry's `excludedPeers` set, then re-resolves live, so a commit retry can't loop
  on a dead cached node. No test exercises cached-node → excluded → live re-resolve.
  Note: a realistic end-to-end version needs the pending state to exist on the
  fallback node too (cluster replication), so this likely belongs in the
  `NetworkSimulation`-backed tests rather than a bare per-node-repo unit test — the
  bare-unit version can only assert the *skip + live lookup happens*, not that the
  commit then succeeds.

- **Multi-collection concurrent commit sharing one transaction id.** A transaction
  spanning several collections fans out concurrent `pend()` and `commit()` calls
  that all share the same transaction id, so they read and write the **same** cache
  entry. This is why the implementation reclaims entries by TTL instead of deleting
  on commit-end (a delete would pull the shared entry out from under a sibling
  commit still in flight). It is exercised indirectly by higher-level coordinator
  tests but has no direct unit test at the `NetworkTransactor` layer.

## Why backlog / low priority

The feature works and is covered for its primary paths. These gaps are either rare
(pend retries), currently dormant (the self-heal only matters if cluster membership
churns *within* a single transaction — see the `NOTE:` tripwire at the pend
population site in `network-transactor.ts`), or already covered one layer up
(concurrent multi-collection commit). Worth doing to lock in the cache's safety
properties against future refactors; not blocking anything.
