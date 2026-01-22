# Proximity Verification Implementation

## Summary

The `CoordinatorRepo` has TODOs to verify that the node is responsible for blocks before serving requests. Without this verification, nodes may serve requests for blocks they're not responsible for.

## Current State

### coordinator-repo.ts:49-54
```typescript
async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
    // TODO: Verify that we are a proximate node for all block IDs in the request

    // For read operations, just use the local store
    // TODO: Implement read-path cluster verification without creating full 2PC transactions
    return await this.storageRepo.get(blockGets, options);
}
```

## Problem

Without proximity verification:

1. **Stale data**: A node may serve data for blocks it's no longer responsible for
2. **Inconsistent reads**: Different nodes may return different versions of the same block
3. **Security**: Malicious nodes could claim responsibility for any block
4. **Network inefficiency**: Requests may be served by non-optimal nodes

## Existing Infrastructure

### computeResponsibility (responsibility.ts)
```typescript
export function computeResponsibility(
  key: Uint8Array,
  self: KnownPeer,
  others: KnownPeer[],
  k: number
): ResponsibilityResult {
  // Returns { inCluster: boolean, nearest: KnownPeer[] }
}
```

### IKeyNetwork.findCluster
```typescript
findCluster(key: Uint8Array): Promise<ClusterPeers>;
```

## Proposed Implementation

### Option 1: Verify on Every Request
```typescript
async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
    for (const blockId of blockGets.blockIds) {
        const blockIdBytes = new TextEncoder().encode(blockId);
        const cluster = await this.keyNetwork.findCluster(blockIdBytes);
        if (!cluster[this.localPeerId.toString()]) {
            throw new Error(`Not responsible for block ${blockId}`);
        }
    }
    return await this.storageRepo.get(blockGets, options);
}
```

### Option 2: Soft Verification with Redirect
Instead of throwing, redirect the request to the correct coordinator:
```typescript
async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
    const notResponsible = await this.findNonResponsibleBlocks(blockGets.blockIds);
    if (notResponsible.length > 0) {
        // Redirect to correct coordinator
        return await this.redirectToCoordinator(notResponsible, blockGets, options);
    }
    return await this.storageRepo.get(blockGets, options);
}
```

### Option 3: Cached Responsibility Check
Cache responsibility decisions to avoid repeated cluster lookups:
```typescript
private responsibilityCache: Map<string, { inCluster: boolean, expires: number }>;

private async isResponsible(blockId: BlockId): Promise<boolean> {
    const cached = this.responsibilityCache.get(blockId);
    if (cached && cached.expires > Date.now()) {
        return cached.inCluster;
    }
    // Compute and cache
}
```

## Implementation Steps

1. **Add localPeerId to CoordinatorRepo** - Need reference to self for comparison
2. **Implement responsibility check** - Use findCluster or computeResponsibility
3. **Add caching** - Avoid repeated cluster lookups
4. **Handle non-responsible case** - Throw error or redirect
5. **Add tests** - Verify behavior when not responsible

## Related Tasks

- HUNT-5.3.1: Verify proximate node for block IDs
- HUNT-5.3.2: Implement read-path cluster verification

## Priority

**MEDIUM** - Important for correctness in larger networks, but less critical in small/development clusters.

