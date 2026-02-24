description: Implement local peer reputation scoring service with integration into coordinator selection and cluster consensus
dependencies: libp2p networking layer (db-p2p), cluster protocol, NetworkManagerService blacklist
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (new)
  - packages/db-p2p/src/reputation/types.ts (new)
  - packages/db-p2p/src/cluster/cluster-repo.ts (integrate reporting)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (integrate reporting)
  - packages/db-p2p/src/network/network-manager-service.ts (replace inline blacklist with PeerReputationService)
  - packages/db-p2p/src/libp2p-key-network.ts (integrate reputation into coordinator selection)
  - packages/db-p2p/src/libp2p-node-base.ts (wire service)
----

## Overview

A local peer reputation scoring service that tracks misbehavior and integrates with coordinator selection and cluster operations. This is the foundational local scoring engine; the gossip layer (task `2-gossip-reputation-blacklisting`) will build on it later.

## Architecture

### PeerReputationService

A standalone service that replaces the ad-hoc `blacklist` Map currently in `NetworkManagerService`. It provides:
- Weighted penalty categories (not just a raw score)
- Configurable decay (exponential time-based, not just hard expiry)
- Threshold-based banning with graduated responses (deprioritize vs. ban)
- Query API for integration points
- Optional persistence interface for scores surviving restarts

### Penalty Categories & Weights

```typescript
export enum PenaltyReason {
  /** Peer sent a signature that failed cryptographic verification */
  InvalidSignature = 'invalid-signature',
  /** Peer promised conflicting transactions (equivocation) */
  Equivocation = 'equivocation',
  /** Peer's validation logic rejected a valid transaction (repeated false rejections) */
  FalseRejection = 'false-rejection',
  /** Peer failed to respond within timeout during consensus */
  ConsensusTimeout = 'consensus-timeout',
  /** Peer sent a message with mismatched hash */
  InvalidMessageHash = 'invalid-message-hash',
  /** Peer sent an expired transaction */
  ExpiredTransaction = 'expired-transaction',
  /** Generic protocol violation */
  ProtocolViolation = 'protocol-violation',
  /** Connection-level failures (lighter weight) */
  ConnectionFailure = 'connection-failure',
}

// Default penalty weights
const DEFAULT_WEIGHTS: Record<PenaltyReason, number> = {
  [PenaltyReason.InvalidSignature]: 50,       // Severe: cryptographic misbehavior
  [PenaltyReason.Equivocation]: 100,           // Most severe: deliberate double-voting
  [PenaltyReason.FalseRejection]: 10,          // Moderate: could be honest disagreement
  [PenaltyReason.ConsensusTimeout]: 5,         // Light: could be network issues
  [PenaltyReason.InvalidMessageHash]: 50,      // Severe: data corruption or tampering
  [PenaltyReason.ExpiredTransaction]: 3,       // Light: clock skew or slow node
  [PenaltyReason.ProtocolViolation]: 30,       // Moderate-severe
  [PenaltyReason.ConnectionFailure]: 2,        // Light: common in distributed systems
};
```

### Score Model

Each peer has an effective score computed as:

```
effectiveScore = sum(penalty.weight * decayFactor(penalty.timestamp))
decayFactor(t) = Math.pow(0.5, (now - t) / halfLifeMs)
```

Default half-life: 30 minutes. Penalties naturally fade over time without requiring explicit cleanup timers.

### Thresholds

```typescript
export interface ReputationThresholds {
  /** Score above which peer is deprioritized in coordinator selection. Default: 20 */
  deprioritize: number;
  /** Score above which peer is excluded from cluster operations. Default: 80 */
  ban: number;
}
```

### PeerReputationService Interface

```typescript
export interface IPeerReputation {
  /** Record a misbehavior incident */
  reportPeer(peerId: string, reason: PenaltyReason, context?: string): void;

  /** Record successful interaction (provides positive signal) */
  recordSuccess(peerId: string): void;

  /** Get effective score for a peer (0 = clean) */
  getScore(peerId: string): number;

  /** Check if peer should be excluded from operations */
  isBanned(peerId: string): boolean;

  /** Check if peer should be deprioritized */
  isDeprioritized(peerId: string): boolean;

  /** Get summary for diagnostics */
  getReputation(peerId: string): PeerReputationSummary;

  /** Get all tracked peers and their statuses */
  getAllReputations(): Map<string, PeerReputationSummary>;

  /** Reset a peer's reputation (admin/testing) */
  resetPeer(peerId: string): void;
}
```

### Internal Data Structure

```typescript
interface PenaltyRecord {
  reason: PenaltyReason;
  weight: number;
  timestamp: number;
  context?: string;
}

interface PeerRecord {
  penalties: PenaltyRecord[];
  successCount: number;
  lastSuccess: number;
  lastPenalty: number;
}
```

Penalty arrays are pruned lazily: entries older than `4 * halfLifeMs` contribute < 6% and can be dropped on next access.

### Persistence Interface (Optional)

```typescript
export interface ReputationPersistence {
  load(): Promise<Map<string, PeerRecord> | undefined>;
  save(records: Map<string, PeerRecord>): Promise<void>;
}
```

