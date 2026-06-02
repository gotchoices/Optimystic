description: Persist pushed blocks in BlockTransferService.handlePush so churn re-replication actually replicates — implemented + reviewed
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, docs/internals.md
----

# Persist pushed blocks on churn re-replication — complete

## What shipped

`BlockTransferService.handlePush` previously validated that each pushed payload was
parseable base64-JSON and echoed the block id back as `accepted` **without persisting
anything**. A sender (`spread-on-churn`) therefore saw a successful push and marked the
new owner as `succeeded` while the new owner retained nothing. This work makes the push
persist a durable, servable replica end-to-end.

- **Enriched push wire format** — `BlockTransferRequest.blockMeta?` carries the sender's
  `state.latest` per block; `pushBlocks` accepts an optional `blockMeta` arg.
- **`saveReplica(block, source?)`** on `IBlockStorage`/`BlockStorage` — seeds metadata,
  writes the action transform + materialized block (via `saveRestored`), merges the
  range, advances `latest` monotonically, falls back to a deterministic rev-1 actionId
  when no source meta. Returns the effective latest `ActionRev`.
- **`IBlockReplicaStore`** (`extends IRepo`, adds `saveReplicatedBlock`) — implemented by
  `StorageRepo`; the service's `repo` component is now this type.
- **`handlePush` rewrite** — decodes, parses, validates, persists; reports `accepted`
  only when both received AND persisted, else surfaces in `missing`.
- **Sender threading** (`spread-on-churn.ts`) — passes source `{ rev, actionId }`.
- **Node wiring** (`libp2p-node-base.ts`) — registers the `blockTransfer` protocol
  handler against the **local** `storageRepo` (previously never registered).

## Validation

- From `packages/db-p2p`: `yarn build` clean (tsc, silent). `yarn test` →
  **474 passing, 7 pending, 0 failing** (~20s). The 7 pending are pre-existing
  env-gated cases (`RUN_LONG_TESTS*`, `OPTIMYSTIC_INTEGRATION`).
- Lint: the package has no lint script and the root `lint` is an `echo` stub; tsc is the
  effective gate and is clean.

## Review findings

Adversarial pass over the implement diff (commit `2627ad5`). The implementer's own
"look hard" list was used as a starting point, not a finish line.

### Found + fixed inline (minor)

1. **Sender ignored the receiver's `missing` signal — the ticket's core goal was not
   actually closed.** `SpreadOnChurnMonitor.performSpread` pushed `targetId` onto
   `succeeded` whenever `pushBlocks` did not *throw*, never inspecting the returned
   `response.missing`. The receiver-side `missing` reporting added by this ticket
   ("so the sender does not falsely treat it as replicated") was dead information: a
   parse/persist failure returns a normal response with `missing=[blockId]`, and the
   sender still recorded success. **Fix:** `performSpread` now routes a target to
   `failed` when `response.missing.includes(blockId)`. Added regression test
   `records a target as failed when the receiver reports the block missing`
   (`spread-on-churn.spec.ts`), with the mock peer-network extended to let a target
   return a non-throwing "rejected" response.

2. **`handlePush` parse-only guard let valid-JSON-but-not-a-block payloads poison
   storage.** `JSON.parse("null")` is valid JSON, so a `null` (or primitive/array)
   payload passed the parse `try/catch`. `saveReplica(null)` then advances metadata but
   `saveRestored` skips `saveMaterializedBlock` for a falsy block — leaving `latest`
   pointing at a revision with **no materialization**, so every later `get()` throws
   `Failed to find materialized block`. **Fix:** `handlePush` now rejects payloads that
   are not a structurally valid block (non-null object with a `header`) as `missing`,
   before persisting. Added regression test `reports missing (and does not poison
   storage) when the payload is valid JSON but not a block`
   (`block-transfer-push-persist.spec.ts`), asserting a subsequent `get` returns empty
   rather than throwing. (The legit sender already guards `if (!blockResult?.block)`, so
   this only hardens the network boundary against a buggy/malicious peer.)

3. **Concurrency race the implementer flagged (monotonic guard vs. concurrent commit).**
   `BlockStorage.saveReplica` read-then-wrote `latest` under its own
   `BlockStorage.saveReplica:<id>` latch, which does **not** mutually exclude against
   `StorageRepo.commit`'s `StorageRepo.commit:<id>` latch. A commit advancing `latest`
   between the guard's read and write could be silently clobbered. **Fix:**
   `StorageRepo.saveReplicatedBlock` now acquires `StorageRepo.commit:<blockId>` around
   the `saveReplica` call. Lock naming stays inside `StorageRepo` (no storage→cluster
   coupling), and there is no lock-order inversion (no path takes the saveReplica latch
   then the commit latch), so no deadlock — verified by the full suite still passing,
   including the push-persist tests that now exercise the nested latches.

4. **Docs out of date.** `docs/internals.md` SpreadOnChurnMonitor section described only
   the sender side. Updated to document the receiver persisting via
   `saveReplicatedBlock` → `saveReplica` (monotonic, durable), the `blockMeta`
   threading, and the sender's `missing`-aware success accounting. `architecture.md`'s
   one-line summary remains accurate and was left as-is.

### Checked — no change needed

- **Protocol wiring.** Client and service both build
  `/optimystic/<networkName>/db-p2p/block-transfer/1.0.0`; the new libp2p service is
  registered against the in-scope local `storageRepo` (not `repoProxy`). Consistent.
- **Interface change blast radius.** `BlockTransferServiceComponents.repo` is now
  `IBlockReplicaStore`; the only constructor site is `libp2p-node-base` (wires
  `storageRepo`, which implements it). No external package constructs the service.
- **saveReplica core logic.** Monotonic skip, idempotency for fixed `(rev, actionId)`,
  range merge, and materialize-on-serve path are correct and covered by the existing 6
  + 1 new persistence tests.
- **Layering.** The `import type { IBlockReplicaStore }` in `storage-repo.ts` is
  type-only and erased at compile (no runtime cycle). Acceptable as directed by the
  source ticket.

### Found — deferred (not actioned here, with reason)

- **No `CollectionChangeEvent` on the replica-persist path.** A `Database.watch`
  consumer on the new owner is not woken by a churn-replicated block. Already filed as
  backlog `optimystic-replica-persist-change-notification`; correct to defer.
- **`SpreadOnChurnMonitor` not driven by the running node**
  (`initSpreadOnChurnMonitor` never called; nothing calls `trackBlock`). Already filed
  as backlog `optimystic-spread-on-churn-monitor-wiring`. Note: `internals.md` still
  claims the monitors are initialized through `NetworkManagerService`; that claim
  becomes true when the wiring ticket lands, so it was left as the intended end-state.
- **Deterministic fallback actionId hashes `JSON.stringify(block)`** — relies on stable
  key order, fine for the current `{ header }` shape; latent if blocks ever carry
  maps/sets/undefined. Acceptable for current `IBlock`.
- **Coordinator (rebalance) push path** (`cluster/block-transfer.ts`) pushes without
  `blockMeta`, persisting via the rev-1 fallback. A strict improvement over the prior
  "persist nothing"; carrying source rev there is out of scope for this churn-spread
  ticket.
- **Redundant inner latch.** `BlockStorage.saveReplica:<id>` is now redundant with the
  outer commit latch when reached via `StorageRepo`, but is harmless defense-in-depth
  for any direct `BlockStorage` caller. Left as-is.

## End
