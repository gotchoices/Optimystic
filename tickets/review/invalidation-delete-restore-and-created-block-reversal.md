description: Undoing a transaction that created a brand-new data block now actually removes that block from storage instead of crashing or leaving a stale placeholder, so storage matches the reverted (absent) state.
prereq:
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/dispute/index.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/cascade.spec.ts
difficulty: hard
----

# Review: delete-restore reversal of a block-creating transaction

## What was implemented

Reverting a transaction `T_inv` that *created* a fresh block used to either throw
(`Failed to find materialized block …` when the creation was at rev > 1) or only record a
sentinel without physically removing the block (creation at rev ≤ 1). Both cases now do the
right thing: the created block is physically removed via a forward **tombstone revision**, and
the storage re-materializes the block as *absent* (not a throw, not a placeholder).

Three coordinated changes:

### 1. Detection — `computeRevertedBlock` (`invalidation.ts`)
Replaced the `invalidatedRev <= 1` special-case with a general probe for the **highest stored
revision strictly before `invalidatedRev`** via a descending `listRevisions(invalidatedRev - 1, 1)`
(first yield = the base to roll back to). None ⇒ `T_inv` created the block ⇒ `{ kind: 'delete' }`
at *any* rev, without throwing. The delete branch deliberately does **not** replay later actions
onto an absent base (documented inline).

### 2. Storage delete path — `saveDeletion` (`i-block-storage.ts`, `block-storage.ts`)
New `IBlockStorage.saveDeletion(source: ActionRev): Promise<ActionRev>`, modeled on `saveReplica`:
writes a forward revision whose action transform is `{ delete: true }` with **no** materialized
block, merges `[rev, rev+1]` into ranges, advances `latest` monotonically, idempotent for a fixed
`(rev, actionId)`, shares the `saveReplica` latch. `BlockStorage` is the only production
implementer.

`materializeBlock` now **returns `undefined`** (instead of throwing `Block … has been deleted`)
when the reverse-apply collapses to a tombstone; its return type was widened to
`{ block, actionRev } | undefined` and `getBlock` propagates it. The *other* throw
(`Failed to find materialized block`) is intentionally left intact — that one is a genuine
truncation/missing-materialization error.

### 3. Apply + sentinel — `applyInvalidation` (`invalidation.ts`), `cascade.ts`, `index.ts`
The delete branch now calls `storage.saveDeletion({ rev, actionId: revertActionId })` using the
same deterministic `revertActionId = hashString('inv:…:rev')` the restore branch uses (so every
member writes an identical tombstone). The sentinel constant was renamed
`DEFERRED_DELETE_RESTORE` → `DELETED_BLOCK_RESTORE` (value `'deleted:block-creation-reverted'`)
and its docs rewritten to say the removal now happens; `cascade.ts`'s
`contentEqualityReevaluator` still short-circuits a pair carrying this sentinel to `invalidate`.

## Validation performed

- `packages/db-p2p` `yarn build` (tsc): clean, exit 0.
- `packages/db-p2p` full `yarn test:verbose`: **983 passing, 30 pending, 1 failing**. The single
  failure (`reactivity / mesh — cold-to-hot growth + delivery`) is a **pre-existing, load-sensitive
  timeout** in the libp2p gossipsub mesh subsystem — it passes in isolation (~25.9s < 60s limit)
  and is unrelated to this diff. Documented in `tickets/.pre-existing-error.md`.
- Touched specs (`invalidation.spec.ts` + `cascade.spec.ts`): **48/48 passing.**

## Tests added (the floor — extend, don't trust as exhaustive)

`invalidation.spec.ts`:
- `computeRevertedBlock`: deletion (no throw) for a block created at rev > 1 (the case-2 repro:
  A@1 then B fresh@2); sparse revisions (created@2/updated@5 → restore to created@2 when
  invalidating @5, delete when invalidating @2).
- `applyInvalidation`: physical removal for creation at rev ≤ 1 AND rev > 1 (`getBlock()` →
  `undefined` after); idempotent re-apply (one entry, one tombstone, `latest` unchanged);
  convergence (two members write identical `(rev, actionId)` tombstones); reverted entry carries
  `DELETED_BLOCK_RESTORE`.
- `BlockStorage.saveDeletion`: reads back absent, historical `getBlock(creationRev)` still
  materializes the created content, monotonic + idempotent.

`cascade.spec.ts`:
- A read-dependent that **creates a fresh block at rev > 1** (no genesis pre-creation) is itself
  reverted end-to-end (the previously-throwing path), its created block is physically removed, and
  its downstream dependent invalidates via the `DELETED_BLOCK_RESTORE` sentinel.

## Known gaps / what the reviewer should scrutinize

1. **`materializeBlock` undefined-for-tombstone is a behavior change for ALL `{ delete: true }`
   revisions**, not just invalidation tombstones. Previously any reverse-apply to `undefined`
   threw `Block … has been deleted`; now it returns `undefined`. I confirmed no test asserted on
   that throw and the full suite is green, but the reviewer should confirm no *production*
   code-path relied on the throw to detect a deletion (e.g. anything calling `getBlock` on a
   regularly-deleted block and expecting an exception). The new behavior aligns with `getBlock`'s
   documented "undefined ⇒ no materialized content" contract and looks like a latent improvement.

2. **Standalone (non-cascade) apply of a creation-reversal when later updates exist.** The delete
   branch does not replay later actions onto an absent base, so a block created@2/updated@5 that is
   invalidated directly at @2 is tombstoned even though `t_update@5`'s log entry still stands. The
   design intent (from the source ticket) is that the later writer is itself a read-dependent the
   cascade re-evaluates and reverts. Worth confirming that the only caller reaching a
   creation-reversal-with-later-updates is the cascade (or that a standalone apply of that shape is
   not a real scenario).

3. **Latching.** `saveDeletion` shares the `BlockStorage.saveReplica:<id>` latch (correct for the
   internal RMW), but — like the existing restore path's `saveReplica` call inside
   `applyInvalidation` — it is **not** wrapped in the outer `StorageRepo.commit:<id>` latch that
   `StorageRepo.saveReplicatedBlock` uses. This matches the pre-existing restore path, so it is not
   a regression introduced here, but a reviewer auditing invalidation-vs-concurrent-commit on the
   same block should note both invalidation storage writes share this property.

4. **Cluster path not directly exercised.** `applyConsensusInvalidation` (`cluster-repo.ts`)
   inherits the fix transitively via `onInvalidate → applyInvalidation` with no cluster-path change;
   there is no cluster-level test of a creation-reversal specifically. Cross-collection
   creation-reversal is also covered only by the collection-agnostic mechanism, not an explicit
   cross-collection test.

5. **Doc drift (cosmetic).** Some surrounding comments in `invalidation.ts` / `cascade.ts` still
   speak of "the cascade ticket" in the present/future tense even though the cascade has landed.
   Not changed here beyond what the rename required; flag if you want them tidied.
