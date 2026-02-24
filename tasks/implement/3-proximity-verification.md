# Proximity Verification for CoordinatorRepo

## Summary

Add proximity verification to `CoordinatorRepo` so nodes reject requests for blocks they're not responsible for. This prevents stale reads, inconsistent writes, and wasted coordination effort on non-proximate nodes.

## Design

### Approach

Use `findCluster` + `computeResponsibility` to determine if this node is among the k-nearest peers for each block ID by XOR distance. Cache results with TTL to avoid repeated network lookups.

**Writes (pend, cancel, commit):** Throw error if not responsible — coordinating consensus from a non-proximate node wastes resources and may produce incorrect results.

**Reads (get):** Log a warning but still serve local data. Reads are already best-effort (the cluster-fetch fallback handles missing blocks). Throwing on reads would be too disruptive for the read path.

### Why computeResponsibility + findCluster

- `findCluster` returns the FRET cohort + always injects self. We can't use it alone since self is always present.
- `computeResponsibility` uses XOR distance between peer multihash bytes and the block key to determine if self is in the top-k nearest peers. This is a proper DHT-style proximity check.
- Together: `findCluster` gives us the peer set, `computeResponsibility` tells us if we belong.

### Cache Strategy

Use `LruMap<BlockId, { inCluster: boolean, expires: number }>` with:
- Max 1000 entries (matching the coordinator cache pattern in `libp2p-key-network.ts`)
- 60-second TTL (responsibility can shift as peers join/leave, but checking every request is wasteful)
- Cache is checked before any network call

## Files

- `packages/db-p2p/src/repo/coordinator-repo.ts` — main implementation
- `packages/db-p2p/src/routing/responsibility.ts` — `computeResponsibility` (existing, no changes)
- `packages/db-core/src/utility/lru-map.ts` — `LruMap` (existing, no changes)
- `packages/db-p2p/test/coordinator-repo-proximity.spec.ts` — new test file

## Implementation

### Phase 1: Store dependencies and add cache

In `CoordinatorRepo`:

1. Store `localPeerId` and `clusterSize` as private class fields (both already available in constructor).
2. Add `LruMap<string, { inCluster: boolean, expires: number }>` responsibility cache (max 1000 entries).
3. Import `computeResponsibility` and `KnownPeer` from `../routing/responsibility.js`, `LruMap` from `@optimystic/db-core`.

### Phase 2: Implement responsibility check

Add private method `isResponsibleForBlock(blockId: BlockId): Promise<boolean>`:

1. Check cache — return cached result if not expired.
2. Call `this.keyNetwork.findCluster(blockIdBytes)` to get cluster peers.
3. Convert `ClusterPeers` → `KnownPeer[]` using `peerIdFromString`.
4. Build `selfKnownPeer` from `this.localPeerId`.
5. Call `computeResponsibility(blockIdBytes, self, others, this.clusterSize)`.
6. Cache the `inCluster` result with 60s TTL.
7. Return `inCluster`.

Special case: if `localPeerId` is not set, skip verification (return true). This preserves backward compatibility for single-node/test setups where `localPeerId` isn't provided.

Add private method `verifyResponsibility(blockIds: BlockId[]): Promise<void>`:

1. For each blockId, call `isResponsibleForBlock`.
2. Collect non-responsible blockIds.
3. If any, throw: `Not responsible for block(s): ${ids.join(', ')}`.
4. Log the verification result.

### Phase 3: Add verification to IRepo methods

- **`pend`**: Call `verifyResponsibility(Object.keys(request.transforms))` before the peerCount check.
- **`cancel`**: Call `verifyResponsibility(actionRef.blockIds)` — replacing the TODO comment.
- **`commit`**: Call `verifyResponsibility(request.blockIds)` before the peerCount check.
- **`get`**: Call `isResponsibleForBlock` per blockId. If not responsible, log warning but continue serving. Remove the old TODO comments.

### Phase 4: Tests

Create `packages/db-p2p/test/coordinator-repo-proximity.spec.ts`:

- Test that writes throw when node is not responsible for a block.
- Test that reads succeed with warning when not responsible.
- Test that writes succeed when node IS responsible.
- Test cache hit/expiry behavior.
- Test backward compatibility: no `localPeerId` → no verification (all operations succeed).
- Test mixed blocks: some responsible, some not → throws for the non-responsible ones.

## TODO

- [ ] Phase 1: Store `localPeerId` and `clusterSize` as fields, add cache and imports
- [ ] Phase 2: Implement `isResponsibleForBlock` and `verifyResponsibility` methods
- [ ] Phase 3: Wire verification into `get`, `pend`, `cancel`, `commit`
- [ ] Phase 4: Write tests
- [ ] Remove old TODO comments from coordinator-repo.ts
- [ ] Verify build passes
- [ ] Verify tests pass
