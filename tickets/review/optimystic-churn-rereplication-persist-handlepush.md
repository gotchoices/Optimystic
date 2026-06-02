description: Persist pushed blocks in BlockTransferService.handlePush so churn re-replication actually replicates — implemented, needs adversarial review
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, packages/db-p2p/test/block-transfer.spec.ts
----

# Persist pushed blocks on churn re-replication — review handoff

## What shipped

`BlockTransferService.handlePush` previously validated that each pushed payload was
parseable base64-JSON and echoed the block id back as `accepted` **without writing
anything to local storage**. A sender (`spread-on-churn`) therefore saw a successful
push and marked the new owner as `succeeded` while the new owner retained nothing —
the resilience mechanism reported success while leaving the data unreplicated. This
ticket makes the push actually persist a durable, servable replica.

1. **Enriched push wire format** (`block-transfer-service.ts`):
   `BlockTransferRequest` gained an optional
   `blockMeta?: Record<string, { rev: number; actionId: ActionId }>` carrying the
   sender's `state.latest`. `BlockTransferClient.pushBlocks` accepts an optional 4th
   `blockMeta` arg and includes it in the request only when present (older senders
   omit it; backward-compatible).

2. **`saveReplica(block, source?)`** on `IBlockStorage` + `BlockStorage`
   (`block-storage.ts`): seeds metadata if absent, writes `rev → actionId`, the action
   transform (`{ insert: block }`) and the materialized block (reuses the existing
   private `saveRestored`), merges `[rev, rev+1]` into `ranges`, and advances `latest`
   **monotonically**. When `source` is absent it falls back to `rev = 1` and a
   **deterministic** `actionId = hashString(`${blockId}:${JSON.stringify(block)}`)` —
   never random/time-based, so retries stay idempotent. A per-block
   `Latches.acquire('BlockStorage.saveReplica:<id>')` serializes the read-modify-write.
   Returns the effective latest `ActionRev`.

3. **`IBlockReplicaStore`** (`block-transfer-service.ts`) — `extends IRepo` and adds
   `saveReplicatedBlock(blockId, block, source?)`. `StorageRepo implements
   IBlockReplicaStore` (`storage-repo.ts`); the method delegates to
   `createBlockStorage(blockId).saveReplica(...)`. The service's
   `BlockTransferServiceComponents.repo` is now `IBlockReplicaStore`.

4. **`handlePush` rewrite** — decodes + `JSON.parse`s each payload, calls
   `saveReplicatedBlock`, and reports a block as `accepted` **only if it was both
   received AND persisted**; a parse failure or a persist throw surfaces it in
   `missing` so the sender does not falsely treat it as replicated. Stale TODOs removed.

5. **Sender threading** (`spread-on-churn.ts`) — `performSpread` reads
   `blockResult.state?.latest` and passes `{ [blockId]: { rev, actionId } }` to
   `pushBlocks`.

6. **Node wiring** (`libp2p-node-base.ts`) — registered a new `blockTransfer` libp2p
   service wired to the **local `storageRepo`** (not the cluster-coordinated
   `repoProxy`): a pushed replica must land in this node's own storage. Previously the
   service was exported and used by the client but **never registered** as a protocol
   handler, so a push had nowhere to land.

## How to validate

- **Acceptance test** (was `.skip`, now active):
  `packages/db-p2p/test/block-transfer-push-persist.spec.ts` — 6 cases, all green:
  - persists a pushed block so `repo.get` serves it (the original repro),
  - `blockMeta` source rev is honored (`state.latest` mirrors the source, not rev 1),
  - idempotent re-push with the same source meta,
  - monotonic guard: an older rev arriving after a newer one does **not** downgrade
    `latest` (still reported accepted, since the block is durably present),
  - persist failure → block reported `missing`, not `accepted` (throwing-repo stub),
  - unparseable wire payload → `missing`.
