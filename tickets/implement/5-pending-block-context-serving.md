description: Pass ActionContext through cluster fetch path so peers can promote and serve pending blocks when context proves the action is committed
dependencies: none (5-context-bootstrap-on-collection-open is the read-side complement)
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts — fetchBlockFromCluster(), queryClusterForLatest(), ClusterLatestCallback type
  - packages/db-p2p/test/mesh-harness.ts — clusterLatestCallback implementation (lines 164-172)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts — reproducing test (TEST-5.4.3)
  - packages/db-p2p/test/storage-repo.spec.ts — local context-driven tests (TEST-5.4.3)
----

### Summary

The `StorageRepo.get()` code at lines 39-51 already correctly handles context-driven promotion of pending blocks when the data is available locally. The gap is in `CoordinatorRepo.fetchBlockFromCluster()`: when a peer lacks the pending data locally, the cluster query mechanism doesn't forward `ActionContext` to remote peers, so those peers can't promote their pending blocks.

### Root cause

`CoordinatorRepo.fetchBlockFromCluster()` calls `queryClusterForLatest()` which calls `ClusterLatestCallback(peerId, blockId)`. This callback queries the remote peer's `storageRepo.get({ blockIds: [blockId] })` — without context. Since the block has never been committed (it's in pending state), the remote peer returns `state.latest = undefined`. The cluster query returns nothing, and the block remains unreachable.

The `ClusterLatestCallback` type signature doesn't accept context:
```typescript
export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId) => Promise<ActionRev | undefined>;
```

### Verified behavior (tests added)

**StorageRepo (3 tests — all pass, TEST-5.4.3 in storage-repo.spec.ts):**
- Context-driven get with pending block: serves the block and promotes it
- After promotion, contextless get finds the block (promotion persists)
- Multi-block action: non-tail block promoted via context after only tail committed normally

**CoordinatorRepo (1 test — fails, reproduces the bug, TEST-5.4.3 in coordinator-repo-integration.spec.ts):**
- Pending data on writer peer only (responsibilityK=1), reader queries with context — block NOT found

### Fix

#### Phase 1: Pass context through cluster fetch path

- Add optional `context?: ActionContext` parameter to `ClusterLatestCallback` type:
  ```typescript
  export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId, context?: ActionContext) => Promise<ActionRev | undefined>;
  ```

- Modify `CoordinatorRepo.fetchBlockFromCluster(blockId)` to accept and forward context:
  ```typescript
  private async fetchBlockFromCluster(blockId: BlockId, context?: ActionContext): Promise<void>
  ```

- Modify `CoordinatorRepo.queryClusterForLatest(blockId)` to accept and forward context:
  ```typescript
  private async queryClusterForLatest(blockId: BlockId, context?: ActionContext): Promise<ActionRev | undefined>
  ```

- Pass context when calling the callback:
  ```typescript
  return withTimeout(this.clusterLatestCallback!(peerId, blockId, context), 3000);
  ```

- In `CoordinatorRepo.get()`, pass `blockGets.context` when calling `fetchBlockFromCluster`:
  ```typescript
  await this.fetchBlockFromCluster(blockId, blockGets.context);
  ```

#### Phase 2: Update callback implementations

- Update `mesh-harness.ts` `clusterLatestCallback` to pass context through to `storageRepo.get()`:
  ```typescript
  const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context?) => {
      const result = await target.storageRepo.get(
          { blockIds: [blockId], context },
          { skipClusterFetch: true }
      );
      return result[blockId]?.state?.latest;
  };
  ```

- Audit any other `ClusterLatestCallback` implementations in the codebase (search for `clusterLatestCallback` assignments).

#### Phase 3: Locking consideration

The existing `StorageRepo.get()` calls `internalCommit()` at line 48 without acquiring the `StorageRepo.commit:${blockId}` lock that the normal `commit()` path uses. This is a potential race condition if a concurrent `commit()` and a context-driven `get()` both try to promote the same block. Consider whether a lock should be added in `get()` around the `internalCommit` call, or whether the idempotent nature of the promotion makes this safe.

### Tests

The reproducing test (TEST-5.4.3 in coordinator-repo-integration.spec.ts) should pass after the fix. The 3 StorageRepo tests (TEST-5.4.3 in storage-repo.spec.ts) already pass and confirm the local promotion path.

### TODO

Phase 1: Plumb context through cluster fetch
- [ ] Add optional `context?: ActionContext` to `ClusterLatestCallback` type in coordinator-repo.ts
- [ ] Add `context` parameter to `fetchBlockFromCluster()` and `queryClusterForLatest()` in CoordinatorRepo
- [ ] Forward context from `CoordinatorRepo.get()` → `fetchBlockFromCluster()` → `queryClusterForLatest()` → callback
- [ ] Ensure the `ActionContext` import is available in coordinator-repo.ts (it's re-exported from db-core)

Phase 2: Update callback implementations
- [ ] Update mesh-harness.ts clusterLatestCallback to pass context to storageRepo.get()
- [ ] Search for other ClusterLatestCallback implementations and update them

Phase 3: Verify
- [ ] Re-enable the skipped reproducing test in coordinator-repo-integration.spec.ts (line ~319, marked `.skip`)
- [ ] Run the full db-p2p test suite — all tests including the new TEST-5.4.3 should pass
- [ ] Run db-core tests to confirm no regressions
- [ ] Run the build
