description: A database read that gets a definite "the block does not exist" answer now trusts that answer instead of asking the network a second time, halving the cost of the common "does this block exist yet?" check.
prereq:
files:
  - packages/db-core/src/transactor/network-transactor.ts (get() retry predicate, ~lines 112-141)
  - packages/db-core/test/network-transactor.spec.ts ("get retry accounting" describe block)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cluster-reconcile guard, ~line 197 — tripwire NOTE added)
difficulty: medium
----

# Complete: authoritative "not found" must not trigger a second retry round

## Summary

`NetworkTransactor.get()`'s second-chance retry predicate was changed from
"retry unless the response carries a *materialized block* for some requested id"
(`hasBlockInResponse`, a `.some` check) to "retry unless the response carries an
*entry* for *every* requested id" (`isAuthoritative`, a `.every` check). A block
that does not exist yet comes back as a present-but-blockless entry
(`{ state: {} }`); the old predicate mistook that for "no answer" and ran a whole
second `findCoordinator` + `get` round on the common `createOrOpen` existence
probe. The new predicate treats an authoritative absent as final. Retry now fires
only for a genuine no-response (no valid response, or a response missing an entry
for some requested id).

The safety of dropping the retry rests on cross-member reconciliation already
happening one layer down: `CoordinatorRepo.get()` consults cluster peers on a
missing block *before* responding, so an authoritative absent that reaches the
transactor is already reconciled.

## Review findings

**Read the implement diff first (de51da5) with fresh eyes, then the handoff.**
Angles scrutinized: correctness, DRY, modularity, performance, type safety,
error handling, resource cleanup, test coverage, docs.

- **Safety premise — VERIFIED, not just asserted.** Read the two db-p2p sites the
  argument depends on. `storage-repo.ts:229` returns `{ state: {} }` for an absent
  block (an entry that is present, no `block`) — confirms an authoritative absent
  is distinguishable from a genuine gap. `coordinator-repo.ts:197-201` consults
  cluster peers when `isMissing` *before* responding — confirms reconciliation
  happens below the transactor, so the removed retry was redundant work. Premise
  holds.

- **`resultEntries` preference logic — VERIFIED intact.**
  `network-transactor.ts:186-190` still prefers a response with a materialized
  block over a blockless entry, so when two members disagree an absent entry never
  shadows a real block. `isRecordEmpty` (shallow key check) correctly keeps a
  `{ blockId: { state: {} } }` response (one key → non-empty) in `completedBatches`,
  so the absent entry survives to the result and `missingIds` stays empty. No change
  needed.

- **MINOR — multi-block partial-batch case was untested → FIXED INLINE.** The
  `.some`→`.every` change alters behavior for a batch that answers some but not all
  block ids (old predicate let the un-answered id fall to the `missingIds`
  aggregate-error path; new predicate retries the whole payload and can recover it).
  This was flagged as untested in the handoff. Added
  `retries the whole payload when a batch answers some but not all block ids` to the
  `get retry accounting` block: peerA answers for `b1` only, omits `b2`; asserts the
  retry reaches peerB and both blocks resolve. Guards the new behavior.

- **TRIPWIRE — coordinator/transactor coupling → NOTE parked, not a ticket.** The
  no-retry safety depends on `CoordinatorRepo` having `clusterLatestCallback` set
  (the guard at `coordinator-repo.ts:197`). A coordinator configured without it
  would answer a missing block from local state alone, with no transactor retry to
  compensate. Genuinely conditional — such a coordinator has no cluster to reconcile
  against anyway, so the retry was pointless there. Recorded as a `NOTE:` comment at
  the guard site so a future partial-cluster read path meets the coupling. No ticket.

- **MAJOR findings: none.** The change is minimal, well-commented, and the removed
  behavior is provably redundant against the coordinator layer.

- **Integration coverage — acknowledged limit, no action.** Both new tests mock
  `IKeyNetwork`/`IRepo`; the end-to-end premise (CoordinatorRepo reconciles before
  responding) is not exercised by a db-p2p integration test here. db-p2p was out of
  scope for the build in this ticket. This is a pre-existing coverage boundary, not a
  regression introduced by the change; the unit tests plus the verified read of the
  db-p2p sites are sufficient for this pass.

- **Docs:** grepped `**/*.md` for the retry / "not found" behavior — no doc
  references the get() retry predicate, so nothing to update.

- **Cross-ticket (tx-9):** intent to preserve — retry only on genuine
  no-response / error; an authoritative absent is final. If tx-9 reworks the get()
  retry loop, do not fold authoritative-absent back into the retryable set. The loop
  still drives a single round (iterates the pre-loop `retryable` snapshot; nested
  retries enqueued onto `subsumedBy` are not re-driven) — pre-existing, unchanged.

## Validation

From `packages/db-core` (streamed):
- `yarn build` — clean (tsc silent).
- `yarn test` — **1144 passing** (1143 prior + 1 new test), no regressions.
- `yarn test:verbose --grep "get retry accounting"` — 3 passing (the two original
  plus the new multi-block test).

db-p2p change is a comment-only `NOTE:` (no build impact).
