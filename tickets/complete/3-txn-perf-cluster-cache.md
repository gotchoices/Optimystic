description: A distributed save resolved which network node owns each block twice — once when staging, again when committing. It now resolves once and reuses that during the commit.
prereq:
files:
  - packages/db-core/src/transactor/network-transactor.ts (txnCoordinatorCache, pend population, resolveCoordinator, txnCoordinatorsFor, batchesForPayload actionId param, commitBlocks wiring)
  - packages/db-core/test/network-transactor.spec.ts ("per-transaction coordinator cache (pend → commit)" describe)
difficulty: medium
----

# Complete: cache per-block cluster/coordinator lookups for the pend→commit window

## Summary of the work

`NetworkTransactor.pend` resolved each block's owning network node (cluster + a
coordinator per block), and `commit` then re-resolved the same blocks from scratch.
The only carry-over was an optional, duck-typed `keyNetwork.recordCoordinator?.(...)`
hint that silently no-ops on key networks that don't implement it — so on those
networks commit could dial a *different* node than the one that holds the pending,
and always paid a second resolution round.

The implementation adds a per-transaction cache on `NetworkTransactor`
(`txnCoordinatorCache: Map<actionId, {coordinators: Map<blockId, PeerId>, expires}>`).
`pend` seeds it from its final, retry-adjusted batch assignment; `commit` reads it via
a new `resolveCoordinator` helper before falling back to a live `findCoordinator`.
Keyed by `actionId` (unique per transaction) rather than threading a Map through the
`ITransactor` contract — same "thrown away when the transaction ends" safety, far
smaller blast radius. TTL + 1000-entry cap are a memory backstop, not a staleness
bound. The optional `recordCoordinator` hint was intentionally kept (it still helps
the libp2p fast-path and cross-process reuse). A `NOTE:` tripwire at the population
site records the "cluster membership stable for the transaction lifetime" assumption.

## Review findings

Adversarial pass over commit `6016cf5`. Read the full implementation diff, the test
diff, and the surrounding machinery (`batch-coordinator.ts`, `consolidateCoordinators`,
the pend/commit/get/cancel flows), then traced the cache's correctness argument end
to end.

**Correctness — no defects found.** Verified the load-bearing claims:
- **`actionId` is unique per transaction**, so a cache entry is only ever read by its
  own transaction's commits. Client path uses a 128-bit random id
  (`collection.ts` `syncInternal`); coordinator path uses a content hash of
  stamp+statements+reads (`createTransactionId`) where the stamp carries a timestamp.
  The no-cross-transaction-staleness claim holds. Even under a hypothetical id reuse,
  a stale cached node is only a *hint*: commit self-heals by excluding a failed node
  and re-resolving live (one wasted round-trip, never a wrong commit).
- **Each block maps to exactly one recorded node.** Greedy set-cover in
  `consolidateCoordinators` assigns each block once; a failed root batch (success=false)
  is excluded from the `completed` set and its retry (success=true) is what populates —
  mutually exclusive, so no wrong-node caching.
- **All pended blocks are cached.** Population reads `blockIdsForTransforms(b.payload)`
  which includes inserts, updates, and deletes; commit's block ids are a subset.
- **Concurrent multi-collection pend/commit share one `actionId` safely.** They write
  disjoint block ids into the same entry; Map writes are synchronous (no interleaving),
  and `txnCoordinatorsFor` has no `await`, so its full-map sweep + cap-eviction can't
  race. This is why the implementer chose TTL reclamation over delete-on-commit — a
  delete would strip the shared entry from an in-flight sibling commit. Confirmed the
  scenario in `coordinator.ts` `pendPhase`/`commitPhase`.
- **`get` / `cancel` / `cancelBatch` pass no `actionId`** → always resolve live; a cache
  miss never fails. Correct and intentional.

**Minor — none.** Nothing to fix inline. Lint clean on both changed files, TTL sweep's
delete-during-Map-iteration is spec-safe, PeerId comparison uses `.toString()` matching
the rest of the module.

**Major — one, filed as backlog `debt-txn-coordinator-cache-tests`.** The tests cover
the happy path and per-transaction isolation but not: (1) retry-adjusted population
(commit reuses the *retry's* node after a pend retry), (2) the excludedPeers self-heal
on a commit retry, (3) a direct multi-collection concurrent-commit unit test. All three
are implementer-flagged, non-trivial to harness robustly (they need a pend-flaky or
replication-backed simulation, not a bare per-node repo), and either rare or currently
dormant — hardening, not a bug. Filed low-priority rather than forced inline to avoid a
brittle test that depends on greedy tie-break internals.

**Tripwire — one, already parked by the implementer (verified, not re-filed).** The
`NOTE:` at the pend population site: the cache assumes cluster membership is stable for
a transaction's lifetime. Fine today (transactions are short); if clusters ever churn
*within* one transaction, a cached node could be stale — commit self-heals at the cost
of one round-trip. Correctly a code comment, not a ticket.

**Docs — checked, no update needed.** The pend→commit node-resolution handoff is an
internal `NetworkTransactor` optimization; `docs/transactions.md` and
`docs/architecture.md` describe coordination at a higher level and make no claim this
change contradicts. The behavior is fully documented in code comments.

## Validation

- `packages/db-core`: `yarn build` clean; `yarn test` → **1153 passing, 0 failing**.
- `npx eslint` on `network-transactor.ts` + `network-transactor.spec.ts` → clean.
- `db-p2p` contract unchanged (`ITransactor` untouched), so no downstream typecheck impact.

## Files touched (by the implement stage)

- `packages/db-core/src/transactor/network-transactor.ts` — cache field + doc, pend
  population (NOTE site), `resolveCoordinator`, `txnCoordinatorsFor`, `batchesForPayload`
  optional `actionId`, `commitBlocks` wiring.
- `packages/db-core/test/network-transactor.spec.ts` — new describe block (2 tests).

## Follow-ups created

- `tickets/backlog/debt-txn-coordinator-cache-tests.md` — coverage hardening for the
  retry, self-heal, and concurrent-commit paths.
