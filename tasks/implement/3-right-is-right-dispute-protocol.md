description: Dispute escalation protocol — overridden minorities can challenge to a wider audience, with arbitration, reputation effects, and engine health
dependencies: 3-right-is-right-threshold-promises (must be implemented first)
files:
  - packages/db-p2p/src/dispute/ (new module)
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-core/src/cluster/structs.ts
  - packages/db-p2p/src/reputation/types.ts
  - packages/db-p2p/src/reputation/peer-reputation.ts
----

# Dispute Escalation Protocol

## Overview

When a transaction proceeds despite minority rejections (the threshold-promises task makes this possible), the overridden minority can escalate to independent arbitrators.  If the minority is right, the majority gets reputation penalties and the transaction is flagged for invalidation.  If the minority is wrong, *they* are penalized and their engine is flagged for health review.

```
Transaction proceeds with disputed flag
    └── Rejecting peer(s) initiate DisputeChallenge
        └── ArbitrationPool: next-K peers beyond original cluster (XOR distance)
            ├── Each arbitrator re-executes transaction independently
            ├── Submits ArbitrationVote (agree-with-challenger | agree-with-majority | inconclusive)
            └── DisputeResolution (super-majority of arbitrators decides)
                ├── Challenger wins → FalseApproval penalty on majority, tx flagged
                ├── Majority wins → DisputeLost penalty on challenger, engine health check
                └── Inconclusive → lighter penalties, tx flagged as uncertain
```

## Types

```typescript
/** Evidence a validator collects during transaction re-execution */
type ValidationEvidence = {
    computedHash: string;         // Operations hash the validator computed
    engineId: string;             // Engine used
    schemaHash: string;           // Schema hash at time of validation
    blockStateHashes: {           // Snapshot of block states during validation
        [blockId: string]: { revision: number; contentHash: string };
    };
};

/** A challenge initiated by an overridden minority peer */
type DisputeChallenge = {
    disputeId: string;                  // Hash of (messageHash + challengerPeerId + timestamp)
    originalMessageHash: string;        // References the disputed ClusterRecord
    originalRecord: ClusterRecord;      // Full record including all promises
    challengerPeerId: string;
    challengerEvidence: ValidationEvidence;
    signature: string;                  // Challenger signs the dispute
    timestamp: number;
    expiration: number;                 // TTL for arbitration (default: 2 × transaction TTL)
};

/** An arbitrator's independent assessment */
type ArbitrationVote = {
    disputeId: string;
    arbitratorPeerId: string;
    vote: 'agree-with-challenger' | 'agree-with-majority' | 'inconclusive';
    evidence: ValidationEvidence;       // Arbitrator's own re-execution results
    signature: string;
};

/** Final resolution of a dispute */
type DisputeResolution = {
    disputeId: string;
    outcome: 'challenger-wins' | 'majority-wins' | 'inconclusive';
    votes: ArbitrationVote[];
    affectedPeers: {                    // Peers receiving reputation adjustments
        peerId: string;
        reason: PenaltyReason;
    }[];
    timestamp: number;
};
```

## DisputeService

New module at `packages/db-p2p/src/dispute/`.

### Initiation

`ClusterMember` detects that a transaction completed in disputed state (its own promise was a rejection but the super-majority overrode it).  It calls `DisputeService.initiateDispute()` with the ClusterRecord and its own validation evidence.

The service:
1. Constructs a `DisputeChallenge`
2. Selects arbitrators
3. Sends challenge to each arbitrator via the dispute protocol
4. Collects votes with a timeout
5. Determines resolution

### Arbitrator Selection

Use XOR-distance from the block ID (same mechanism as cluster selection) but select the **next K peers** beyond the original cluster.  This ensures:
- Independence: arbitrators are not in the original cluster
- Determinism: all parties agree on who arbitrates
- Availability: XOR-distance selection is already proven in the codebase

```
Original cluster: K closest peers to blockId
Arbitrators:      next K peers (positions K+1 through 2K in XOR ordering)
```

If an arbitrator doesn't have the necessary state (engine, schema, blocks), it votes `inconclusive`.

### Resolution Logic

- **Super-majority of arbitrators agree with challenger** → `challenger-wins`
  - Each majority peer receives `FalseApproval` penalty (weight: 40)
  - Transaction flagged for invalidation (future: transaction-invalidation-cascade task)
  - Client notified if listening

