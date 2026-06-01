----
description: Persist pushed blocks in BlockTransferService.handlePush so churn re-replication actually replicates
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/src/libp2p-node-base.ts
----

# Persist pushed blocks on churn re-replication

## Problem (confirmed)

`BlockTransferService.handlePush` (`packages/db-p2p/src/cluster/block-transfer-service.ts:133-158`)
validates that each pushed payload is parseable base64-JSON and then echoes the
block id back as `accepted` — **without writing anything to local storage**. A
sender (`spread-on-churn`, `packages/db-p2p/src/cluster/spread-on-churn.ts:218`)
therefore sees a successful push and marks the new owner as `succeeded`, while the
new owner retains nothing. After the departing peer is gone the block has no
durable replica. The resilience mechanism reports success while leaving the data
unreplicated.

A reproduction/acceptance test already exists and is **skipped** at
`packages/db-p2p/test/block-transfer-push-persist.spec.ts`. It drives a real
`StorageRepo` + `MemoryRawStorage` through `handlePush`, asserts the block is
reported accepted (passes today), then asserts `repo.get` returns the block
(fails today: `expected undefined not to be undefined`). The implement stage must
remove `.skip` and make it pass.

## Root cause analysis

Two coupled gaps:

1. **No persistence call.** `handlePush` never writes the accepted block. The
   original `TODO` (line 130-132) deferred this to "RebalanceMonitor integrates
   with `BlockStorage.saveRestored()`".

2. **Lossy wire format.** The push request carries only a serialized `IBlock`
   (`spread-on-churn.ts:204` → `JSON.stringify(blockResult.block)`), dropping the
   source's `state.latest` (`ActionRev` = `{ rev, actionId }`) and the action
   transform. A durable, *servable* revision in this storage model requires more
   than the raw block — see below.

### What "a durable restored block" requires

For `BlockStorage.getBlock(undefined)` to later serve the replica, local storage
must hold, for the block:

- `metadata.latest = { rev, actionId }` (else `getBlock` treats it as
  pending-only and returns `undefined` — see `block-storage.ts:32-34`),
- `metadata.ranges` covering `rev`,
- a revision entry `rev → actionId`,
- a materialized block at `actionId`,
- a transaction (Transform) at `actionId`.

The existing private `BlockStorage.saveRestored(archive)` (`block-storage.ts:204-216`)
writes the revision/transaction/materialized triple from a `BlockArchive`, but it
does **not** set `latest` or `ranges` — its caller `ensureRevision`
(`block-storage.ts:142-150`) does that, and that path assumes metadata already
exists. A brand-new churn replica has **no metadata at all**, so `saveRestored`
alone is insufficient; we need a path that also seeds metadata + `latest` +
`ranges`.

Note on the transform: when exactly one materialized revision (= `latest`) is
stored, `materializeBlock` (`block-storage.ts:157-197`) finds the materialized
block at `latest.actionId` on the first iteration and returns it **without reading
any transform**. So a synthesized `{ insert: block }` transform is only needed to
satisfy `saveRestored`'s write invariants / future log integrity; it is never
applied on the serving path. `{ insert: block }` is a valid block-level
`Transform` (`packages/db-core/src/transform/struct.ts:17`).

## Design / approach

### 1. Enrich the push wire format with source revision metadata

The sender already has `blockResult.state.latest` from `repo.get`. Carry it so the
replica's `latest` matches the source instead of being fabricated.

In `BlockTransferRequest` (`block-transfer-service.ts:20-28`) add an optional field:

```ts
/** For push: source revision metadata per block ID (rev + actionId). */
blockMeta?: Record<string, { rev: number; actionId: ActionId }>;
```

In `BlockTransferClient.pushBlocks`, accept and serialize this metadata. In
`spread-on-churn.performSpread`, read `blockResult.state?.latest` and pass it
through (`spread-on-churn.ts:197-218`). Keep `blockMeta` optional so an older
sender (no metadata) still works via the fallback below.

### 2. Add a local "save replica" persistence path

`handlePush` must write to **local** storage. Add a method that seeds metadata,
writes the single revision, and sets `latest` monotonically.

- Add to `IBlockStorage` (`i-block-storage.ts`) and implement in `BlockStorage`
  (`block-storage.ts`), e.g.:

  ```ts
  /**
   * Persist a replica of a block received out-of-band (churn re-replication).
   * Seeds metadata if absent, writes rev → actionId, the action transform, and the
   * materialized block, sets ranges to cover rev, and advances latest monotonically.
   * No-op (still durable) if a >= rev is already present. Idempotent for a fixed
   * (rev, actionId). Returns the effective latest ActionRev.
   */
  saveReplica(block: IBlock, source?: ActionRev): Promise<ActionRev>;
  ```

  Implementation notes:
  - If `source` is provided, use `source.rev` / `source.actionId`. Otherwise
    fall back to `rev = 1` and a **deterministic** `actionId` derived from the
    block (e.g. hash of `blockId` + serialized block) so retries stay idempotent —
    do NOT use `Math.random()`/`Date.now()` for the id (mirrors the repo's
    determinism requirements; randomness would make every retry a new revision).
  - Build `archive = { blockId, revisions: { [rev]: { action: { actionId, rev, transform: { insert: block } }, block } }, range: [rev, rev+1] }` and reuse the
    existing `saveRestored` logic (extract it or call it).
  - Monotonic guard: read current `meta.latest`; if it exists and
    `meta.latest.rev >= rev`, skip the metadata/`latest` write (we already hold an
    equal-or-newer revision) but still treat the block as durably present.
  - Seed metadata when absent, set `meta.latest = { rev, actionId }`, and merge
    `[rev, rev+1]` into `meta.ranges` (use `mergeRanges` as `ensureRevision` does).
  - Take the same `Latches.acquire` lock pattern `ensureRevision` uses to stay
    safe against concurrent commits on the same block.

