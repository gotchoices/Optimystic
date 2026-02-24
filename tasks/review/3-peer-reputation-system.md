description: Review peer reputation system implementation
dependencies: none (self-contained within db-p2p)
files:
  - packages/db-p2p/src/reputation/types.ts
  - packages/db-p2p/src/reputation/peer-reputation.ts
  - packages/db-p2p/src/reputation/index.ts
  - packages/db-p2p/test/peer-reputation.spec.ts
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/src/network/network-manager-service.ts
  - packages/db-p2p/src/libp2p-key-network.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/index.ts
----

## Summary

Implemented a local peer reputation scoring service (`PeerReputationService`) that tracks peer misbehavior with weighted penalties, exponential time-based decay, and graduated responses (deprioritize vs ban). Integrated into all key components: ClusterMember, ClusterCoordinator, NetworkManagerService, and Libp2pKeyPeerNetwork.

## What Changed

### New Files
- `reputation/types.ts` — `PenaltyReason` enum (8 categories), `IPeerReputation` interface, `ReputationConfig`, thresholds, default weights
- `reputation/peer-reputation.ts` — `PeerReputationService` with exponential decay scoring, configurable half-life (default 30min), lazy pruning
- `reputation/index.ts` — barrel export

### Integration Points
- **ClusterMember** — Reports `InvalidSignature` when signature verification fails during `validateSignatures()`
- **ClusterCoordinator** — Reports `ConsensusTimeout` when peers fail during promise/commit collection
- **NetworkManagerService** — Replaced inline `blacklist` Map with `IPeerReputation` delegation. `reportBadPeer()` now accepts `PenaltyReason`. `getCoordinator()` now sorts candidates by reputation score (lower = preferred)
- **Libp2pKeyPeerNetwork** — `findCoordinator()` now excludes banned peers and sorts candidates by reputation score
- **createLibp2pNodeBase** — Creates single `PeerReputationService` instance, injects into all components, exposes on node as `node.reputation`

## Testing

- 14 unit tests for `PeerReputationService`: score accumulation, decay, thresholds, custom weights, pruning, reset, summaries
- All 147 db-p2p tests pass
- All 252 db-core tests pass
- TypeScript type-check clean across db-p2p, db-core, reference-peer

## Validation Checklist
- [ ] Review penalty weights: are defaults appropriate?
- [ ] Review threshold values (deprioritize: 20, ban: 80)
- [ ] Verify `findCoordinator` reputation sorting doesn't degrade coordinator selection performance
- [ ] Confirm no breaking changes to external API (reportBadPeer signature changed but had no callers)
- [ ] Check that gossip-reputation task (2-gossip-reputation-blacklisting) can build on this foundation
