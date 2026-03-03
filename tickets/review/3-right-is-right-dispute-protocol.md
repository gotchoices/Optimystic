description: Dispute escalation protocol — overridden minorities can challenge to a wider audience, with arbitration, reputation effects, and engine health
dependencies: 3-right-is-right-threshold-promises (implemented)
files:
  - packages/db-p2p/src/dispute/types.ts
  - packages/db-p2p/src/dispute/dispute-service.ts
  - packages/db-p2p/src/dispute/client.ts
  - packages/db-p2p/src/dispute/service.ts
  - packages/db-p2p/src/dispute/engine-health-monitor.ts
  - packages/db-p2p/src/dispute/arbitrator-selection.ts
  - packages/db-p2p/src/dispute/index.ts
  - packages/db-p2p/src/reputation/types.ts (added FalseApproval, DisputeLost penalties)
  - packages/db-core/src/cluster/structs.ts (added disputeEnabled, disputeArbitrationTimeoutMs to ClusterConsensusConfig)
  - packages/db-p2p/src/libp2p-node-base.ts (wired dispute service into node creation)
  - packages/db-p2p/src/index.ts (exports dispute module)
  - packages/db-p2p/test/dispute.spec.ts
----

# What Was Built

## Dispute Escalation Protocol

When a transaction proceeds despite minority rejections (threshold-promises), the overridden minority can escalate to independent arbitrators. The dispute runs asynchronously — the transaction is already committed; the dispute determines whether it was valid.

### Flow

1. **Initiation**: A ClusterMember whose rejection was overridden calls `DisputeService.initiateDispute()` with the ClusterRecord and its own ValidationEvidence.

2. **Arbitrator Selection**: Next K peers beyond the original cluster are selected using XOR-distance (same mechanism as cluster selection, but offset). This ensures independence and determinism.

3. **Challenge**: The dispute challenge (including the full record and challenger's evidence) is sent to all arbitrators.

4. **Arbitration**: Each arbitrator re-executes the transaction independently and submits an ArbitrationVote: `agree-with-challenger`, `agree-with-majority`, or `inconclusive`.

5. **Resolution**: Super-majority of decisive votes determines outcome:
   - **challenger-wins** → FalseApproval penalty (weight 40) on majority peers, transaction flagged
   - **majority-wins** → DisputeLost penalty (weight 30) on challenger, engine health check
   - **inconclusive** → no penalties, transaction flagged as uncertain

### Engine Health Monitor

Each node tracks its dispute losses within a rolling window. If the disagreement rate exceeds a threshold (default: 3 disputes lost in 10 minutes), the node flags itself as unhealthy and stops initiating disputes. Auto-recovers when losses fall below threshold.

### Protocol

New libp2p protocol: `/{prefix}/dispute/1.0.0`
- Messages: challenge → vote, resolution → ack
- Same length-prefixed JSON encoding as cluster protocol
- Opt-in via `disputeEnabled: boolean` on ClusterConsensusConfig

### Penalty Reasons Added

- `PenaltyReason.FalseApproval` (weight: 40) — majority peer approved an invalid transaction
- `PenaltyReason.DisputeLost` (weight: 30) — challenger's rejection was wrong

### Config

- `disputeEnabled` (boolean, default: false) — opt-in dispute protocol
- `disputeArbitrationTimeoutMs` (number, default: 60000) — arbitration timeout
- `engineHealthDisputeThreshold` (number, default: 3) — disputes lost before unhealthy
- `engineHealthWindowMs` (number, default: 600000) — rolling window for health tracking

## Key Testing Scenarios

- EngineHealthMonitor: threshold detection, unhealthy flagging, auto-recovery, reset
- DisputeService.initiateDispute: disabled mode, duplicate prevention, unhealthy skip
- Challenger-wins path: arbitrators agree with challenger, majority penalized
- Majority-wins path: arbitrators agree with majority, challenger penalized
- Inconclusive path: mixed/inconclusive votes, no penalties
- handleChallenge: evidence matching, evidence mismatch, invalid signatures
- resolveDispute: super-majority calculation for all three outcomes
- handleResolution: engine health tracking on false-approval penalty
- Arbitrator selection: XOR-distance ordering, cluster exclusion, edge cases
- Penalty weights: FalseApproval=40, DisputeLost=30
- Full integration: end-to-end dispute from initiation through resolution with mock services

## Build & Test Results

- db-core: 259 tests passing
- db-p2p: 254 tests passing (22 new dispute tests)
- Both packages build cleanly
