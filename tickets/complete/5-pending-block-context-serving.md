description: ActionContext plumbed through cluster fetch path — peers promote and serve pending blocks when context proves action is committed
dependencies: none
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts — ClusterLatestCallback type, fetchBlockFromCluster, queryClusterForLatest
  - packages/db-p2p/test/mesh-harness.ts — per-node clusterLatestCallback with data sync simulation
  - packages/db-p2p/src/libp2p-node-base.ts — production clusterLatestCallback signature update
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts — TEST-5.4.3 integration test
  - packages/db-p2p/test/storage-repo.spec.ts — TEST-5.4.3 local context-driven tests
----

### What was built

Plumbed `ActionContext` through the cluster fetch path so that when a reader queries a peer for a pending block, the peer can use the context to promote the pending block and serve it.

- `ClusterLatestCallback` type now accepts optional `ActionContext` as 3rd param
- `fetchBlockFromCluster` and `queryClusterForLatest` forward context to callbacks
- `CoordinatorRepo.get()` passes `blockGets.context` into the cluster fetch path
- Mesh harness callback is now per-node with data sync replication (simulates SyncClient)
- Production `libp2p-node-base.ts` signature updated (`_context?` unused — SyncClient handles independently)

### Review findings (addressed)

- **TEST-5.4.3 was failing**: test used `responsibilityK: 1` with 3 nodes, making writer discovery non-deterministic (only XOR-closest peer returned by `findCluster`). Fixed by changing to `responsibilityK: 3` so all peers are discoverable — still validates context-driven promotion since data is only pended on one node. Cleaned up stale "BUG" comment.

### Open item (tracked separately)

- `StorageRepo.get()` calls `internalCommit()` (line 48) without the `StorageRepo.commit:${blockId}` lock. The `commit()` method acquires this lock. Idempotency of same actionId/rev makes this safe in practice, but it's a correctness gap for concurrent get-with-context and commit on the same action.

### Test coverage

- **TEST-5.4.3 in coordinator-repo-integration.spec.ts**: pending data on writer peer only, reader queries with context — block promoted and served (passing)
- **TEST-5.4.3 in storage-repo.spec.ts** (3 tests): local context-driven promotion, persistence after promotion, multi-block action promotion (all passing)
- All 325 db-p2p tests pass, build clean
