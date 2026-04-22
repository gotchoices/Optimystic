description: Crash-D3 recovery entry point — `IBlockStorage.recover()` / `StorageRepo.recoverBlock(blockId)` reconciles `meta.latest` with the highest contiguous fully-promoted revision after a crash between `promotePendingTransaction` and `setLatest`. Paired with a MemoryRawStorage reference-leak fix (`getMetadata`/`saveMetadata` now `structuredClone`) so in-memory tests match persistent-store semantics for the same crash shape.
dependencies: 5-get-block-throws-on-pending-only-metadata (complete), 5-crash-c-partial-commit-stranded-block (complete)
files:
  - packages/db-p2p/src/storage/memory-storage.ts — `getMetadata`/`saveMetadata` `structuredClone` + pitfall doc-comments.
  - packages/db-p2p/src/storage/i-block-storage.ts — `recover(): Promise<{ reconciled: boolean; latest?: ActionRev }>` added with Crash-D3/D2 doc-comment.
  - packages/db-p2p/src/storage/block-storage.ts — `recover()` implementation.
  - packages/db-p2p/src/storage/storage-repo.ts — `recoverBlock(blockId)` thin wrapper.
  - packages/db-p2p/src/testing/mesh-harness.ts — `MeshNode.storageRepo` type widened `IRepo` → `StorageRepo` (test-surface only).
  - packages/db-p2p/test/mid-ddl-crash.spec.ts — Crash-D3 block: 6 `it`s (was 3 + 1 skipped); adds no-metadata no-op + Crash-D2-boundary invariant tests.
  - docs/internals.md — "Storage Returns References" pitfall referenced from the new doc-comments.
----

## What shipped

### 1. MemoryRawStorage reference-leak fix

`getMetadata` returned the stored `BlockMetadata` reference. `BlockStorage.setLatest` mutates `meta.latest = latest` before calling `saveMetadata`, so when `saveMetadata` threw (crash-D3 shape), the mutation still leaked into RAM, masking on-disk semantics that a persistent backend would get right. Both `getMetadata` and `saveMetadata` now `structuredClone`, bringing the memory backend in line with file/sqlite/leveldb semantics for this crash shape.

### 2. Per-block recovery entry-point

`IBlockStorage.recover()` / `StorageRepo.recoverBlock(blockId)` probes revisions forward from `meta.latest?.rev ?? 0` and advances `meta.latest` to `{ rev: maxRev, actionId: maxActionId }` for the highest contiguous revision whose action is already in the committed log. Stops at the first missing revision (true gap) OR the first revision whose action is NOT in the committed log (Crash-D2 — retry-commit owns that advance). Idempotent and monotonic.

## Testing notes

`packages/db-p2p/test/mid-ddl-crash.spec.ts` — `Mid-DDL crash recovery (solo node) > Crash-D3: crash before setLatest (recoverBlock reconciles)`:

- **raw state after crash**: revision durable, action in committed log, pending removed.
- **retry-commit fails without recovery**: pending gone → throws `Pending action ... not found` (idempotency short-circuit can't fire because `latest` is `undefined`).
- **no reference leak**: raw `meta.latest` stays `undefined`, default read sees empty state.
- **recoverBlock reconciles**: durable invariants pre-recovery, `recoverBlock` advances `latest` to `{ rev: 1, actionId }`, default read materializes the committed block.
- **no-metadata no-op**: `recoverBlock` on unknown block does not throw, metadata remains absent.
- **Crash-D2 boundary**: reproduces Crash-D2 raw shape (revision durable, pending still present, action NOT in committed log); `recoverBlock` leaves `latest` alone — retry-commit owns that advancement.

## Validation

- `npm run build` — clean.
- `npm test` — 421 passing, 5 pending.
- No regressions in Crash-A1, Crash-B, Crash-C, Crash-D2, Tree-DDL specs.

## Usage

```ts
// After a node restart over persistent storage:
for (const blockId of knownBlocks) {
  await repo.recoverBlock(blockId);
}
```

No-op on fully consistent blocks. Complementary to (not duplicative of) `CoordinatorRepo.recoverTransactions()` (2PC cluster-transaction recovery) and the `StorageRepo.commit()` idempotent rollforward (Crash-C partial-commit).

## Out of scope (tracked for follow-up if needed)

- Node-wide auto-recovery at startup — requires an enumerate-all-blocks API on `IRawStorage`. The per-block hook is the unit-level contract; scheduling & enumeration belong to higher layers.
- Promoting `recoverBlock` onto the `IRepo` public interface — kept as a `StorageRepo`-specific method so the mesh-harness widening (test-surface only) doesn't leak a recovery concept into remote repo boundaries.

## Review findings

- Code aligns with the ticket; interface doc-comment pins the Crash-D3/D2 invariants.
- Pitfall doc-comment on `getMetadata`/`saveMetadata` references `docs/internals.md` "Storage Returns References" (section §2) — confirmed present.
- `recover()` correctly handles the fresh-create case (`meta.latest === undefined` → `currentRev = 0`, probes from rev=1).
- `recoverBlock` thread-safety: mutation is monotonic-forward-to-durable state; a racing commit cannot regress. Intended usage is pre-traffic, but racing is safe.
- Mesh-harness type widening is test-surface only — concrete instance was always `StorageRepo`.
