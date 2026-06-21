description: Undoing a transaction that first created a data block currently either crashes or only leaves a placeholder; make the undo actually remove the created block so storage matches the reverted state.
prereq:
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/dispute/index.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/cascade.spec.ts
difficulty: hard
----

# Delete-restore: reverse a block-creating transaction (and don't throw on created-at-rev>1)

## Reproduction (confirmed)

A throwaway spec was run against the current tree to confirm **case 2** from the source ticket:

```ts
// block A created at rev 1, block B created FRESH at rev 2 (B has no rev-1 content)
await repo.commit({ actionId: 'a1', rev: 1, blockIds: ['A'], ... });   // A@1
await repo.commit({ actionId: 'a2', rev: 2, blockIds: ['B'], ... });   // B@2 (creation)
await computeRevertedBlock(createBlockStorage('B'), 2);
//   → THROWS: "Failed to find materialized block B for revision 1"
```

Root cause of the throw (more precise than the source ticket's guess): `computeRevertedBlock`
(`invalidation.ts:389`) only treats `invalidatedRev <= 1` as a creation. For `invalidatedRev = 2` it calls
`getBlock(invalidatedRev - 1)` = `getBlock(1)`. A freshly-pended block's metadata `ranges` are open-ended
`[[0]]` (seeded by `savePendingTransaction`, never narrowed by `internalCommit`), so `ensureRevision(meta, 1)`
sees rev 1 "in range" and does **not** attempt a restore — instead `materializeBlock` scans `listRevisions(1,1)`,
finds no rev-1 entry for B, and throws `Failed to find materialized block B for revision 1`
(`block-storage.ts:228`). So the `if (!base)` delete-fallback at `invalidation.ts:399` is unreachable for the
creation-at-rev>1 case — the throw fires first.

**Case 1** (creation at `invalidatedRev <= 1`) does not throw: it returns `{ kind: 'delete' }`, but
`applyInvalidation` (`invalidation.ts:535`) only records the `DEFERRED_DELETE_RESTORE` sentinel + logs — it never
physically removes the block, so storage diverges from the logical reverted (absent) state.

Both cases are reachable from `cascadeInvalidate` once a read-dependent that *creates* a fresh block enters the
cascade. The cascade tests never hit this today because every test pre-creates its blocks at a genesis rev-1
`gen`/`genA`/`genB` action (the exact workaround the source ticket calls out) — so no dependent ever creates a
block at rev > 1.

## Architecture of the fix

Three coordinated changes: detection (no throw), a storage delete-transform write path, and wiring the apply
primitive to do the real removal in place of the sentinel-only path.

### 1. Detection — creation regardless of revision (`computeRevertedBlock`)

Replace the `invalidatedRev <= 1` special-case with a general "is there any stored revision strictly before
`invalidatedRev`?" probe. Find the **highest stored revision `< invalidatedRev`** via a descending
`listRevisions(invalidatedRev - 1, 1)` and take the first yielded item (it breaks immediately — same
descending-scan pattern `materializeBlock` already uses, so no new cost class). No such revision ⇒ T_inv created
this block ⇒ `{ kind: 'delete', fromRev }`, at any rev, without throwing. When a prior revision exists,
materialize the base from that exact rev and replay surviving later actions exactly as today.

Sketch (the `invalidatedRev <= 1` guard folds into the probe — when `invalidatedRev <= 1`, `priorRev` stays
`undefined`):

```ts
export async function computeRevertedBlock(blockStorage: IBlockStorage, invalidatedRev: number): Promise<RevertedComputation> {
    const latest = await blockStorage.getLatest();
    const fromRev = latest?.rev ?? invalidatedRev;

    // Highest stored revision strictly before T_inv (the base to roll back to). None ⇒ T_inv created
    // this block ⇒ as-if-absent is a deletion — at ANY rev, without throwing.
    let priorRev: number | undefined;
    if (invalidatedRev > 1) {
        for await (const ar of blockStorage.listRevisions(invalidatedRev - 1, 1)) { priorRev = ar.rev; break; }
    }
    if (priorRev === undefined) {
        return { kind: 'delete', fromRev };
    }
    const base = await blockStorage.getBlock(priorRev);
    if (!base) {
        return { kind: 'delete', fromRev };
    }
    // ... existing later-actions replay onto base.block, guarded by fromRev > invalidatedRev ...
}
```

Note: for the delete branch we intentionally do **not** replay later actions onto an absent base (replaying an
update on `undefined` stays `undefined` anyway, and any later writer of a created-then-reverted block is itself a
read-dependent the cascade re-evaluates and reverts). Document this where the early `return { kind: 'delete' }`
lives.

### 2. Storage delete-transform write path (`IBlockStorage` + `BlockStorage`)

Add a method mirroring `saveReplica`, the forward-revision write the apply primitive already uses for the restore
case:

```ts
/**
 * Writes a forward TOMBSTONE revision that reverses a block creation: persists `rev → actionId`, a
 * `{ delete: true }` transform, NO materialized block, merges `[rev, rev+1]` into ranges, and advances
 * `latest` monotonically. Idempotent for a fixed (rev, actionId); never downgrades latest (no-op when an
 * equal-or-newer revision is already present). Returns the effective latest ActionRev.
 */
saveDeletion(source: ActionRev): Promise<ActionRev>;
```

`BlockStorage.saveDeletion` follows the `saveReplica` body (`block-storage.ts:126`): acquire the
`BlockStorage.saveReplica:<id>` latch (or a sibling), monotonic guard on `meta.latest.rev >= rev`, build a
`BlockArchive` whose single revision has `action.transform = { delete: true }` and **no** `block`
(`saveRestored` already skips materialization when `block` is absent — `block-storage.ts:265`), then seed/advance
metadata + merge the range. `BlockStorage` is the only `IBlockStorage` implementer (the two in `README.md` are
illustrative), so no other production class needs the method.

**Re-materialization ("restore on re-materialization"):** a tombstoned block must read back as *absent*, not
throw. Today `materializeBlock` throws `Block <id> has been deleted` (`block-storage.ts:242`) whenever the
reverse-apply yields `undefined`. Change that path to `return undefined` (widen `materializeBlock`'s return to
`{ block, actionRev } | undefined`; `getBlock` already returns `| undefined`). Keep the *other* throw
(`Failed to find materialized block` at `:228`) — that one is a genuine truncation/missing-materialization error,
not a deletion. Confirmed no test asserts on the "has been deleted" throw. Effect:
  - `getBlock()` / `getBlock(tombstoneRev)` on a deleted block → `undefined` (block absent), matching
    `getBlock`'s "no materialized content" contract.
  - `getBlock(creationRev)` (a historical rev before the tombstone) still materializes the created content — the
    cascade re-evaluator's observed-revision lookup keeps working.

### 3. Wire the real removal (`applyInvalidation`) + retire the sentinel

In `applyInvalidation`'s `computation.kind === 'delete'` branch (`invalidation.ts:535`), replace the
record-and-log-only path with an actual `await storage.saveDeletion({ rev, actionId: revertActionId })` using the
same deterministic `revertActionId = hashString('inv:...:rev')` the restore branch computes (so every member
writes an identical tombstone — determinism preserved). Still push a `RevertedBlock` for the cascade frontier.

A deleted block has no content hash, so the `RevertedBlock.restoredContentHash` still needs a sentinel telling
dependents "the observed content no longer exists → invalidate". Keep a sentinel constant but **rename it** — it
is no longer "deferred":

```ts
// invalidation.ts — replace DEFERRED_DELETE_RESTORE
export const DELETED_BLOCK_RESTORE = 'deleted:block-creation-reverted';
```

The cascade contract is unchanged: `contentEqualityReevaluator` (`cascade.ts:137`) still short-circuits a pair
carrying this sentinel to `invalidate` (observed created content can never equal "absent"). Update the import
(`cascade.ts:6`), the re-export (`index.ts:28`), the doc comments referencing "deferred"/"delete-restore
sentinel" (`invalidation.ts:127-133`, `:374`, `cascade.ts:116-118`), and the two test references
(`invalidation.spec.ts:20`, `:553`, `:576`). If you prefer to keep the old name to minimize churn, that is
acceptable **only** if every "deferred"/"not yet removed" comment is rewritten to say the removal now happens —
but renaming is cleaner and the reference list above is complete.

## Determinism & cascade notes

- `saveDeletion` writes a forward, append-only revision (prior revisions retained) — same shape as the restore
  compensating revision; replaying members converge bit-for-bit on `(rev, actionId, { delete: true })`.
- The cascade's deterministic-re-evaluator invariant holds: a dependent of a deleted block matches the sentinel
  pair and is invalidated without needing the block to materialize.
- `applyConsensusInvalidation` (`cluster-repo.ts:910`) reaches reversal through its `onInvalidate` sink →
  `applyInvalidation`, so it inherits the fix with no cluster-path change.

## Risks / things to verify

- `materializeBlock` returning `undefined` for a tombstone is a behavior change for ALL `{ delete: true }`
  revisions, not just invalidation tombstones. Deletes already exist in the transform model and currently throw;
  this is a latent improvement, but run the full `db-p2p` suite to confirm nothing depended on the throw.
- Open-ended `[[0]]` ranges on freshly-created blocks (the case-2 root cause) mean `getBlock(rev)` for a
  not-yet-existing rev does **not** restore — keep detection on `listRevisions`, not on a `getBlock` try/catch.

## TODO

### Phase 1 — storage delete path
- Add `saveDeletion(source: ActionRev): Promise<ActionRev>` to `IBlockStorage` with the contract doc above.
- Implement `BlockStorage.saveDeletion` modeled on `saveReplica` (tombstone revision, no materialized block,
  monotonic guard, range merge, latch).
- Change `materializeBlock`'s post-reverse-apply `undefined` case from throw to `return undefined`; widen its
  return type and let `getBlock` propagate. Leave the `Failed to find materialized block` throw intact.

### Phase 2 — detection
- Rewrite `computeRevertedBlock` to detect creation via descending `listRevisions(invalidatedRev - 1, 1)`
  (first-yield = highest prior rev; none ⇒ delete), removing the `invalidatedRev <= 1` special-case. Keep the
  later-actions replay for the restore branch.

### Phase 3 — apply + sentinel
- In `applyInvalidation`, replace the delete-branch record-and-log with `storage.saveDeletion(...)` using the
  deterministic `revertActionId`; keep pushing the `RevertedBlock`.
- Rename `DEFERRED_DELETE_RESTORE` → `DELETED_BLOCK_RESTORE` (value `'deleted:block-creation-reverted'`); update
  `invalidation.ts`, `cascade.ts` (import + comparison + doc), `index.ts` re-export, and test references.

### Phase 4 — tests
- `computeRevertedBlock`: block created at rev > 1 (genesis A@1, then B created fresh @2) returns
  `{ kind: 'delete' }` with **no throw** (this is the failing repro). Add a sparse variant (created @2, updated
  @5, invalidate @5 → restore to created content; invalidate @2 → delete).
- `applyInvalidation`: creation reversal (both `invalidatedRev <= 1` and `> 1`) physically removes the block —
  `getBlock()` returns `undefined` afterward — appends a durable entry, `applied: true`, reverted entry carries
  `DELETED_BLOCK_RESTORE`. Update the existing `records a deferred sentinel...` test (`invalidation.spec.ts:540`)
  to assert physical removal + renamed constant.
- `applyInvalidation`: idempotent re-apply of a creation reversal — one entry, one tombstone revision.
- `applyInvalidation`: convergence — two members reverting the same creation write identical `(rev, actionId)`
  tombstones.
- `BlockStorage.saveDeletion`: monotonic/idempotent; `getBlock()` → `undefined` after; historical
  `getBlock(creationRev)` still materializes the created content.
- `cascade.spec.ts`: a read-dependent that **creates** a fresh block at rev > 1 (no genesis pre-creation) is
  itself reverted — exercising the previously-throwing path end-to-end — and its dependents invalidate via the
  sentinel.

### Phase 5 — validate
- `cd packages/db-p2p && yarn build 2>&1 | tee /tmp/build.log` (type-check the IBlockStorage addition).
- `cd packages/db-p2p && yarn test:verbose 2>&1 | tee /tmp/test.log` — stream output (idle-timeout safe). Focus
  on `invalidation.spec.ts`, `cascade.spec.ts`, and any block-storage/cluster specs touching deletion. If a
  failure is clearly pre-existing and unrelated to this diff, follow the pre-existing-error protocol.
