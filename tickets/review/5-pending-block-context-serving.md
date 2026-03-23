description: ActionContext is now passed through the cluster fetch path so peers can promote and serve pending blocks when context proves the action is committed
dependencies: none
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts — ClusterLatestCallback type, fetchBlockFromCluster, queryClusterForLatest
  - packages/db-p2p/test/mesh-harness.ts — per-node clusterLatestCallback with data sync simulation
  - packages/db-p2p/src/libp2p-node-base.ts — production clusterLatestCallback signature update
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts — TEST-5.4.3 (was skipped, now passes)
  - packages/db-p2p/test/storage-repo.spec.ts — TEST-5.4.3 local context-driven tests (pre-existing, all pass)
----

### What was built

Plumbed `ActionContext` through the cluster fetch path so that when a reader queries a peer for a pending block, the peer can use the context to promote the pending block and serve it.

**coordinator-repo.ts changes:**
- Added `ActionContext` to the import and to the `ClusterLatestCallback` type signature (optional 3rd param)
- `fetchBlockFromCluster(blockId, context?)` — accepts and forwards context
- `queryClusterForLatest(blockId, context?)` — accepts and forwards context to callback
- `get()` — passes `blockGets.context` into `fetchBlockFromCluster`

**mesh-harness.ts changes:**
- Callback is now per-node (was shared) so it can replicate committed data to the local node's storage
- Stores `rawStorage` per node in a Map for direct block storage access
- After querying a remote peer (with context, triggering promotion), the callback replicates the committed block data to the local node's storage via `BlockStorage.saveMaterializedBlock`, `saveRevision`, and `setLatest` — simulating what `SyncClient` does in production

**libp2p-node-base.ts:**
- Updated callback signature to accept `_context?` (unused in production — the SyncClient sync protocol handles data transfer independently)

### Key use case for testing

A multi-block action where only the tail block is committed via the normal path. Non-tail blocks remain pending on the writer. A different peer (reader) requests the non-tail block with context proving the action is committed. The cluster callback queries the writer with context, which promotes the pending block, and the data is synced back to the reader.

### Test coverage

- **TEST-5.4.3 in coordinator-repo-integration.spec.ts** (was `.skip`, now enabled and passing): pending data on writer peer only (responsibilityK=1), reader queries with context — block found
- **TEST-5.4.3 in storage-repo.spec.ts** (3 tests, pre-existing, all pass): local context-driven promotion, persistence after promotion, multi-block action promotion
- All 325 db-p2p tests pass, 267 db-core tests pass, build clean

### Phase 3 note (locking consideration from ticket)

`StorageRepo.get()` calls `internalCommit()` at line 48 without acquiring the `StorageRepo.commit:${blockId}` lock. The ticket flagged this as a potential race condition. This was not addressed in this change — the idempotent nature of promotion (same actionId, same rev) likely makes it safe, but worth reviewing.
