----
description: Review mesh sanity integration tests for multi-node consensus
dependencies: db-p2p (ClusterMember, ClusterCoordinator, CoordinatorRepo, StorageRepo), db-core (IKeyNetwork, ICluster, ClusterPeers)
----

## Summary

Added component-integration tests that wire real ClusterMember + StorageRepo + CoordinatorRepo instances across N nodes with a mock mesh network, testing consensus and coordination paths without real libp2p transport.

## Files Added

- `packages/db-p2p/test/mesh-harness.ts` — reusable `createMesh(nodeCount, options)` factory
- `packages/db-p2p/test/mesh-sanity.spec.ts` — 11 integration tests across 3 suites

## Mesh Harness (`mesh-harness.ts`)

Creates N interconnected nodes with:
- **Per-node (real):** Ed25519 keypair, MemoryRawStorage → StorageRepo → BlockStorage, ClusterMember, CoordinatorRepo
- **Shared mocks:** MockMeshKeyNetwork (XOR-distance routing), direct-call ClusterClient (bypasses transport), ClusterLatestCallback (cross-node revision discovery)
- **Failure injection:** `MeshFailureConfig` with `failingPeers` (Set) and `findClusterFails` (boolean), mutated via `mesh.failures`

## Test Suites

### Suite 1: 3-node mesh, K=1 (fast path — no consensus)
- Write on node succeeds via fast path (peerCount ≤ 1)
- Read from writer returns committed data
- Non-responsible node discovers revision via cluster callback
- Independent writes on different nodes

### Suite 2: 3-node mesh, K=3 (full 2PC consensus)
- Full consensus pend+commit succeeds
- Coordinating node verifies data at expected revision
- Promise phase failure (1/3 unreachable, default threshold=0.75 → fail)
- Lower threshold (0.51) enables 2/3 partial-failure tolerance
- Different blocks written through different coordinators

### Suite 3: DHT offline / degraded
- findCluster returns empty → informative error
- Subset cluster (K=2) adapts consensus to smaller group
- Unreachable peer handled gracefully with lower threshold

## Key Observations

- With current architecture, 2PC consensus achieves agreement but **only the coordinating node** materializes data via direct storageRepo fallback (ClusterMember's `inboundPhase === 'commit'` skip prevents consensus execution on peers)
- Cross-node reads discover revisions via `clusterLatestCallback` but full block sync requires `restoreCallback` on BlockStorage (not wired in mock harness)
- Tests adapted to verify actual behavior rather than ideal replication semantics

## Validation

- `yarn test:db-p2p` — 133 passing (including 11 new mesh tests)
- `yarn build:db-p2p` — clean
