description: Every commit spends one extra storage operation deleting its own pending record, which the commit has already moved to the committed store, so a solo insert costs about 14% more storage work than it should. Stop issuing that delete; nothing else changes.
files:
  - packages/db-p2p/src/storage/block-storage.ts (`setLatest` ~line 310, `recover` ~340, `sweepDeadClaims` ~237, `recordClaim` ~215)
  - packages/db-p2p/test/block-storage.spec.ts (describe 'BlockStorage pending claims — a record claims the slot it was pended at', ~line 1841)
repro: verified
----

# The defect

A pending record is the write a cohort member stores when it promises a pend. Its "claim" is the revision it was pended at, kept in the block's metadata (`BlockMetadata.pendingRevs`, keyed by action id). `sweepDeadClaims(meta, latestRev)` deletes every pending record whose claim is at or below the new latest revision, because such a record can never be promoted.

On the commit path (`StorageRepo.internalCommit`, `storage-repo.ts` ~1411), the order is `saveRevision` → `promotePendingTransaction` → `setLatest`. `promotePendingTransaction` atomically **moves** the committing action's record from pending to committed (pinned by the raw-storage conformance test "promotePendingTransaction moves pending → committed atomically"). But it leaves the action's claim in `pendingRevs`. `setLatest` then sweeps, finds that claim equal to `latest.rev`, and issues `storage.deletePendingTransaction` for a record that is no longer there. It is a no-op delete: wasted work, not a wrong result.

`recover` has the same shape. It advances `latest` over revisions whose action it has confirmed promoted (`getTransaction` returned the committed record), then sweeps. Each recovered action's claim is still on file, so it pays one no-op delete per recovered action.

Reported by sereus (`sereus-83`, its ticket `../sereus/tickets/blocked/solo-insert-cost-rose-with-upstream-pending-claims.md`): solo insert went 80 → 99 raw-storage ops, solo launch 78 → 88. Of that, +11 (insert) and +8 (launch) is this delete. The other +8 on insert is the claim written into metadata at pend time, before the record. That ordering is intended crash safety and stays.

# Reproduction (done in the fix stage)

A `MemoryRawStorage` subclass that records every `deletePendingTransaction` call, then one pend at rev 2 on a block replicated at rev 1, then the commit steps (`saveMaterializedBlock`, `saveRevision`, `promotePendingTransaction`, `setLatest`). Today it records `['a']` (the committing action). The same happens with `recover` after a lost `setLatest` (promote done, `setLatest` never ran): it also records `['a']`.

# Fix (trial-applied and verified in the fix stage, then reverted)

In `setLatest`, drop the committing action's own claim before sweeping. The existing `saveMetadata` persists it, so this adds no write:

```ts
// The committing action's own record was just MOVED by `promotePendingTransaction`; drop its claim
// so the sweep below does not delete a record that is already gone. Any other record claiming a slot
// at or below the new latest is dead.
BlockStorage.recordClaim(meta, latest.actionId, undefined);
await this.sweepDeadClaims(meta, latest.rev);
await this.storage.saveMetadata(this.blockId, meta);
```

In `recover`, collect the action id of every recovered revision in the probe loop (`const recoveredIds: ActionId[] = []`, push next to `maxActionId = actionId`), and drop each one's claim before the sweep:

```ts
for (const id of recoveredIds) BlockStorage.recordClaim(meta, id, undefined);
await this.sweepDeadClaims(meta, maxRev);
```

This is safe in `recover` because the loop only accepts a revision whose action has a committed record, and promotion is an atomic move, so that action has no pending record left. (If a raw backend ever broke that atomicity, dropping the claim would leave a claim-less pending record behind, which readers treat as the strongest kind of reservation. The conformance test guards this. Mention it in the code comment.)

With the trial fix: the repro recorded no deletes on either path, and `block-storage.spec.ts`, `pending-claim.spec.ts` and `member-missed-commit-heals-at-commit.spec.ts` all passed (75 passing). In particular, 'setLatest sweeps a rival record claiming a slot at or below the new latest, and only that' and 'recover sweeps the claims the lost setLatest owed' still pass, so a rival that is really dead is still swept.

**Must still hold:**
- a **rival** record claiming a slot at or below the new latest is still deleted
- at pend time, metadata (the claim) is still written first and the record second
- `pendingRevs` keeps its shape, and the map stays absent when it is empty (`recordClaim` already does this)

**Expected downstream after:** solo insert 88, solo launch about 80 (sereus's figures; this repo has no solo-strand budget spec to check them against).

# TODO

- Apply the `setLatest` change and update the comment above the sweep call (it currently says the committing action's claim "goes here", which is exactly the wasted delete).
- Apply the `recover` change, with a short comment on why dropping recovered actions' claims is safe (the move is atomic).
- Add regression tests to the pending-claims describe in `packages/db-p2p/test/block-storage.spec.ts`, using a `MemoryRawStorage` subclass that counts `deletePendingTransaction`:
  - a solo commit through the `internalCommit` steps issues **zero** `deletePendingTransaction` calls, and `pendingRevs` ends absent;
  - `recover` after a lost `setLatest` issues zero deletes for the recovered action, and still deletes a rival at the same slot (extend or mirror 'recover sweeps the claims the lost setLatest owed');
  - with a rival at the same slot, `setLatest` issues exactly one delete, for the rival only.
- Run `yarn workspace @optimystic/db-p2p test` (or the package's `test` script) and `typecheck`; confirm `member-missed-commit-heals-at-commit.spec.ts` and `pending-claim.spec.ts` stay green.