- **Run focused:**
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/block-transfer-push-persist.spec.ts" --reporter spec`
- **Full suite:** from `packages/db-p2p`, `yarn build` clean (tsc, silent on success);
  `yarn test` → **472 passing, 7 pending, 0 failing** (~19s). The 7 pending are
  pre-existing env-gated cases (`RUN_LONG_TESTS*`, `OPTIMYSTIC_INTEGRATION`), not mine.
- **MockRepo** in `test/block-transfer.spec.ts` gained `saveReplicatedBlock` to satisfy
  `IBlockReplicaStore`; existing start/stop and coordinator tests unchanged & green.

## Reviewer: where to look hard (known gaps / judgment calls)

These are the soft spots — my tests are a floor, not a finish line.

- **Lock scope vs. concurrent local commit.** `saveReplica` takes a dedicated
  `BlockStorage.saveReplica:<id>` latch, which serializes concurrent *saveReplica*
  calls but does **not** mutually exclude against `StorageRepo.commit`'s
  `StorageRepo.commit:<id>` latch. I judged this acceptable because a churn-replica
  target is a node that just *gained* responsibility and is not the coordinator
  driving commits for that block, so a simultaneous local commit on the exact same
  block is not expected. If the reviewer disagrees, the fix is to have `saveReplica`
  acquire the `StorageRepo.commit:<id>` key instead (couples to StorageRepo's lock
  naming). Worth a hard look — the monotonic guard reads `latest` then writes it
  outside the commit lock, so a concurrent commit advancing `latest` between the read
  and write could be lost; the guard would not catch it.
- **Layering: storage → cluster type import.** `storage-repo.ts` does
  `import type { IBlockReplicaStore } from "../cluster/block-transfer-service.js"`.
  It is type-only and **erased at compile** (verified: no `block-transfer-service`
  string in `dist/.../storage-repo.js`), so there is no runtime cycle — but it is a
  storage-layer file depending on a cluster-layer type. The ticket directed this
  placement; flagging it in case the reviewer prefers the interface relocated to a
  neutral module (e.g. a storage-level `i-*.ts`).
- **No change-event on the replica-persist path.** `saveReplicatedBlock` does **not**
  emit a `CollectionChangeEvent`, so a `Database.watch` consumer on the new owner is
  not woken by a churn-replicated block. The original inline
  `// TODO: emit CollectionChangeEvent here once replicas persist` was removed in favor
  of a tracked backlog ticket (`optimystic-replica-persist-change-notification`) so the
  knowledge isn't buried in a comment. Confirm that's the right call vs. emitting here.
- **Deterministic fallback id determinism.** The fallback `actionId` hashes
  `JSON.stringify(block)`; key-order of `block` is stable for our `{ header }` shape,
  but if blocks ever carry maps/sets/undefined this could vary. Fine for current
  `IBlock`, but a latent assumption.
- **Materialize-on-serve relies on single-revision shortcut.** `materializeBlock`
  returns the materialized block at `latest.actionId` on the first descending
  iteration without applying the synthesized `{ insert: block }` transform. Confirmed
  by the acceptance test, but the synthesized transform is therefore never exercised
  on the serving path — it exists only to satisfy `saveRestored`'s write invariants.
- **Coordinator (rebalance) push path** (`cluster/block-transfer.ts`) pushes without
  `blockMeta`; it now persists on the receiver via the rev-1 fallback. That is a
  strict improvement over the prior "persist nothing", but it does **not** carry source
  rev metadata. Out of scope here (this ticket targets churn-spread), noted for
  completeness.

## Out of scope (filed as backlog)

- `SpreadOnChurnMonitor` is still not driven by the running node
  (`NetworkManagerService.initSpreadOnChurnMonitor` is never called; nothing calls
  `monitor.trackBlock(...)`). Filed `optimystic-spread-on-churn-monitor-wiring`.
- `CollectionChangeEvent` emission on the replica-persist path. Filed
  `optimystic-replica-persist-change-notification`.