- Expose it from `StorageRepo` (`storage-repo.ts`) so the service can reach it via
  `createBlockStorage`, e.g. `saveReplicatedBlock(blockId, block, source?)` that
  does `this.createBlockStorage(blockId).saveReplica(block, source)`.

### 3. Wire the service to the local store and persist in handlePush

The service currently holds `repo: IRepo`. In `libp2p-node-base.ts` the running
node's `repoProxy` routes to the **cluster-coordinated** repo, which is the wrong
target for a local replica. The service must persist into the **local**
`storageRepo`.

- Define a narrow capability in db-p2p (so `MockRepo` in tests can implement it),
  e.g.:

  ```ts
  export interface IBlockReplicaStore extends IRepo {
    saveReplicatedBlock(blockId: BlockId, block: IBlock, source?: ActionRev): Promise<void>;
  }
  ```

  `StorageRepo` implements it. Change `BlockTransferServiceComponents.repo` to
  `IBlockReplicaStore` (it still needs `get` for `handlePull`).

- Rewrite `handlePush` so that for each block it:
  1. decodes + `JSON.parse`s the payload into an `IBlock` (existing validation),
  2. calls `saveReplicatedBlock(blockId, block, blockMeta?.[blockId])`,
  3. on success → add to `response.blocks` (accepted),
  4. on parse **or** persist failure → push to `response.missing`.

  Only blocks that are both received and successfully persisted are reported
  accepted; a block that fails to persist must surface as missing so the sender
  does not falsely treat it as replicated. Remove the stale `TODO` comment.

### 4. Node wiring

Register `blockTransferService` in `libp2p-node-base.ts` services (it is currently
exported and used by `spread-on-churn`'s client but **never registered** as a
protocol handler), wired with the **local `storageRepo`** as its
`IBlockReplicaStore`. Without a registered handler the push has nowhere to land.

## Out of scope / noted gaps (do NOT expand this ticket)

- `NetworkManagerService.initSpreadOnChurnMonitor` is defined but **never called**,
  and no code calls `monitor.trackBlock(...)`. So even after this fix the
  churn-spread monitor is still not driven by the running node. That is a separate
  pre-existing wiring gap — if it is not already tracked, file a `tickets/backlog/`
  ticket ("wire SpreadOnChurnMonitor into the node + track owned blocks"). This
  ticket's responsibility ends at: a registered, persisting `handlePush` plus the
  enriched wire format, proven by the acceptance test.
- `handlePull` already serializes `IBlock` to match the push wire format; leave it.

## TODO

- [ ] Add `blockMeta?: Record<string, { rev: number; actionId: ActionId }>` to
      `BlockTransferRequest`; thread it through `BlockTransferClient.pushBlocks` and
      `spread-on-churn.performSpread` (read `blockResult.state?.latest`).
- [ ] Add `saveReplica(block, source?)` to `IBlockStorage` + `BlockStorage`
      (seed metadata, write revision/transaction/materialized via existing
      `saveRestored` logic, merge ranges, advance `latest` monotonically, lock,
      deterministic fallback id when `source` absent).
- [ ] Add `IBlockReplicaStore` (extends `IRepo`) + implement
      `saveReplicatedBlock(blockId, block, source?)` on `StorageRepo`.
- [ ] Rewrite `handlePush` to persist via `saveReplicatedBlock` and report only
      received-AND-persisted blocks as accepted; remove the stale TODO.
- [ ] Change `BlockTransferServiceComponents.repo` to `IBlockReplicaStore`; update
      `MockRepo` in `test/block-transfer.spec.ts` to implement the new method.
- [ ] Register `blockTransferService` in `libp2p-node-base.ts` wired to the local
      `storageRepo`.
- [ ] Remove `.skip` from `test/block-transfer-push-persist.spec.ts` and make it
      pass; add coverage for: idempotent re-push (same source meta), monotonic
      guard (incoming rev <= local latest does not downgrade), and persist-failure
      → reported as missing.
- [ ] `yarn build` and `yarn test` green in `packages/db-p2p` (stream output, e.g.
      `yarn test 2>&1 | tee /tmp/db-p2p-test.log`).
- [ ] If `SpreadOnChurnMonitor` wiring is not already tracked, file a
      `tickets/backlog/` ticket for it (see "Out of scope").