Serialization is straightforward JSON. Persistence is debounced (e.g., every 60s or on significant score change).

## Integration Points

### 1. ClusterMember (cluster-repo.ts)

Report invalid signatures and message hash mismatches detected during `validateRecord()` and `validateSignatures()`:

```typescript
// In validateRecord, catch hash mismatch:
catch (err) {
  this.reputation?.reportPeer(senderPeerId, PenaltyReason.InvalidMessageHash);
  throw err;
}

// In validateSignatures, catch invalid sig:
if (!await this.verifySignature(peerId, promiseHash, signature)) {
  this.reputation?.reportPeer(peerId, PenaltyReason.InvalidSignature);
  throw new Error(...);
}
```

Add `reputation?: IPeerReputation` to `ClusterMemberComponents`.

### 2. ClusterCoordinator (cluster-coordinator.ts)

Report peers that fail to respond during promise/commit collection and peers whose rejections indicate repeated false rejections:

```typescript
// In collectPromises, on peer failure:
summary.push({ peerId: peerIdStr, success: false, error: ... });
this.reputation?.reportPeer(peerIdStr, PenaltyReason.ConsensusTimeout);

// Track rejection patterns — if a peer rejects >N transactions in a window,
// it may be exhibiting byzantine behavior. Only penalize after pattern threshold.
```

Add `reputation?: IPeerReputation` to the constructor.

### 3. NetworkManagerService (network-manager-service.ts)

Replace the inline `blacklist` Map with delegation to `PeerReputationService`:

```typescript
// Replace: this.blacklist (Map<string, {score, expires}>)
// With: this.reputation: IPeerReputation

// Replace: isBlacklisted(peerId)
// With: this.reputation.isBanned(peerId.toString())

// In findNearestPeerToKey and getCluster, use isBanned() for exclusion
// and isDeprioritized() for sorting (deprioritized peers sort last)

// Replace: reportBadPeer(peerId, penalty, ttl)
// With: this.reputation.reportPeer(peerId.toString(), reason)
```

### 4. Libp2pKeyPeerNetwork (libp2p-key-network.ts)

In `findCoordinator`, when filtering FRET neighbors, deprioritized peers should sort after clean peers rather than being excluded entirely. Banned peers are excluded.

```typescript
// Current: ids.filter(id => connectedSet.has(id))
// New: ids.filter(id => connectedSet.has(id) && !reputation.isBanned(id))
//        .sort((a, b) => reputation.getScore(a) - reputation.getScore(b))
```

### 5. Node Wiring (libp2p-node-base.ts)

Create a single `PeerReputationService` instance and inject it into:
- `ClusterMember` (via `clusterMember()`)
- `ClusterCoordinator` (via `coordinatorRepo()`)
- `NetworkManagerService` (replace inline blacklist)
- `Libp2pKeyPeerNetwork` (for coordinator selection)

## Design Decisions

- **Local-only**: No gossip of reputation data in this task. The gossip layer (`2-gossip-reputation-blacklisting`) will add that later by consuming `IPeerReputation` events.
- **Exponential decay** rather than hard expiry: Smoother behavior, no cliff effects.
- **Graduated response**: Deprioritize first (still usable as fallback), ban only for high scores.
- **No positive-reward model**: `recordSuccess` resets consecutive-failure tracking but doesn't subtract from penalty scores. Penalties decay on their own via half-life.
- **Conservative defaults**: Light penalties for network-level issues (timeouts, connection failures), heavy for cryptographic violations (invalid signatures, equivocation).

## Testing Strategy

- Unit tests for `PeerReputationService`: penalty accumulation, decay math, threshold transitions, pruning
- Unit tests for integration: mock reputation service injected into ClusterMember/ClusterCoordinator, verify `reportPeer` called on misbehavior
- Integration test: multi-peer scenario where a misbehaving peer gets deprioritized then banned from coordinator selection

## TODO

### Phase 1: Core Service
- Create `packages/db-p2p/src/reputation/types.ts` with `PenaltyReason`, `IPeerReputation`, thresholds, config types
- Create `packages/db-p2p/src/reputation/peer-reputation.ts` implementing `PeerReputationService`
- Add unit tests for score computation, decay, thresholds, pruning
- Export from `packages/db-p2p/src/reputation/index.ts`

### Phase 2: Integration
- Add `reputation?: IPeerReputation` to `ClusterMemberComponents` and wire reporting into `validateRecord`/`validateSignatures`
- Add `reputation?: IPeerReputation` to `ClusterCoordinator` constructor and wire reporting into promise/commit failure paths
- Replace `NetworkManagerService.blacklist` with `IPeerReputation` delegation — update `reportBadPeer`, `isBlacklisted`, `findNearestPeerToKey`, `getCluster`, `getCoordinator`
- Add reputation-aware sorting in `Libp2pKeyPeerNetwork.findCoordinator`
- Wire `PeerReputationService` instance through `createLibp2pNodeBase`

### Phase 3: Tests
- Integration tests verifying misbehavior detection triggers reputation reporting
- End-to-end test: peer with invalid signatures gets deprioritized then banned
- Verify existing tests still pass with reputation service injected
