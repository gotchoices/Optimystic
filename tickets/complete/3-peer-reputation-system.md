description: Peer reputation system — local scoring with decay, graduated responses, integrated across cluster components
dependencies: none
files:
  - packages/db-p2p/src/reputation/types.ts
  - packages/db-p2p/src/reputation/peer-reputation.ts
  - packages/db-p2p/src/reputation/index.ts
  - packages/db-p2p/test/peer-reputation.spec.ts
  - packages/db-p2p/test/peer-reputation-review.spec.ts
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/src/network/network-manager-service.ts
  - packages/db-p2p/src/libp2p-key-network.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/index.ts
----

## What Was Built

A local peer reputation scoring service (`PeerReputationService`) implementing the `IPeerReputation` interface. Tracks peer misbehavior with weighted penalties, exponential time-based decay (configurable half-life, default 30min), and graduated responses:

- **Deprioritize** (score >= 20): Peer is sorted lower in coordinator/cluster selection
- **Ban** (score >= 80): Peer is excluded from cluster operations entirely

### Penalty Categories (PenaltyReason enum)
| Reason | Default Weight | Where Reported |
|---|---|---|
| Equivocation | 100 | (future) |
| InvalidSignature | 50 | ClusterMember.validateSignatures() |
| InvalidMessageHash | 50 | (future) |
| ProtocolViolation | 30 | (future) |
| FalseRejection | 10 | (future) |
| ConsensusTimeout | 5 | ClusterCoordinator (promise + commit collection) |
| ExpiredTransaction | 3 | (future) |
| ConnectionFailure | 2 | NetworkManagerService.reportBadPeer() |

### Integration Points
- **ClusterMember** — Reports InvalidSignature on failed signature verification
- **ClusterCoordinator** — Reports ConsensusTimeout when peers fail during promise/commit
- **NetworkManagerService** — Replaced inline blacklist Map with IPeerReputation; getCoordinator() sorts by score
- **Libp2pKeyPeerNetwork** — findCoordinator() excludes banned peers, sorts by score
- **createLibp2pNodeBase** — Creates single PeerReputationService, injects into all components, exposes on `node.reputation`

### Key Design Decisions
- Scores use exponential decay (half-life model), not linear — severe offenses remain impactful longer
- Lazy pruning only on reportPeer, not on read paths — avoids overhead on hot paths
- maxPenaltiesPerPeer (default 100) caps memory per peer via hard pruning
- All integration is optional (IPeerReputation?) — no breaking changes to existing APIs
- Single shared instance ensures score consistency across components

## Testing

- **14 original unit tests** covering core operations: accumulation, weights, thresholds, decay, success tracking, summaries, pruning, reset, custom weights
- **21 review tests** (peer-reputation-review.spec.ts) covering IPeerReputation contract independently: clean-slate behavior, threshold boundaries, peer isolation, graduated responses, additive scoring, weight customization, decay convergence, context tracking, exhaustive PenaltyReason coverage, default threshold sanity
- All 191 db-p2p tests pass
- All 252 db-core tests pass
- TypeScript build clean

## Review Notes

- Code is clean and well-structured (~147 lines for the service)
- Interface design is minimal and appropriate
- Time-based decay means scores are always strictly less than the raw weight (never exactly equal) — tests should use margin-based assertions, not exact equality at thresholds
- Dead code block in pruneRecord (lines 142-145) is a documented no-op; harmless
- Gossip-based reputation sharing (ticket 2-gossip-reputation-blacklisting) can build on this foundation — the IPeerReputation interface is extensible

## Usage

```typescript
import { PeerReputationService, PenaltyReason, type IPeerReputation } from '@optimystic/db-p2p';

const reputation = new PeerReputationService({
  halfLifeMs: 30 * 60_000,         // 30 minutes (default)
  thresholds: { deprioritize: 20, ban: 80 },
  maxPenaltiesPerPeer: 100
});

reputation.reportPeer(peerId, PenaltyReason.InvalidSignature, 'optional context');
reputation.recordSuccess(peerId);

if (reputation.isBanned(peerId)) { /* exclude from operations */ }
if (reputation.isDeprioritized(peerId)) { /* sort lower in selection */ }

const summary = reputation.getReputation(peerId);
reputation.resetPeer(peerId); // admin/testing
```
