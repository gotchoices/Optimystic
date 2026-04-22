description: Add a storage-layer recovery entry-point that reconciles `metadata.latest` with `max(revisions)` for a block after a mid-commit crash between `promotePendingTransaction` and `setLatest`. Without this, the commit is silently invisible on persistent stores because `revisions[rev]=actionId` is durable and the action is in the committed log, but `meta.latest` still points at the prior rev (or is undefined for a fresh block) and retry-commit is rejected ("Pending action not found") since the pending record has already been removed.
dependencies:
  - tickets/fix/5-memory-storage-metadata-reference-leak.md (land first — the DESIRED test can only observe persistent-store behavior once MemoryRawStorage.getMetadata stops returning the stored reference)
  - tickets/review/5-mid-ddl-crash-fault-injection-tests.md (Crash-D3 `DESIRED` skipped test is the unit-level acceptance criterion)
files:
  - packages/db-p2p/src/storage/i-block-storage.ts (add `recover()` to the interface)
  - packages/db-p2p/src/storage/block-storage.ts (implement `recover()`; probes revisions past `meta.latest?.rev ?? 0` and advances)
  - packages/db-p2p/src/storage/storage-repo.ts (expose `recoverBlock(blockId)` that creates the block storage and delegates)
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (unskip Crash-D3 `DESIRED` test and assert the reconciliation)
  - packages/db-p2p/src/repo/coordinator-repo.ts (audit only — confirm `recoverTransactions()` at line 100 remains cluster-transaction-state recovery and does not duplicate this per-block reconciliation)
----

## Design

### Scope

Per-block storage-layer recovery. A `recover()` method on `IBlockStorage` reconciles `meta.latest` with the highest contiguous fully-promoted revision in the revisions table. Surfaced at the `StorageRepo` level as `recoverBlock(blockId: BlockId)` so callers can invoke it without knowing about `IBlockStorage` directly.

Node-wide enumeration (iterating every block on the node at startup) is **out of scope** for this ticket — `IRawStorage` has no block-enumeration API today, and adding one is a backend-specific concern (persistent stores can grow a native index; memory uses Map keys). For now the unit-level acceptance test drives recovery per-known-block, and the cluster-transaction recovery path (`CoordinatorRepo.recoverTransactions()`) stays focused on in-flight coordinator/member state.

### `BlockStorage.recover()` semantics

```
recover(): Promise<{ reconciled: boolean; latest?: ActionRev }>
```

Algorithm:
1. `meta = getMetadata(blockId)`. If `meta === undefined` → return `{ reconciled: false }`.
2. Let `currentRev = meta.latest?.rev ?? 0`.
3. Probe forward from `currentRev + 1`: call `getRevision(blockId, next)`. If undefined, stop.
4. For each probed revision, verify the action has been promoted by checking `getTransaction(blockId, actionId)` is defined. If not defined, **stop** (don't advance past a Crash-D2-style half-state where the revision was written but `promotePendingTransaction` hadn't completed — retry-commit still owns that case).
5. Track `(maxRev, maxActionId)` at the furthest forward promoted revision.
6. If `maxRev > currentRev`, update `meta.latest = { rev: maxRev, actionId: maxActionId }` and call `saveMetadata`.

Edge cases:
- `meta.latest === undefined` + no revisions → no-op (fresh pending-only block, untouched).
- `meta.latest === undefined` + revision at rev=1 that's fully promoted → advance to `{ rev: 1, actionId }` (Crash-D3 fresh-create scenario).
- `meta.latest.rev === N` + revisions at N+1, N+2 all promoted → advance to N+2.
- `meta.latest.rev === N` + revision at N+1 but action NOT yet in committed log (Crash-D2 intermediate) → leave alone; retry-commit is the canonical path for that case.
- Revisions are contiguous by construction (`saveRevision` is called with `rev = previousRev + 1` in `internalCommit`), so probing stops at first missing rev without gap concerns.

### `StorageRepo.recoverBlock(blockId)`

Thin wrapper:
```ts
async recoverBlock(blockId: BlockId): Promise<void> {
  const storage = this.createBlockStorage(blockId);
  await storage.recover();
}
```

No locking is strictly required because the recovery mutation is idempotent and monotonic (advances latest forward only, to a value derivable from durable state). If a concurrent commit is advancing latest from N to N+2 while recover observes revision N+1 and writes latest=N+1, the normal commit will subsequently write latest=N+2 — still correct. In practice recover is intended to run before serving traffic, so contention is unlikely.

### Interaction with existing recovery paths

- `CoordinatorRepo.recoverTransactions()` (coordinator-repo.ts:100) operates on the persisted cluster-transaction state store (2PC coordinator/member states). It does not touch block metadata. It remains unchanged; `recoverBlock` is a separate, complementary path.
- `StorageRepo.commit()` idempotent rollforward (storage-repo.ts:225-247) handles the multi-block partial-commit case (Crash-C) via a retry with the same `(actionId, rev)`. That path doesn't help Crash-D3 because the pending record is gone, which is exactly the gap `recover()` fills.
- `BlockStorage.getBlock()` pending-only short-circuit (block-storage.ts:32-34) continues to return `undefined` for a fresh block with no `latest`. After `recover()` advances `latest`, default reads materialize normally.

### Tests

Unskip `Crash-D3 ... DESIRED: after fixing the reference leak, a recovery entry-point reconciles latest with max(revisions)` in `mid-ddl-crash.spec.ts` (around line 664). With the reference-leak dependency landed, the test should:

1. Seed a pending action for `blockA`.
2. Commit with a `saveMetadata`-`before` crash trigger matching `meta.latest !== undefined`. Verify:
   - `await raw.getMetadata(blockA)` → `meta.latest === undefined` (matches persistent-store behavior post-leak-fix).
   - `await raw.getRevision(blockA, 1)` → `actionId` (durable).
   - `await raw.getTransaction(blockA, actionId)` → defined (action in committed log).
3. Via a fresh mesh, a default read sees empty state (old latest).
4. Call `recovered.nodes[0]!.storageRepo.recoverBlock(blockA)`.
5. Re-read: `final[blockA].state.latest.rev === 1`, block materialized.

Also add a test that `recoverBlock` on a block with no metadata is a no-op (returns cleanly, no error).

Also add a test that `recoverBlock` does NOT advance past a Crash-D2-style state (revision durable, action still pending, not in committed log) — latest remains unchanged. This protects the invariant that materialization can always find the transaction for any rev ≤ latest.

## TODO

- Add `recover(): Promise<{ reconciled: boolean; latest?: ActionRev }>` to `IBlockStorage`.
- Implement `BlockStorage.recover()` per the algorithm above.
- Add `StorageRepo.recoverBlock(blockId: BlockId): Promise<void>`.
- Unskip the `DESIRED` test in `mid-ddl-crash.spec.ts` and wire it to call `recoverBlock`.
- Add the two guard tests above (no-metadata no-op; Crash-D2-state not advanced).
- Build and run `packages/db-p2p` test suite; verify `mid-ddl-crash.spec.ts` passes end-to-end after the reference-leak fix also lands.
