description: The group of nodes responsible for a piece of data is chosen by whichever node starts a transaction, and the other nodes never actually agree on that group — so the safety guarantees that assume everyone shares the same group can be broken. Make the responsible group something the nodes agree on, not a private guess.
prereq:
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (findCluster, createMessageHash, executeTransaction — lines ~117-166, 299-332)
  - packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember.mergeRecords 'Peers mismatch' ~438-440; validateSmallCluster ~375-379)
  - docs/correctness.md (§2, Theorem 1, Theorem 2)
  - packages/db-core/src/cohort-topic (MembershipCertV1 threshold-signed membership machinery to reuse)
difficulty: hard
----

Every safety argument in `correctness.md` (Theorem 1, Theorem 2) assumes "the cluster responsible for block B" is a well-defined set with an honest majority. In the implementation it is not agreed: the set is whatever the coordinator's own `findCluster(blockId)` returns at transaction start (`cluster-coordinator.ts:126-166`), frozen into `record.peers`. Critically, the signed message hash covers `record.message` only — **not `record.peers`** (`createMessageHash`, `:117-121`).

Consequences:
- Two coordinators (or one coordinator before/after churn) can produce the same `messageHash` while disagreeing on the peer set. When honest members try to reconcile, `ClusterMember.mergeRecords` hard-throws `'Peers mismatch'` (`cluster-repo.ts:438-440`), so honest members reject one another instead of converging.
- Under partition, a minority re-derives a smaller local cluster and can reach 75% of *that* smaller set. Theorem 2's arithmetic assumes a shared cluster size K that nothing enforces. The `validateSmallCluster` backstop fails open when FRET confidence is low (`:375-379`) — exactly the condition a partition induces.

This is the review's highest-priority design item (P1). The entire dispute/escalation cascade is meaningless if the base cluster set is not agreed, so this ticket must land before the dispute-escalation work.

## Expected behavior

Cluster membership must be part of what is consensually agreed, not a coordinator's private view. Two directions to resolve during design:

- **Fold membership into the signed record.** Include `record.peers` (or a membership epoch/hash derived from it) in the signed message hash so a record is only valid for the exact peer set it was signed against, and mismatched peer sets produce distinct hashes rather than a silent divergence that `mergeRecords` later rejects.
- **Anchor cluster identity on threshold-signed membership certificates.** Reuse the `MembershipCertV1` threshold-signed membership machinery that already exists in the cohort-topic subsystem, so cluster identity is a certificate the whole cluster can independently verify rather than a re-derivation each node performs locally.

Pick one (or a hybrid) and settle it in the plan; do not hand a fork to the implementer. Update `correctness.md` to describe the agreed-membership model that the code will actually enforce.

## Edge cases & interactions

- **Churn between prepare and commit.** A peer legitimately joins or leaves mid-transaction. The design must define whether the frozen membership is honored for the life of the transaction or whether an epoch bump invalidates in-flight records, and how a coordinator recovers.
- **Partition / low FRET confidence.** Define behavior when membership cannot be confidently derived — the current fail-open `validateSmallCluster` path is the hazard. A minority side must not be able to reach super-majority of a self-shrunk cluster.
- **Divergent-but-honest peer sets.** Today `mergeRecords` throws `'Peers mismatch'`; the new model must let honest members converge on a single agreed set rather than reject each other.
- **Interaction with dispute cascade.** The arbitrator/escalation machinery (see design-dispute-synchronous-escalation) inherits whatever membership definition lands here; keep the membership object it consumes stable and verifiable.
- **Migration.** Existing records/logs were signed without peers in the hash — define how already-committed history is treated so the change is not retroactively invalidating.
