----
description: Integration tests for multi-node mesh scenarios using mock mesh harness
dependencies: db-p2p (ClusterMember, ClusterCoordinator, CoordinatorRepo, StorageRepo), db-core (IKeyNetwork, ICluster, ClusterPeers)
----

## Overview

Component-integration tests that wire together real ClusterMember + StorageRepo + CoordinatorRepo instances across N nodes, with a mock mesh network that routes cluster RPCs directly between ClusterMember instances (bypassing libp2p transport). This tests the critical consensus and replication paths without heavyweight real-network overhead.

## Architecture

### Mock Mesh Harness (`test/mesh-harness.ts`)

A reusable test utility that creates N interconnected nodes:

```
┌─────────────────────────────────────────────────────────┐
│                    MockMeshKeyNetwork                    │
│  findCluster(key) → all/K-nearest peers as ClusterPeers │
│  findCoordinator(key) → nearest peer by XOR distance    │
└────────────┬───────────────────────────────┬─────────────┘
             │                               │
     ┌───────▼───────┐              ┌───────▼───────┐
     │    Node A      │              │    Node B      │
     │ StorageRepo    │◄────────────►│ StorageRepo    │
     │ ClusterMember  │  mock RPC    │ ClusterMember  │
     │ CoordinatorRepo│  (direct     │ CoordinatorRepo│
     └───────┬────────┘   call)      └───────┬────────┘
             │                               │
             └───────────┬───────────────────┘
                         │
                 ┌───────▼───────┐
                 │    Node C      │
                 │ StorageRepo    │
                 │ ClusterMember  │
                 │ CoordinatorRepo│
                 └────────────────┘
```

**Per-node components (all real, no mocks):**
- `PrivateKey` + `PeerId`: real Ed25519 key pair via `generateKeyPair('Ed25519')`
- `MemoryRawStorage` → `StorageRepo`: real block storage
- `ClusterMember`: real 2PC participant, using `clusterMember()` factory
- `CoordinatorRepo`: real coordination layer using `coordinatorRepo()` factory

**Shared mocks:**

1. **`MockMeshKeyNetwork`** implements `IKeyNetwork`:
   - `findCluster(key)`: returns the appropriate nodes as `ClusterPeers` (all nodes when responsibilityK ≥ nodeCount, otherwise K-nearest by XOR distance using `computeResponsibility`)
   - `findCoordinator(key)`: returns nearest peer by XOR distance
   - Supports injecting failures (empty results, timeouts) for degraded-mode tests

2. **`createClusterClient` factory**: for each node, returns a mock `ICluster` that directly calls `targetNode.clusterMember.update(record)` — bypasses network transport but exercises the full 2PC state machine
   - Can inject per-peer failures (throw on specific peers to simulate unreachable nodes)

3. **`clusterLatestCallback` mock**: for cross-node reads, queries target node's `StorageRepo.get()` directly to discover block revisions

4. **`MockPeerNetwork`** implements `IPeerNetwork`: stub `connect()` (ClusterMember doesn't use it directly)

### Key interfaces

```typescript
interface MeshNode {
	peerId: PeerId;
	privateKey: PrivateKey;
	storageRepo: IRepo;
	clusterMember: ClusterMember;
	coordinatorRepo: CoordinatorRepo;
}

interface MeshOptions {
	responsibilityK: number;
	clusterSize?: number;    // defaults to nodeCount
	superMajorityThreshold?: number;  // defaults to 0.75
	allowClusterDownsize?: boolean;   // defaults to true
}

// Failure injection
interface MeshFailureConfig {
	/** Peers that should fail on cluster update (simulate unreachable) */
	failingPeers?: Set<string>;
	/** Make findCluster return empty (simulate DHT failure) */
	findClusterFails?: boolean;
}
```

### Key files

- `packages/db-p2p/src/cluster/cluster-repo.ts` — ClusterMember (2PC participant)
- `packages/db-p2p/src/repo/cluster-coordinator.ts` — ClusterCoordinator (2PC initiator)
- `packages/db-p2p/src/repo/coordinator-repo.ts` — CoordinatorRepo (IRepo with consensus)
- `packages/db-p2p/src/storage/storage-repo.ts` — StorageRepo (block storage)
- `packages/db-p2p/src/storage/memory-storage.ts` — MemoryRawStorage
- `packages/db-p2p/src/routing/responsibility.ts` — XOR distance, computeResponsibility
- `packages/db-p2p/test/cluster-repo.spec.ts` — existing test patterns (MockRepo, MockPeerNetwork, signing helpers)
- `packages/db-core/src/cluster/structs.ts` — ClusterPeers, ClusterRecord types

## Test Suites (`test/mesh-sanity.spec.ts`)

### Suite 1: 3-node mesh, responsibilityK=1

With K=1, `findCluster` returns only the single nearest node for each key. `CoordinatorRepo.pend()` sees peerCount≤1 and takes the fast path (direct local storage, no consensus).

Tests:
- **Write on responsible node**: `pend` + `commit` through the responsible node's `coordinatorRepo` succeeds via fast path (no cluster consensus)
- **Read from responsible node**: `get` returns the written data
- **Read from non-responsible node**: `get` misses locally, uses `clusterLatestCallback` to discover and fetch from the responsible node — verifies cross-node read works
- **Cache after fetch**: after the cross-node read, a second `get` on the same non-responsible node should find data locally (cached from first fetch)

### Suite 2: 3-node mesh, responsibilityK=3

With K=3, `findCluster` returns all 3 nodes. `CoordinatorRepo.pend()` sees peerCount=3 and initiates full 2PC consensus via `ClusterCoordinator`.

Tests:
- **Full consensus succeeds**: `pend` through any node's `coordinatorRepo` → promise phase collects 3/3 approvals → commit phase distributes to all 3 → all nodes execute the operations
- **All nodes have data**: after commit, `get` from any of the 3 nodes' `coordinatorRepo` returns the committed data from local storage
- **Commit phase partial failure**: one node fails during commit → transaction still succeeds (2/3 ≥ simple majority) — verify remaining 2 nodes have the data
- **Promise phase failure (one peer)**: with default `superMajorityThreshold=0.75`, need `ceil(3 * 0.75) = 3` promises — one peer failing means only 2/3 approvals → transaction fails
- **Lower threshold enables partial-failure tolerance**: with `superMajorityThreshold=0.51`, need `ceil(3 * 0.51) = 2` promises — one peer failing still allows 2/3 approvals → transaction succeeds

### Suite 3: DHT offline / degraded

Tests:
- **findCluster returns empty**: write attempt should throw or fallback gracefully — verify error message is informative
- **findCluster returns subset**: if only 2/3 nodes are returned, consensus adapts to the smaller cluster
- **Slow peer (timeout simulation)**: one peer's `clusterMember.update()` is delayed — verify the coordinator handles the timeout

## TODO

- Create `test/mesh-harness.ts` with `MeshNode`, `MockMeshKeyNetwork`, `createMesh()`, and failure injection
- Extract signing helpers from `cluster-repo.spec.ts` into shared test utility if needed (or import directly)
- Create `test/mesh-sanity.spec.ts` with the three test suites above
- Verify all existing tests still pass (`yarn test:db-p2p`)
- Verify build still passes (`yarn build:db-p2p`)
