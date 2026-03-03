# Proximity Verification for CoordinatorRepo — Review

## Summary

Added proximity verification to `CoordinatorRepo` so nodes reject write requests for blocks they're not members of. This is a defense-in-depth guard: the routing layer (FRET) directs requests to the right node, and this check catches misrouted requests.

## Implementation

### Approach: Cluster Membership Check

`CoordinatorRepo.isResponsibleForBlock(blockId)` calls `findCluster(blockIdBytes)` and checks if `localPeerId` is in the returned `ClusterPeers`. This is simple and correct because:

- In the real `Libp2pKeyPeerNetwork`, `findCluster` includes self in the FRET cohort when the node is responsible
- The check fails when a request arrives at a node that isn't in the cluster (misrouted)
- Results are cached in an `LruMap` with 60s TTL to avoid repeated network lookups

### Write Path (strict)

`pend`, `cancel`, and `commit` call `verifyResponsibility(blockIds)` which throws `Not responsible for block(s): ...` if any block ID fails the check.

### Read Path (soft)

`get` calls `isResponsibleForBlock` per blockId and logs a warning but still serves. Reads are best-effort and the existing cluster-fetch fallback handles missing blocks.

### Fail-Open

If `findCluster` throws (network failure), the check assumes responsible to avoid false rejections. If `localPeerId` is not set (backward compat), all checks pass.

## Files Changed

- `packages/db-p2p/src/repo/coordinator-repo.ts` — Added `isResponsibleForBlock`, `verifyResponsibility`, wired into all IRepo methods
- `packages/db-p2p/test/coordinator-repo-proximity.spec.ts` — **New** test suite (10 tests)
- `packages/db-p2p/test/mesh-harness.ts` — Updated mock `findCluster` to include self per-node (matches real `Libp2pKeyPeerNetwork` behavior)

## Testing

- **Backward compatibility**: No `localPeerId` → no verification
- **Responsible node**: All operations succeed
- **Non-responsible node**: `get` succeeds with warning; `pend`/`cancel`/`commit` throw
- **Caching**: Second call uses cache (no extra `findCluster` call)
- **Fail-open**: Network errors → assumes responsible
- **Mixed blocks**: Error message lists only non-responsible blocks
- **Existing tests**: All 157 db-p2p tests pass, full project build succeeds

## Validation

```
yarn build         # full project — passes
yarn test:db-p2p   # 157 passing (0 failing)
```
