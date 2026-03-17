# Equivocation Detection in Cluster Consensus

description: Detect and penalize peers that sign conflicting promises or commits for the same transaction
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (detectEquivocation helper + mergeRecords update)
  - packages/db-p2p/test/byzantine-fault-injection.spec.ts (equivocation attacks test suite)
  - packages/db-p2p/src/reputation/types.ts (PenaltyReason.Equivocation, weight 100)
----

## What was built

Added a `detectEquivocation()` private method to `ClusterMember` that compares existing vs incoming signatures during record merge. When a peer's vote type changes between the existing and incoming record (approve→reject or reject→approve), that constitutes equivocation:

- The equivocating peer's **first-seen signature is preserved** (vote flip is rejected)
- A `PenaltyReason.Equivocation` penalty (weight 100) is reported via the reputation service
- The event is logged with full context (peerId, phase, messageHash, type change)

The `mergeRecords()` method now calls `detectEquivocation()` for both promises and commits instead of using blind object spread (`{ ...existing, ...incoming }`).

## Key design decisions

- **First-seen wins**: Prevents a Byzantine peer from strategically timing a vote flip
- **Type-change only**: Same type re-delivery (retransmission) is not flagged as equivocation — avoids false positives
- **Single equivocation triggers ban**: Weight 100 exceeds the default ban threshold of 80

## Test cases (in `byzantine-fault-injection.spec.ts`, "equivocation attacks" describe block)

1. **Promise equivocation detected**: Byzantine peer sends approve then reject promise → original approve preserved, penalty applied
2. **Commit equivocation detected**: Byzantine peer sends approve then reject commit (5-peer cluster in Promising phase) → original approve preserved, penalty applied
3. **Equivocation triggers ban**: Single equivocation (weight 100) exceeds ban threshold (80) → `isBanned()` returns true
4. **No false positive on re-delivery**: Same peer, same promise type delivered twice → no penalty

## Build/test status

- Build: passes
- All 321 tests pass (including 22 Byzantine fault tests)
