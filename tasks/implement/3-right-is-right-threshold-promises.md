description: Change promise resolution from unanimity to super-majority so minority rejections don't block consensus
dependencies: cluster-signature-verification (complete), peer-reputation-system (in review)
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-core/src/cluster/structs.ts
  - packages/db-p2p/src/reputation/types.ts
----

# Threshold-Based Promise Resolution

## Problem

Currently, `ClusterMember.getTransactionPhase()` in cluster-repo.ts treats ANY promise rejection as a full transaction rejection:

```typescript
const rejectedPromises = Object.values(record.promises).filter(s => s.type === 'reject');
if (rejectedPromises.length > 0 || ...) {
    return TransactionPhase.Rejected;
}
```

This means a single faulty or compromised node can block any transaction, even though the `ClusterCoordinator` already has super-majority logic that tolerates minority rejections.  The coordinator checks `rejectionCount > maxAllowedRejections` but the member-side unanimity check defeats this — when the coordinator sends the record (containing the minority reject signatures) to members for the commit phase, every member enters `Rejected` state.

## Design

### Change 1: Pass consensus config to ClusterMember

`ClusterMemberComponents` gains a `consensusConfig?: ClusterConsensusConfig` field.  The member uses `superMajorityThreshold` for its own phase determination instead of hardcoded unanimity.

### Change 2: Threshold-based rejection in `getTransactionPhase`

Replace:
```typescript
if (rejectedPromises.length > 0 || ...)
```

With:
```typescript
const approvedPromises = Object.values(record.promises).filter(s => s.type === 'approve');
const superMajority = Math.ceil(peerCount * this.consensusConfig.superMajorityThreshold);
const maxAllowedRejections = peerCount - superMajority;

// Rejected if too many rejections to ever reach super-majority
if (rejectedPromises.length > maxAllowedRejections || this.hasMajority(rejectedCommits.length, peerCount)) {
    return TransactionPhase.Rejected;
}
```

And for the "ready to commit" check, change from `promiseCount === peerCount` to:
```typescript
if (approvedPromises.length >= superMajority && !record.commits[ourId]) {
    return TransactionPhase.OurCommitNeeded;
}
```

### Change 3: Track dispute status on ClusterRecord

When a transaction proceeds despite minority rejections, mark it disputed:

```typescript
// In ClusterRecord (structs.ts):
disputed?: boolean;
disputeEvidence?: {
    rejectingPeers: string[];
    rejectReasons: { [peerId: string]: string };
};
```

The coordinator sets `disputed: true` when `rejectionCount > 0 && approvalCount >= superMajority`.

### Change 4: New PenaltyReasons for dispute outcomes

```typescript
// In PenaltyReason enum (reputation/types.ts):
FalseApproval = 'false-approval',    // Approved an invalid transaction (proven by dispute)
DisputeLost = 'dispute-lost',         // Lost a dispute challenge
```

With default weights:
```typescript
[PenaltyReason.FalseApproval]: 40,
[PenaltyReason.DisputeLost]: 30,
```

### Change 5: Emit dispute event for downstream consumption

When a transaction completes in disputed state, emit a typed event (or callback) so the dispute protocol (separate task) can initiate escalation.  For now, log it and record the dispute evidence on the ClusterRecord.

## Key Constraints

- Backward compatible: `consensusConfig` is optional on ClusterMemberComponents; default behavior matches current unanimity if not provided (maxAllowedRejections = 0 when threshold = 1.0)
- The coordinator already tolerates minority rejections — this task aligns the member to the same threshold
- No new protocols needed — this is a logic change within existing consensus flow

## TODO

- Add `consensusConfig` to `ClusterMemberComponents` interface and thread it through `clusterMember()` factory and `ClusterMember` constructor
- Update `getTransactionPhase()` to use threshold-based rejection logic
- Update the "ready to commit" condition from `promiseCount === peerCount` to `approvedPromises >= superMajority`
- Add `disputed` and `disputeEvidence` fields to `ClusterRecord` type
- Set `disputed: true` on the record in `ClusterCoordinator.executeTransaction()` when minority rejections are present but super-majority is met
- Add `FalseApproval` and `DisputeLost` to `PenaltyReason` enum with default weights
- Wire `consensusConfig` through `createLibp2pNodeBase` and any test helpers
- Update existing tests: cluster-repo.spec.ts tests that assert "any rejection → rejected" should now test against the threshold
- Add new tests:
  - Minority rejection (1 of 5 rejects) → transaction proceeds, `disputed` flag set
  - Rejection at threshold boundary → rejected when rejections exceed `maxAllowedRejections`
  - Default (no config) → backward-compatible unanimity behavior
  - Disputed record carries rejectingPeers and rejectReasons
- Ensure build passes for db-core and db-p2p
