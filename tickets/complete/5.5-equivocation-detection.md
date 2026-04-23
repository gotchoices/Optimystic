# Equivocation Detection in Cluster Consensus

description: Detect and penalize peers that sign conflicting promises or commits for the same transaction
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (detectEquivocation helper + mergeRecords update)
  - packages/db-p2p/test/byzantine-fault-injection.spec.ts (equivocation attacks test suite)
  - packages/db-p2p/src/reputation/types.ts (PenaltyReason.Equivocation, weight 100)
----

## What was built

`detectEquivocation()` private method on `ClusterMember` compares existing vs incoming signatures during `mergeRecords()`. When a peer's vote type changes (approve↔reject) for the same transaction:

- First-seen signature is preserved (vote flip rejected)
- `PenaltyReason.Equivocation` penalty (weight 100) reported via reputation service
- Event logged with full context (peerId, phase, messageHash, type change)

## Key design decisions

- **First-seen wins**: Prevents strategic timing of vote flips
- **Type-change only**: Same-type re-delivery (retransmission) not flagged — avoids false positives
- **Single equivocation triggers ban**: Weight 100 exceeds default ban threshold of 80

## Tests (byzantine-fault-injection.spec.ts, "equivocation attacks")

1. Promise equivocation detected: approve→reject → original preserved, penalty applied
2. Commit equivocation detected: 5-peer cluster, approve→reject commit → original preserved, penalty applied
3. Equivocation triggers ban: weight 100 > threshold 80 → `isBanned()` returns true
4. No false positive on re-delivery: same type delivered twice → no penalty

## Review notes

- Code is clean: SRP, DRY (single method parameterized for promises/commits), optional chaining for missing reputation service
- Documentation updated: `system-review.md` GAPs resolved, `cluster.md` Attack Mitigation section updated
- Build passes, all 321 tests pass (including 22 Byzantine fault tests)
