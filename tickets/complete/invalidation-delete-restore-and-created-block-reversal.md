description: Undoing a transaction that created a brand-new data block now actually removes that block from storage instead of crashing or leaving a stale placeholder, so storage matches the reverted (absent) state.
prereq:
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/dispute/index.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/cascade.spec.ts, packages/db-p2p/test/storage-repo.spec.ts
----

# Complete: delete-restore reversal of a block-creating transaction

## What shipped

Reverting a transaction `T_inv` that *created* a fresh block now physically removes the created
block via a forward **tombstone revision**, and storage re-materializes it as *absent* — replacing
the old behavior that either threw (`Failed to find materialized block …` when the creation was at
rev > 1) or only recorded a sentinel without removing anything (creation at rev ≤ 1).

Three coordinated changes (unchanged from the implement handoff, all verified in review):

1. **Detection — `computeRevertedBlock`** probes for the highest stored revision strictly before
   `invalidatedRev` via a descending `listRevisions(invalidatedRev - 1, 1)`; none ⇒ `T_inv` created
   the block ⇒ `{ kind: 'delete' }` at *any* rev, no throw.
2. **Storage delete path — `saveDeletion`** writes a `{ delete: true }` forward revision with no
   materialized block, merges `[rev, rev+1]`, advances `latest` monotonically, idempotent for a fixed
   `(rev, actionId)`, sharing the `saveReplica` latch. `materializeBlock` now returns `undefined`
   (instead of throwing `Block … has been deleted`) when the reverse-apply collapses to a tombstone.
3. **Apply + sentinel — `applyInvalidation`** calls `saveDeletion` with the same deterministic
   `revertActionId` the restore branch uses; sentinel renamed `DEFERRED_DELETE_RESTORE` →
   `DELETED_BLOCK_RESTORE` (`'deleted:block-creation-reverted'`); `cascade.ts` still short-circuits a
   pair carrying it to `invalidate`.

## Review findings

**Diff read first, with fresh eyes, before the handoff summary.** Scrutinized for SPP/DRY/modularity,
scalability, resource cleanup, error handling, and type safety. Verdict: the implementation is
**correct and lands as designed.** Findings by category:

### Correctness — verified, no defects
- Traced `materializeBlock` for the tombstone: descending scan finds the creation's materialized
  block below the tombstone, reverse-applies the `{ delete: true }` transform → `undefined`, and
  returns `undefined` *before* the materialization-cache write (so no `undefined` is ever cached, and
  the genuine-truncation throw `Failed to find materialized block` still fires when no materialization
  exists at all). Historical `getBlock(creationRev)` still materializes the created content.
- Confirmed `listRevisions` is inclusive on both ends and descends when `startRev > endRev`
  (`memory-storage.ts`, and the documented `i-raw-storage.ts` contract), so `computeRevertedBlock`'s
  "highest prior rev" probe and the replay-guard reasoning are sound. The `invalidatedRev <= 1`
  special-case folds correctly into the general probe (probe skipped, `priorRev` stays undefined).
- Cross-member determinism: `rev = maxFromRev + 1` is strictly above every block's current tip (no
  collision) and `revertActionId` is a deterministic hash, so every member writes an identical
  `(rev, actionId)` tombstone. Idempotent re-apply is gated first by the log dedup and, defensively,
  by `saveDeletion`'s monotonic guard. (`converges` + `idempotent` tests confirm.)

### Behavior change — verified safe, now regression-tested (minor, fixed inline)
- `materializeBlock` returning `undefined` instead of throwing applies to **all** `{ delete: true }`
  revisions, not just invalidation tombstones — a regular committed delete (`internalCommit` writes a
  delete revision with no materialized block, identical shape) now reads back as *absent*. Confirmed
  this is reachable (the existing `storage-repo.spec.ts` insert-then-delete test produces exactly that
  shape) and that it is an **improvement**: it aligns with `StorageRepo.get`'s documented
  "undefined ⇒ empty" contract; the throw was the anomaly. Grepped for any test or production
  dependence on the throw / the `Block … has been deleted` string — none. **Added a regression test**
  to `storage-repo.spec.ts` locking in "committed-then-deleted block reads back as empty state, not a
  throw" (and that the historical pre-delete revision still materializes).

### Documentation — drift corrected (minor, fixed inline)
- `invalidation.ts` comments referenced "the cascade ticket" in future/present tense as if the cascade
  were still pending; the cascade has landed. Rewrote both (the `computeRevertedBlock` doc-block and
  the inline note) to reference `cascade.ts` and describe the layering as it exists now. Verified the
  one remaining "this ticket closes" comment refers to a *different* (target-binding/replay) concern
  and is not stale. The `i-block-storage.ts` / `block-storage.ts` / `cascade.ts` doc comments touched
  by the change were read in full and accurately reflect the new tombstone reality.

### Tests — extended beyond the implementer's floor
- Re-ran the implementer's suites green and added the storage-layer regression above. The added
  test plus the existing 48 invalidation/cascade specs cover: creation-reversal at rev ≤ 1 and
  rev > 1, sparse revisions, idempotent re-apply, two-member convergence, the end-to-end cascade of a
  block-creating read-dependent, `saveDeletion` read-back/monotonicity/idempotency, and now the
  regular-delete read contract.

### Major / out-of-scope — one backlog ticket filed
- **Latch asymmetry (pre-existing, not a regression).** `applyInvalidation` calls
  `saveReplica`/`saveDeletion` directly under the `BlockStorage.saveReplica:<id>` latch, **not** the
  outer `StorageRepo.commit:<id>` latch that `StorageRepo.saveReplicatedBlock` uses to serialize a
  block's `latest` RMW against a concurrent commit. The new tombstone path inherits the *exact* same
  property the restore path already had, so it is not introduced here — but it is a real latent
  concurrency concern. Filed `tickets/backlog/invalidation-apply-vs-commit-latch-asymmetry.md` to
  confirm whether the cluster already serializes apply-vs-commit per block (then close) or thread the
  outer latch through.

### Considered and explicitly accepted (no action)
- **Standalone creation-reversal with later updates.** The delete branch tombstones without replaying
  later actions onto an absent base. This is correct under the cascade (the later writer is itself a
  read-dependent that gets reverted) and is the only path that reaches a creation-reversal; a
  standalone direct apply of "created@2, updated@5, invalidate @2" is not a real scenario because a
  root invalidation is always followed by the cascade that reverts the later writer. Documented inline
  in `computeRevertedBlock`. No defect.
- **Cluster-path direct test.** `applyConsensusInvalidation` inherits the fix transitively with no
  cluster-path change; the mechanism is collection-agnostic and unit + cascade tested. A dedicated
  cluster-level creation-reversal test would add little; `cluster-invalidation.spec.ts` + `dispute.spec.ts`
  re-run green (43 passing).

## Validation performed (review)

- `packages/db-p2p` `yarn build` (tsc): clean, exit 0 (after the doc + test edits).
- `invalidation.spec.ts` + `cascade.spec.ts` + `storage-repo.spec.ts` (incl. new regression):
  **81 passing, 0 failing, 0 pending.**
- `cluster-invalidation.spec.ts` + `dispute.spec.ts`: **43 passing.**
- Lint: the repo's root `lint` script is a no-op placeholder (`echo 'Lint not configured…'`) and
  `db-p2p` has no `lint` script; `tsc` is the effective static gate and is clean.
- Did not run the full suite (avoids the known load-sensitive `reactivity / mesh` gossipsub timeout
  the implement stage already triaged in commit `83ab553`; that `.pre-existing-error.md` has been
  consumed by the runner's triage pass — nothing outstanding).