- **Super-majority of arbitrators agree with majority** → `majority-wins`
  - Challenger receives `DisputeLost` penalty (weight: 30)
  - Challenger's engine health counter incremented (see below)

- **Neither side reaches super-majority** → `inconclusive`
  - No reputation penalties
  - Transaction flagged as "unresolved dispute"
  - Could indicate network-wide state divergence

### Engine Health Self-Assessment

Each node tracks its recent validation outcomes:
- When the node's validation is overridden AND the dispute confirms it was wrong, increment a local "disagreement counter"
- If the disagreement rate exceeds a threshold (e.g., 3 disputes lost in 10 minutes), the node:
  1. Logs an engine health warning
  2. Sets a local `unhealthy` flag
  3. Stops participating in promise voting (auto-approves to avoid blocking, or abstains)
  4. Reports health status to peers via existing FRET infrastructure

This is tracked in a new `EngineHealthMonitor` class within the dispute module.

### Protocol

New libp2p protocol: `/db-p2p/dispute/1.0.0`

Messages:
- `{ type: 'challenge', challenge: DisputeChallenge }` — Initiator → Arbitrator
- `{ type: 'vote', vote: ArbitrationVote }` — Arbitrator → Initiator
- `{ type: 'resolution', resolution: DisputeResolution }` — Initiator → All (broadcast)

Uses the same length-prefixed JSON encoding as the cluster protocol.

### Client Awareness

Extend the transaction result/status with a `disputed` flag.  When a client queries transaction status (via `getStatus`), disputed transactions show:
- `status: 'committed-disputed'` — Transaction committed but dispute is active
- `status: 'committed-validated'` — Dispute resolved in favor of the transaction
- `status: 'committed-invalidated'` — Dispute resolved against the transaction

The `NetworkTransactor` surfaces this information through the existing `getStatus` path.

## Key Constraints

- Arbitration is async and non-blocking — the transaction is already committed; the dispute runs in the background
- Arbitrators must have the same engine version and schema to participate meaningfully
- Dispute protocol should be opt-in via config (`disputeEnabled: boolean` on `ClusterConsensusConfig`)
- Timeout for arbitration defaults to 60 seconds; configurable via `disputeArbitrationTimeoutMs`
- A node can only initiate one dispute per transaction (no spam)
- The dispute resolution does NOT reverse the transaction — that's the transaction-invalidation-cascade task

## TODO

### Phase 1: Types and Service Shell
- Define `ValidationEvidence`, `DisputeChallenge`, `ArbitrationVote`, `DisputeResolution` types in `packages/db-p2p/src/dispute/types.ts`
- Create `DisputeService` class with `initiateDispute()`, `handleChallenge()`, `resolveDispute()` methods
- Add `disputeEnabled` and `disputeArbitrationTimeoutMs` to `ClusterConsensusConfig`

### Phase 2: Arbitrator Selection and Communication
- Implement arbitrator selection using XOR-distance (extend `IKeyNetwork` or use `findCluster` offset)
- Implement `/db-p2p/dispute/1.0.0` protocol handler (mirror cluster service pattern)
- Wire DisputeService into libp2p node creation

### Phase 3: Arbitration Flow
- Implement `handleChallenge()` — re-execute transaction, compute evidence, return vote
- Implement `resolveDispute()` — collect votes, determine outcome, apply reputation effects
- Hook `ClusterMember` to auto-initiate disputes when overridden (disputed record + own rejection)

### Phase 4: Engine Health and Client Status
- Implement `EngineHealthMonitor` — tracks disagreement rate, sets unhealthy flag
- Extend transaction status with `disputed` flag in `NetworkTransactor.getStatus()`
- Wire engine health into FRET reporting

### Phase 5: Testing
- Unit tests for DisputeService: initiation, arbitration, resolution outcomes
- Unit tests for arbitrator selection (correct XOR-distance offset)
- Unit tests for EngineHealthMonitor: threshold detection, unhealthy flagging
- Integration tests: full dispute flow from minority rejection through resolution
- Tests for both "challenger wins" and "majority wins" paths
- Tests for inconclusive disputes and timeouts
- Ensure build passes for db-core and db-p2p
