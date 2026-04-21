description: A commit that crashes between `promotePendingTransaction` and `setLatest` leaves the block in a half-applied durable state — saveRevision wrote `revisions[rev]=actionId`, promote wrote the action to the committed log and removed it from pending, but `metadata.latest` was not updated. Retry-commit is rejected because the pending record is gone ("Pending action not found"), so there is no built-in path that reconciles latest with the now-durable revision. On any persistent raw storage, a read via the default path sees the OLD latest (undefined in the fresh-create case), making the successful commit silently invisible to readers.
dependencies:
  - tickets/fix/5-memory-storage-metadata-reference-leak.md (must land first so MemoryRawStorage matches persistent-store behavior before this fix can be verified by mid-ddl-crash.spec.ts)
  - tickets/review/5-mid-ddl-crash-fault-injection-tests.md (established the repro; the `DESIRED` skipped test in that spec is the acceptance criterion)
files:
  - packages/db-p2p/src/storage/storage-repo.ts (commit pre-check at 244-253 throws on missing pending; internalCommit sequence at 279-314 is the half-applied region; recovery candidate lives here)
  - packages/db-p2p/src/storage/block-storage.ts (setLatest / getLatest — the stored latest that recovery must reconcile)
  - packages/db-p2p/src/repo/coordinator-repo.ts (already exposes `recoverTransactions()` at line 100 for coordinator-level recovery — check whether extending that path is the right home for this reconciliation, or whether it belongs in StorageRepo)
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (Crash-D3 skipped `DESIRED` test is the unit-level acceptance criterion)
----

## Current behavior

The internal commit sequence is:

```ts
// storage-repo.ts internalCommit, lines 279-314
const transform = await storage.getPendingTransaction(actionId);
// apply transform, materialize...
if (newBlock) await storage.saveMaterializedBlock(actionId, newBlock);
await storage.saveRevision(rev, actionId);
await storage.promotePendingTransaction(actionId);
await storage.setLatest({ actionId, rev });      // ← crash point for this ticket
```

If the process is killed between `promotePendingTransaction` and `setLatest`:
- `revisions[blockId][rev] = actionId` is durable.
- `actions[blockId][actionId] = transform` is durable.
- `pendingActions[blockId][actionId]` has been deleted.
- `metadata.latest` still reflects the previous revision (or `undefined` for a fresh block).

On restart, a retry-commit hits the pre-check at `storage-repo.ts:244-253`, finds no pending action, and throws "Pending action not found". There is no call-path that observes "I have a revision for rev=N with actionId=A, but my latest says rev=N-1" and reconciles.

Reads via the default (no-context) path go through `BlockStorage.getBlock` → `getMetadata` → `meta.latest` and see the OLD latest. The successful rev is silently invisible.

CoordinatorRepo already exposes `recoverTransactions()` (coordinator-repo.ts:100) — check whether that reconciliation covers this case or whether it operates at the cluster level only.

## Desired behavior

On node restart (or lazily on the first read of an affected block), detect the half-state — "revisions table has entries past metadata.latest.rev" — and advance `metadata.latest` to `max(revisions)` with the recorded actionId. This can live in:

- A new `StorageRepo.recover()` / `BlockStorage.recover()` entry-point, called on startup after rebuilding over a persisted raw storage.
- An opportunistic check inside `BlockStorage.getLatest()` or `getBlock()` that reconciles on read.

The first option is cleaner (explicit, called once); the second avoids requiring callers to know about recovery but costs read latency.

## Test / acceptance

The `DESIRED` skipped test in `mid-ddl-crash.spec.ts` (`Crash-D3 ... a recovery entry-point reconciles latest with max(revisions)`) must be unskipped and passing. Once `5-memory-storage-metadata-reference-leak.md` also lands, the test can assert:

1. After crash: `meta.latest === undefined`, `revisions[1] === actionId`, `actions[actionId]` present.
2. A default `repo.get` still sees empty state (old latest).
3. After calling the recovery entry point: `meta.latest.rev === 1` and `repo.get` materializes the block.

## TODO

- Decide recovery shape (startup entry-point vs lazy reconciliation on read). Prefer explicit `recover()` for testability and to keep the read path fast.
- Implement the reconciliation: scan `listRevisions(latest.rev+1, ∞)` (or an equivalent max-revision check) and update latest accordingly.
- Audit interaction with `recoverTransactions()` — ensure the two paths compose, don't duplicate work, and have clear responsibility boundaries.
- Wire a test-harness call into `rebuildCleanMesh` in the mid-ddl-crash spec (or change the spec to call `recover()` directly) so the DESIRED test can be unskipped.
