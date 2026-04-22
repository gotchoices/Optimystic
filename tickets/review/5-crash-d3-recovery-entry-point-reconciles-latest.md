description: Landed together — (1) MemoryRawStorage metadata reference-leak fix (`getMetadata`/`saveMetadata` now clone), and (2) per-block recovery entry-point (`IBlockStorage.recover()` / `StorageRepo.recoverBlock(blockId)`) that reconciles `meta.latest` with the highest contiguous fully-promoted revision after a Crash-D3 mid-commit crash (between `promotePendingTransaction` and `setLatest`). Without these, retry-commit couldn't rescue the crash (pending record gone), and the MemoryRawStorage reference-leak was masking the gap in tests.
dependencies: none — both predecessor tickets (pending-only metadata, crash-c stranded block) already complete.
files:
  - packages/db-p2p/src/storage/memory-storage.ts — `getMetadata`/`saveMetadata` now `structuredClone`; pitfall doc-comments mirror those on `getMaterializedBlock`/`saveMaterializedBlock`.
  - packages/db-p2p/src/storage/i-block-storage.ts — `recover(): Promise<{ reconciled: boolean; latest?: ActionRev }>` added to the interface with doc-comment pinning the Crash-D3 / Crash-D2 invariants.
  - packages/db-p2p/src/storage/block-storage.ts — `recover()` implemented: probes revisions forward from `meta.latest?.rev ?? 0`, stops at the first missing revision OR first revision whose action is not yet in the committed log (preserving Crash-D2 → retry-commit ownership), advances `meta.latest` monotonically, idempotent.
  - packages/db-p2p/src/storage/storage-repo.ts — `recoverBlock(blockId: BlockId): Promise<void>` thin wrapper exposes per-block recovery without leaking `IBlockStorage` to callers.
  - packages/db-p2p/src/testing/mesh-harness.ts — `MeshNode.storageRepo` widened from `IRepo` to `StorageRepo` so tests can invoke `recoverBlock` without casts; internal consumers (cluster-member, coordinator) treat it structurally so no behavioral change.
  - packages/db-p2p/test/mid-ddl-crash.spec.ts — Crash-D3 block rewritten around the fix:
    - third `it` (reference-leak) flipped: now asserts `raw.getMetadata(blockA)?.latest === undefined` and default read sees `{}`.
    - second `it` (retry-commit idempotent) flipped: retry-commit now throws `Pending action ... not found` (pending was promoted; idempotency check can't fire because `latest` is undefined).
    - DESIRED `it.skip` unskipped and expanded: asserts durable revision + committed-log invariants, pre-recovery empty read, then `repo.recoverBlock(blockA)` advances `latest` to `{ rev: 1, actionId }` and the subsequent default read materializes the block.
    - New `it` "recoverBlock on a block with no metadata is a safe no-op" — exercises the `meta === undefined` early-return.
    - New `it` "recoverBlock does NOT advance past a Crash-D2-style state" — reproduces Crash-D2 raw shape (revision durable, pending present, action NOT in committed log), runs `recoverBlock`, asserts `latest` remains `undefined`. Protects the invariant that retry-commit (not recovery) owns advancement past an unpromoted-pending boundary.
----

## Summary of the fix

### 1. Reference-leak (MemoryRawStorage)

Before: `getMetadata` returned the stored object by reference; `BlockStorage.setLatest` did `meta.latest = latest` before calling `saveMetadata`, so a `saveMetadata`-`before` crash would still mutate in-RAM state. This masked Crash-D3 on the memory backend while a persistent store (file/sqlite/leveldb) would correctly leave `latest` untouched.

After: both calls `structuredClone`. MemoryRawStorage now matches persistent-store semantics for this crash scenario.

### 2. Recovery entry-point

Before: after Crash-D3 (saveMetadata throws `before`), pending was gone, revision was durable, action was in the committed log — but `meta.latest` still pointed at the prior rev. Retry-commit threw `Pending action not found`. No path reconciled the state.

After: `recoverBlock(blockId)` probes revisions forward from `meta.latest?.rev ?? 0`. For each probed rev it requires the action to be in the committed log (otherwise stop — Crash-D2 state belongs to retry-commit). If anything advanced, it writes `meta.latest = { rev: maxRev, actionId: maxActionId }` and returns `{ reconciled: true, latest }`.

Semantics:
- Idempotent and monotonic — safe to call repeatedly.
- Stops at first missing revision (revisions are contiguous by `internalCommit` construction).
- Stops at first half-promoted revision — protects the read-path invariant that for any `rev <= latest`, the action is retrievable from the committed log.

## Validation

- `npm run build` — clean (tsc, no errors).
- `npm test` — 421 passing, 5 pending. Specifically:
  - `Mid-DDL crash recovery (solo node) > Crash-D3: crash before setLatest (recoverBlock reconciles)` — all 6 `it`s pass (was 3 passing + 1 skipped before).
  - Crash-A1, Crash-B, Crash-C, Crash-D2, Tree-DDL crash specs unchanged.
  - No regressions anywhere else in the db-p2p suite.

Prior flaky pass on `Fresh-node DDL > 5-node cold-start with one peer down at boot` — pre-existing flakiness, unaffected by this change (passes in isolation and on re-run of the full suite).

## Use cases

- **Post-restart recovery** (persistent stores): after a node restart, for each known block the operator can call `repo.recoverBlock(blockId)` to reconcile any Crash-D3-shaped state. The method is a no-op on fully consistent blocks (returns `{ reconciled: false }`) and on blocks without metadata.
- **Complementary to existing recovery paths** — does not duplicate `CoordinatorRepo.recoverTransactions()` (which recovers 2PC cluster-transaction state via `ClusterCoordinator`) or the `StorageRepo.commit()` idempotent rollforward (which owns Crash-C partial-commit via retry with the same `(actionId, rev)`).

## Out of scope

- Node-wide auto-recovery at startup — requires an enumerate-all-blocks API on `IRawStorage` (backend-specific: persistent stores can grow a native index, memory would use Map keys). The per-block hook is the unit-level contract; scheduling & enumeration belong to higher layers and backend-specific drivers. Tracked for a follow-up if/when it's needed.
- Crash-D2-style advancement — explicitly left to retry-commit by the stop-at-unpromoted-revision guard.

## Review checklist

- Does `recover()` correctly handle the `meta.latest === undefined` + rev=1 fresh-create case? (yes — `currentRev = 0`, probes from 1)
- Does the new pitfall doc-comment on `getMetadata`/`saveMetadata` match the prose in `docs/internals.md` "Storage Returns References"?
- Is `recoverBlock` thread-safe with a concurrent commit? (reasoning: recover's mutation is monotonic-forward-to-durable state; if a commit is racing from N→N+2 and recover sees N+1, it may write N+1; the normal commit then writes N+2 — still correct. In practice `recoverBlock` is intended to run before serving traffic.)
- Does the mesh-harness type widening (`storageRepo: IRepo` → `StorageRepo`) affect any production consumer? (no — the concrete instance was always `StorageRepo`; the type change is test-surface only.)
