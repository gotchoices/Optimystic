description: Threshold-based promise resolution — minority rejections no longer block consensus
dependencies: cluster-signature-verification (complete), peer-reputation-system (in review)
architecture: docs/right-is-right.md
status: implemented (V1 — threshold override; target is unanimity-required with synchronous dispute escalation per architecture doc)
files:
  - packages/db-core/src/cluster/structs.ts
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/cluster-repo.spec.ts
  - packages/db-p2p/test/mesh-harness.ts
----

# What Was Built

Changed `ClusterMember.getTransactionPhase()` from unanimity-based promise resolution to threshold-based (super-majority) resolution, aligning the member-side logic with the coordinator's existing super-majority tolerance.

## Changes

### ClusterRecord type (structs.ts)
Added `disputed?: boolean` and `disputeEvidence?: { rejectingPeers: string[]; rejectReasons: { [peerId: string]: string } }` fields to track when a transaction proceeds despite minority objections.

### ClusterMember (cluster-repo.ts)
- Added `consensusConfig?: ClusterConsensusConfig` to `ClusterMemberComponents` interface
- Threaded config through factory and constructor; defaults to threshold 1.0 (unanimity) when not provided
- `getTransactionPhase()` now uses `superMajorityThreshold` to compute `maxAllowedRejections` — rejects only when rejections exceed `peerCount - ceil(peerCount * threshold)`
- "Ready to commit" condition changed from `promiseCount === peerCount` to `approvedPromises >= superMajority`

### ClusterCoordinator (cluster-coordinator.ts)
Sets `disputed: true` with evidence (rejectingPeers, rejectReasons) on the ClusterRecord when `rejectionCount > 0 && approvalCount >= superMajority`.

### Wiring (libp2p-node-base.ts, mesh-harness.ts)
- `createLibp2pNodeBase` now constructs a `consensusConfig` object and passes it to both `clusterMember()` and `coordinatorRepo()` (DRY refactor — was duplicated before)
- Test mesh-harness passes `consensusConfig` to cluster members

### PenaltyReasons (types.ts)
`FalseApproval` (weight 40) and `DisputeLost` (weight 30) were already present — no changes needed.

## Testing

### Existing tests (30 original, all passing)
All pre-existing cluster-repo.spec.ts tests continue to pass because the default threshold (1.0) preserves unanimity behavior.

### New tests (4 added in `threshold-based promise resolution` suite)
- **Minority rejection (1 of 5 rejects)**: With threshold 0.75 and 5 peers, superMajority=4. 4 approvals + 1 rejection → transaction proceeds to commit.
- **Rejection at threshold boundary**: 3 approvals + 2 rejections with 5 peers → maxAllowedRejections=1, so 2 rejections → rejected.
- **Default (no config) unanimity**: 2-peer cluster with no consensusConfig → any rejection blocks (backward compatible).
- **Disputed record evidence**: Verifies `disputed` flag and `disputeEvidence` fields carry correct peer/reason data.

### Full suite
- db-core: 259 passing
- db-p2p: 258 passing (includes 34 cluster-repo tests)

## Usage / Validation Notes

- To enable threshold-based resolution, pass `consensusConfig` with `superMajorityThreshold < 1.0` when creating a `ClusterMember`
- In production (`libp2p-node-base.ts`), the member now shares the same threshold as the coordinator (default 0.67)
- Consumers should check `record.disputed` after consensus to detect minority-objection transactions
- The dispute evidence is recorded but not yet acted on — the dispute protocol (separate ticket) will consume it

> **Note**: The target architecture (see `docs/right-is-right.md`) reverses the threshold model: instead of overriding minority rejections via super-majority, any validity disagreement will block the transaction and trigger synchronous cascading escalation. The threshold-based code serves as scaffolding for V1 but will be replaced by a unanimity-required model where disputes are resolved before commit.
