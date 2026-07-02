description: Several avoidable slowdowns in the commit path: a normal "this block doesn't exist yet" answer is mistaken for a failure and triggers a whole extra round of network work; independent per-group steps are done one after another instead of together; and the same block locations are looked up over and over without caching.
files:
  - packages/db-core/src/transactor/network-transactor.ts (hasBlockInResponse / retry rounds ~lines 118-158, findCluster ~lines 325-332)
  - packages/db-core/src/transaction/coordinator.ts (pendPhase/commitPhase serial per-collection awaits, ~lines 685-801)
difficulty: medium
----

# Perf: false-retry on authoritative not-found; serial phases; uncached findCluster

Three independent performance defects in the pend/commit path. They can be tackled
separately (split into prereq-chained implement tickets if warranted).

## (a) Authoritative "not found" triggers a full retry round

`hasBlockInResponse` demands a materialized block, so a valid "this block does not
exist" response — normal for `createOrOpen` probing — is treated as retryable. That
provokes a second full round of `findCoordinator` + `get`, serial per batch, for
something that already had a definitive answer.

Fix direction: distinguish an authoritative "absent" response from a genuine
no-response, and don't retry the former.

## (b) Per-collection phases run serially

`pendPhase` and `commitPhase` await collections one at a time even though the pends
are independent of each other.

Fix direction: parallelize per-collection pends (e.g. `Promise.allSettled`) with a
cancel-all-on-failure policy; parallelize the per-batch retries similarly.

## (c) Per-block findCluster is uncached

Every pend does a per-block `findCluster` with no caching; commit then re-resolves the
same blocks, currently relying on a duck-typed `as any` hint to avoid re-routing.

Fix direction: cache cluster lookups for the pend→commit window, keyed by block id.

## Expected behavior

Probing for a not-yet-existing block costs one round, not two; independent pends
proceed concurrently; and a block's cluster is resolved once per transaction.

Severity: MEDIUM (perf). Interacts with tx-2 (parallel pend cleanup) and tx-9 (retry
policy) — keep the cancel-on-failure semantics consistent with those.
