# Correctness Properties of the Optimystic Protocol

This document states the properties that Optimystic guarantees, the assumptions under which they hold, and the mechanisms that enforce them. It is structured as a series of theorems with informal proof sketches, intended as a foundation for eventual formal verification.

For implementation details, see [transactions.md](transactions.md), [right-is-right.md](right-is-right.md), and [internals.md](internals.md).

---

## 1. System Model

### 1.1 Network

**Asynchronous with eventual delivery.** Messages between non-partitioned honest nodes may be delayed or reordered but are eventually delivered. There is no bound on message delay, but transactions carry an expiration timestamp that provides a practical upper bound on waiting.

**Partitions are possible.** The network may partition into disjoint subsets. During a partition, nodes in different subsets cannot communicate. Partitions eventually heal.

### 1.2 Nodes

**Crash-recovery.** Honest nodes may crash at any point and restart. On recovery, nodes restore persisted 2PC state and resume protocol participation. Volatile state (in-flight messages, uncommitted overlays) is lost on crash.

**Byzantine adversary.** Up to *f* nodes may be Byzantine: they can send arbitrary messages, withhold messages, equivocate (send conflicting messages to different peers), or collude. Byzantine nodes are computationally bounded (cannot break cryptographic primitives).

### 1.3 Cryptographic Assumptions

- **Ed25519 signatures are existentially unforgeable** under chosen-message attack. No adversary can produce a valid signature for a public key without the corresponding private key.
- **SHA-256 is collision-resistant.** No adversary can find two distinct inputs that hash to the same output.
- **Node identity is bound to an Ed25519 key pair.** A node's peer ID is derived from its public key. Creating a new identity requires generating a new key pair (Sybil cost is bounded by key generation, not by protocol participation).

### 1.4 Execution Model

- **Deterministic transaction execution.** Given identical schema (verified by schema hash), identical base state (verified by read dependencies), identical engine (verified by engine ID), and identical statements with parameters, any two correct validators produce identical block operations.
- **Non-deterministic SQL functions** (RANDOM, datetime-now) are rejected by the determinism validator at schema definition time. They cannot appear in constraints, defaults, or computed columns.

### 1.5 Global Honest Majority

**The network has an honest majority: f < N/2**, where N is the total number of nodes and f is the number of Byzantine nodes. This is the fundamental trust assumption. All safety and liveness properties derive from it.

---

## 2. Definitions

**Block.** The fundamental unit of versioned storage, identified by a cryptographic block ID. Each block has a revision number that increases monotonically with each committed mutation.

**Collection.** A logical grouping of blocks with a consistent access pattern. *Tree* collections provide indexed key-value access via B-tree. *Diary* collections provide append-only log access.

**Transaction.** A set of SQL statements that mutate one or more collections atomically. A transaction is identified by its *transaction ID* — a SHA-256 hash of (stamp ID, statements, read dependencies). The transaction ID is the content address of the transaction.

**Read dependency.** A pair *(blockId, revision)* recording that a transaction observed a specific block at a specific revision during execution. The set of all read dependencies is the transaction's *read set*.

**Cluster.** A set of *K* peers responsible for a block, selected deterministically by FRET ring distance from the block ID. Cluster membership is a function of network topology and is eventually consistent.

**Consensus.** A transaction achieves consensus when a qualifying set of cluster peers agree on its outcome (commit or reject).

**Conflict.** Two transactions *conflict* if they modify the same block. Conflict is detected by block ID overlap in their respective operation sets.

**Valid transaction.** A transaction is *valid* if it produces correct results when re-executed against the declared base state (read set) and schema. Validity is an objective property — all correct validators agree on it.

**Dispute.** A protocol event triggered when cluster peers disagree on a transaction's validity. Disputes are resolved by expanding the audience of validators until one side achieves consensus.

---

## 3. Safety Properties

### Theorem 1: Consensus Safety (No Conflicting Commits)

**Statement.** If the global network has an honest majority, no two conflicting transactions can both achieve consensus for the same block.

**Proof sketch.**

Consider two conflicting transactions *T₁* and *T₂* that both attempt to modify block *B*. Both are submitted to the cluster responsible for *B*.

*Case 1: Sequential arrival.* If *T₁* arrives and achieves consensus before *T₂* is submitted, then when *T₂* is validated, its read dependencies will show stale revisions for *B* (since *T₁* incremented *B*'s revision). Validators reject *T₂* with a stale-read failure. No conflict.

*Case 2: Concurrent arrival.* Both *T₁* and *T₂* are pending simultaneously. The cluster detects the conflict via block ID overlap in `operationsConflict()`. The race resolution algorithm `resolveRace()` deterministically selects one winner:
  1. The transaction with more promise signatures wins.
  2. On tie, the transaction with the lexicographically higher message hash wins.

All honest nodes execute the same deterministic algorithm with the same inputs, so all honest nodes agree on the winner. The loser is rejected. Since honest nodes form a super-majority of the cluster (or, failing that, the dispute mechanism recruits a wider honest majority), the honest decision prevails.

*Case 3: Cluster is Byzantine-majority.* If the local cluster has a Byzantine majority that approves both conflicting transactions, the minority honest nodes trigger a dispute. The dispute escalates to enlistees selected by FRET ring distance. Since the global network has an honest majority, the escalation eventually reaches an audience where honest nodes outnumber Byzantine ones. The losing side (including the Byzantine approvers) is ejected. Only one transaction commits.

**Depends on:** Global honest majority (§1.5), Ed25519 unforgeability (§1.3), deterministic race resolution.

### Theorem 2: Partition Safety (No Split-Brain)

**Statement.** During a network partition, at most one partition can commit transactions for any given block.

**Proof sketch.**

Commit requires a super-majority of the cluster — by default, ≥75% of cluster peers must approve (promise phase).

Suppose the network partitions into subsets *A* and *B*. For a block with cluster size *K*, the cluster members are distributed across the partitions. For both partitions to independently commit:
- *A* needs ≥ ⌈0.75K⌉ approvals from peers in *A*
- *B* needs ≥ ⌈0.75K⌉ approvals from peers in *B*

This requires ⌈0.75K⌉ + ⌈0.75K⌉ ≤ K honest participating peers, which simplifies to approximately 1.5K ≤ K — a contradiction. Therefore at most one partition can achieve super-majority.

Additionally, the self-coordination guard detects network shrinkage exceeding 50% from the high-water mark and blocks writes. The partition detector flags rapid churn (≥5 peer departures in 10 seconds) as a potential partition, suppressing transaction initiation.

**Bound.** This holds for any partition split where neither side has ≥75% of the cluster. A partition where one side retains ≥75% of peers can commit — this is correct behavior, as the larger partition is the "real" network.

**Depends on:** Super-majority threshold (75%), partition detection, self-coordination guard.

### Theorem 3: Atomicity (Multi-Collection All-or-Nothing)

**Statement.** A transaction that spans multiple collections either commits in all collections or commits in none.

**Proof sketch.**

Multi-collection transactions use two-phase commit (2PC) with persistent state.

*Phase 1 (PEND).* The coordinator sends PEND to each collection's cluster sequentially. If any collection's PEND fails, the coordinator cancels all previously pended collections and aborts. 2PC state is persisted before each step, so crash recovery can complete the cancel.

*Phase 2 (COMMIT).* After all collections are pended, the coordinator sends COMMIT to all. If any collection's COMMIT fails, the coordinator runs the cancel phase for all collections and aborts. A committed collection cannot be uncommitted, but COMMIT only succeeds when the cluster has consensus — so partial commit requires a cluster to achieve consensus and then fail to report it. In this case, the persisted 2PC state allows recovery: on restart, the coordinator queries each cluster for the transaction's status and either completes the commit or rolls back.

*Recovery.* The persisted 2PC state journal records the transaction phase (pended collections, committed collections). On crash recovery:
- If no COMMITs succeeded: cancel all pended collections.
- If some COMMITs succeeded: query remaining clusters and complete the transaction.
- If all COMMITs succeeded: transaction is complete.

**Depends on:** 2PC state persistence (§1.2), cancel semantics, crash recovery protocol.

### Theorem 4: Deterministic Replay (Validator Agreement)

**Statement.** If two correct validators execute the same transaction against the same base state and schema, they produce identical block operations and identical transaction hashes.

**Proof sketch.**

A transaction is defined by *(stamp, statements, parameters, readDependencies)*. The transaction hash is SHA-256(stamp.id, statements, readDependencies).

Validators verify:
1. **Engine ID match** — both validators use the same execution engine version.
2. **Schema hash match** — both validators have identical schema (tables, columns, indexes, constraints, collations). The schema hash is SHA-256 of the sorted (type, name, DDL) tuples.
3. **Read dependency match** — each block in the read set is at the expected revision. This ensures identical base state.
4. **Re-execution** — the validator re-executes the SQL statements in order against the verified base state. By the deterministic execution assumption (§1.4), this produces identical operations.
5. **Operations hash match** — the validator computes SHA-256 of the resulting operations and compares to the coordinator's hash.

If any check fails, the validator rejects. If all pass, the operations are identical.

**Depends on:** Deterministic execution (§1.4), SHA-256 collision resistance (§1.3), schema hash completeness, statement ordering preservation.

### Theorem 5: Snapshot Isolation with Write-Skew Prevention

**Statement.** Concurrent transactions observe consistent snapshots, and write-skew anomalies are detected and rejected.

**Proof sketch.**

*Snapshot isolation.* Each connection operates on overlay tables that capture writes locally. Reads merge the overlay with the underlying committed state. Concurrent transactions have independent overlays — writes are invisible across transactions until commit.

*Write-skew prevention.* Read dependency tracking captures every block access during transaction execution, recording *(blockId, revision)*. At validation time, the validator checks each read dependency:
- If a block's current revision differs from the recorded revision, the read is stale.
- Stale reads cause validation failure with a specific diagnostic.

Write-skew requires two transactions to read overlapping state and write to non-overlapping blocks such that a cross-transaction invariant is violated. Because read dependencies capture all blocks accessed (including structural blocks like B-tree nodes and log chain nodes), any concurrent modification to any block in the read set is detected. The validator rejects the stale transaction, forcing retry.

**Bound.** Write-skew detection is conservative — it may reject transactions that don't actually violate invariants (false positives from structural block reads). This is a performance concern, not a correctness concern.

**Depends on:** Read dependency capture at block access level, validator read-check step, overlay table isolation.

### Theorem 6: Durability

**Statement.** Once a transaction achieves consensus, its effects are persistent and survive node crashes.

**Proof sketch.**

Commit writes to a log-structured chain with prior-hash linking (SHA-256 of previous block). The chain provides:
1. **Append-only persistence** — log entries are written via batch write with fsync.
2. **Integrity verification** — prior-hash chaining detects any corruption or tampering.
3. **Replication** — consensus requires super-majority of cluster peers to commit, so the transaction is persisted on ≥75% of cluster nodes before the coordinator reports success.

Node crash: the surviving ≥75% of cluster peers still have the committed transaction. Recovering nodes sync from peers on restart.

**Depends on:** Super-majority commit, prior-hash chain integrity, batch write durability.

---

## 4. Liveness Properties

### Theorem 7: Transaction Termination

**Statement.** Every submitted transaction either commits or is explicitly rejected within bounded time.

**Proof sketch.**

Transactions carry an expiration timestamp. Three mechanisms ensure termination:

1. **Expiration enforcement.** Cluster members reject transactions with expired timestamps. The cleanup queue runs every 1 second, removing expired transactions not in terminal phases (Consensus/Rejected). The expiration queue runs every 60 seconds, scanning for newly expired transactions.

2. **Dispute termination.** Each dispute escalation round has a timeout (default 60 seconds). If arbitrators don't respond within the timeout, the round concludes with available votes. The dispute mechanism cannot loop: each round enlists fresh peers from progressively wider FRET ring distance, and the global honest majority ensures eventual resolution (see Theorem 8).

3. **Retry backoff.** Failed commit attempts use exponential backoff (2s → 4s → 8s → 16s → 30s cap, max 5 attempts). After exhausting retries, the transaction is abandoned with an error.

**Bound.** Worst-case termination time is the transaction's expiration timestamp. Typical termination is within one or two round-trip times for non-conflicting transactions.

**Depends on:** Expiration timestamps, cleanup intervals, retry limits, dispute timeouts.

### Theorem 8: Dispute Convergence

**Statement.** The Right-is-Right dispute mechanism terminates in O(log N) escalation rounds, where N is the network size.

**Proof sketch.**

At each escalation round, the dissent coordinator enlists *K* additional peers (where *K* is the cluster size) from the next ring segment by FRET distance. The dispute is resolved when enlistees reach 2/3 super-majority among decisive votes.

Let *p* be the fraction of honest nodes globally (p > 1/2 by assumption). At each round, the probability that the new enlistees have an honest 2/3 majority is:

*P(resolve at round r)* ≥ P(≥ 2K/3 of K enlistees are honest)

For p > 1/2 and K ≥ 3, this probability is bounded below by a constant. Therefore the expected number of rounds is O(1). In the worst case (adversary controls nodes near specific ring positions), escalation may require O(log N) rounds as the audience expands to cover the global population.

Each round ejects the losing side, so the honest fraction of active nodes *increases monotonically*. After at most ⌈log₂(N/K)⌉ rounds, the entire network has been consulted, and the honest majority decides.

**Cost.** Round *r* involves *r × K* total peers. The total work across all rounds is bounded by O(K × log(N/K)), which is O(K log N) for K ≪ N. In the common case (no Byzantine nodes nearby), the fast path handles the transaction with zero dispute cost.

**Depends on:** Global honest majority, deterministic arbitrator selection by FRET distance, ejection of losing peers, dispute timeout per round.

### Theorem 9: Progress Under Contention

**Statement.** Under contention, at least one of the conflicting transactions commits per conflict cycle.

**Proof sketch.**

When conflicting transactions race, `resolveRace()` deterministically selects exactly one winner (most promises, then highest hash). The winner commits. The loser is rejected and may retry with a new transaction ID.

Starvation: a transaction could theoretically lose every race indefinitely. However:
- Each retry generates a new transaction ID (different timestamp), producing a different hash.
- The hash-based tiebreaker is effectively random from the adversary's perspective (SHA-256 preimage resistance).
- The probability of losing *k* consecutive races decreases exponentially as 2⁻ᵏ.

**Bound.** No deterministic starvation prevention exists. Applications should implement bounded retry with backoff. The `StaleFailure` diagnostic provides information for informed retry decisions.

---

## 5. Byzantine Fault Tolerance

### Theorem 10: Adaptive Byzantine Tolerance (Validation)

**Statement.** Transaction validation tolerates up to *f < N/2* Byzantine nodes globally, with validation cost proportional to the local Byzantine fraction.

This is not standard BFT. The tolerance is *adaptive*: the validation protocol automatically escalates its defense based on the fraction of Byzantine validators encountered.

**Proof sketch.**

*Tier 1 — Fast path (f_local = 0).* If all cluster validators are honest, the transaction validates unanimously. Cost: one round trip. This is the common case.

*Tier 2 — Local super-majority (f_local < K/4).* If fewer than 25% of cluster validators are Byzantine, the honest super-majority (≥75%) overrides the minority. The transaction validates with the minority flagged. Cost: one round trip plus reputation updates.

*Tier 3 — Local minority honest (K/4 ≤ f_local < K).* If the Byzantine fraction exceeds the local super-majority threshold, the honest minority triggers a dispute. The dissent coordinator enlists validators from the wider network. Since the global honest fraction p > 1/2, the enlistees are expected to be majority-honest. Cost: one or more escalation rounds.

*Tier 4 — Cascading escalation (wide Byzantine presence).* If enlisted validators are also split, escalation continues to progressively wider ring segments. Each round ejects losing validators, increasing the honest fraction. Cost: O(log N) rounds in the worst case.

*Convergence.* At each escalation level, the resolution threshold is 2/3 super-majority of decisive arbitrator votes. With global honest majority (p > 1/2), the expected arbitrator honest fraction exceeds 1/2, and the probability of achieving 2/3 honest decisive votes is bounded below by a positive constant. The honest side wins with probability approaching 1 as the audience grows.

*Ejection.* Losing validators accumulate reputation penalties (FalseApproval: 40 points, DisputeLost: 30 points). Accumulated penalties ≥80 trigger banning. Equivocation (signing conflicting votes for the same transaction) triggers immediate ban (100 points). Ejected validators cannot participate in future validation for the affected ring segment. The ring self-heals by incorporating the next-nearest FRET neighbors.

**Cost model.**

| Tier | Byzantine fraction | Rounds | Work multiplier |
|------|-------------------|--------|-----------------|
| Fast path | 0 | 1 | 1× |
| Local super-majority | < K/4 | 1 | ~1× |
| First escalation | < K | 2 | ~2× |
| Second escalation | wide | 3 | ~4× |
| Full cascade | near-global | O(log N) | O(log N)× |

Validation degenerates to whole-network consensus (blockchain-style) only when Byzantine validators are widespread — a scenario that should be exceedingly rare given the economic incentives against it (ejection, reputation loss).

**Depends on:** Global honest majority, dispute escalation mechanism, reputation-based ejection, FRET ring topology for deterministic validator/arbitrator selection.

### Theorem 11: Equivocation Detection

**Statement.** If a Byzantine node signs conflicting votes (approve and reject) for the same transaction, this is detected and the node is banned.

**Proof sketch.**

Equivocation detection occurs during record merging in `ClusterMember.mergeRecords()`. When a peer's signature type changes between observations (approve → reject or vice versa):

1. The first-seen signature is preserved (prevents the Byzantine node from "correcting" its vote).
2. The equivocation is recorded as evidence: `phase:messageHash:existingType→incomingType`.
3. A `PenaltyReason.Equivocation` penalty (weight 100) is applied, which exceeds the ban threshold (80).
4. The peer is immediately banned for the affected ring segment.

Since signatures are Ed25519, the Byzantine node cannot deny having signed the conflicting vote (non-repudiation). The evidence is sufficient for any honest node to independently verify the equivocation.

**Depends on:** Ed25519 non-repudiation, first-seen-wins policy, penalty threshold exceeding ban threshold.

### Theorem 12: Signature Unforgeability

**Statement.** No Byzantine node can forge a valid promise or commit signature for another node's identity.

**Proof sketch.**

Promise signatures are computed as: `Ed25519.sign(privateKey, hash + ":" + type + ":" + reason?)` where `hash = SHA256(messageHash + message)`.

Commit signatures use: `hash = SHA256(messageHash + message + promises)`.

Forging requires either:
1. Producing a valid Ed25519 signature without the private key — contradicts the unforgeability assumption.
2. Finding a collision in SHA-256 such that a different message produces the same hash — contradicts collision resistance.

Therefore, each signature is attributable to exactly one node, and the signed content cannot be modified without invalidating the signature.

**Depends on:** Ed25519 unforgeability (§1.3), SHA-256 collision resistance (§1.3).

### Theorem 13: Byzantine Coordinator Innocuity

**Statement.** A Byzantine coordinator cannot cause honest validators to commit an invalid transaction.

**Proof sketch.**

The coordinator proposes a transaction by distributing *(stamp, statements, parameters, readDependencies, operationsHash)* to the cluster. Consider each possible coordinator lie:

*Lie about operations.* The coordinator claims an operations hash that does not match the actual re-execution result. Every honest validator independently re-executes the statements against the declared base state (Theorem 4) and computes its own operations hash. The hash mismatch causes rejection. The coordinator cannot predict a collision (SHA-256 collision resistance).

*Lie about read dependencies.* The coordinator declares read dependencies that don't match actual block revisions. Validators check each *(blockId, revision)* pair against their local state. A mismatch triggers stale-read rejection. The coordinator cannot forge block state on honest validators.

*Send inconsistent content to different clusters.* In a multi-collection transaction, the coordinator could send different transaction content to different clusters. However, the transaction ID is a content hash — SHA-256(stamp.id, statements, readDependencies). Different content produces different transaction IDs. The 2PC protocol keys on transaction ID, so inconsistent proposals are independent transactions, not a single atomic commit. The coordinator cannot achieve atomic multi-collection commit on inconsistent content.

*Refuse to complete 2PC.* The coordinator could send PEND but never send COMMIT, holding locks indefinitely. Transaction expiration (§4, Theorem 7) bounds this: expired pended transactions are cleaned up by cluster members independently of the coordinator.

**Bound.** A Byzantine coordinator can waste validator resources (bounded by expiration) and sabotage its own transactions. It cannot cause any honest validator to accept invalid state.

**Depends on:** Deterministic replay (Theorem 4), SHA-256 collision resistance (§1.3), transaction content-addressing, expiration enforcement (Theorem 7).

### Theorem 14: Sync/Recovery Integrity

**Statement.** A recovering node can reconstruct correct state from cluster peers despite up to *f < K/2* Byzantine peers in the cluster, where *K* is the cluster size.

**Proof sketch.**

A recovering node fetches block history from cluster peers. Two mechanisms provide integrity:

*Content addressing.* Each block's ID is a cryptographic hash of its content. A Byzantine peer cannot serve fabricated content for a known block ID without finding a SHA-256 collision. The recovering node verifies each block's hash on receipt.

*Prior-hash chain verification.* Each log entry contains the SHA-256 hash of the previous entry. The recovering node walks the chain from the latest entry backward, verifying each link. A Byzantine peer cannot splice entries into the chain without breaking a link (collision resistance) or forking the chain at some point.

*Multi-peer consistency.* The recovering node fetches the same block range from multiple cluster peers and compares. With honest majority in the cluster (*f < K/2*), at least ⌈K/2⌉ + 1 peers serve the canonical chain. The recovering node takes the chain attested by the majority. A Byzantine minority cannot outvote the honest majority on chain content.

*Commit signatures as trust anchor.* Each committed transaction carries super-majority signatures from the committing cluster (≥75% at commit time). The recovering node can verify these signatures against known peer identities without trusting any single peer. A committed block with valid super-majority signatures is canonical regardless of who served it.

**Bound.** Requires at least one honest, reachable peer in the cluster. If all reachable peers are Byzantine, the recovering node cannot distinguish a valid chain from a fabricated one — but this violates the honest majority assumption within the cluster, which is itself protected by the global honest majority through dispute escalation (Theorem 10).

**Depends on:** SHA-256 collision resistance (§1.3), prior-hash chain integrity (Theorem 6), Ed25519 signature verification (Theorem 12), honest cluster majority.

### Theorem 15: Read-Path Integrity

**Statement.** A node reading block data from a Byzantine peer can detect content forgery. Stale reads are detectable within transactions but not for unvalidated out-of-band reads.

**Proof sketch.**

*Integrity (forgery detection).* Block IDs are content hashes. A reader that knows a block ID can fetch the block from any peer and verify the hash. A Byzantine peer serving tampered content produces a hash mismatch — detected immediately. This holds unconditionally: no trust in the serving peer is required, only knowledge of the expected block ID.

*Freshness within transactions.* A transaction captures read dependencies *(blockId, revision)* for every block accessed during execution. At validation time, validators verify each dependency against current state (Theorem 5). If a Byzantine peer served a stale block during execution, the recorded revision won't match, and validators reject. The transaction author is protected from acting on stale reads.

*Freshness outside transactions.* An application performing a casual read (outside a transaction) from a single peer has no protocol-level freshness guarantee. A Byzantine peer can serve a block at an old revision without detection, because there is no validator checking read dependencies. The reader sees internally consistent (content-addressed) but potentially outdated data.

*Availability.* A Byzantine peer can refuse to serve blocks entirely (omission). Multi-peer fetching from the cluster mitigates this — with honest majority, at least ⌈K/2⌉ + 1 peers are willing to serve. The reader falls back to alternative cluster members.

**Bound.** Content integrity is unconditional given the block ID. Freshness is guaranteed only within validated transactions. Out-of-band reads are consistent but not guaranteed fresh — applications requiring freshness must use transactions or read from multiple peers and compare revisions.

**Depends on:** SHA-256 collision resistance (§1.3), read dependency tracking (Theorem 5), cluster honest majority for availability.

---

## 6. Consistency Model

### 6.1 CAP Classification

Optimystic is a **CP system** (Consistency over Availability). During network partitions, the minority partition cannot commit transactions (the super-majority threshold prevents it). Availability is sacrificed to prevent split-brain.

### 6.2 Isolation Level

Optimystic provides **snapshot isolation with write-skew prevention** (equivalent to serializable for most practical workloads):

- Each transaction sees a consistent snapshot of the database at transaction start time.
- Write-write conflicts are detected via block ID overlap.
- Write-skew anomalies are detected via read dependency validation.
- Phantom reads within a single transaction are prevented by overlay table isolation.

### 6.3 Ordering Guarantees

- **Within a collection:** transactions are totally ordered by revision number. Revision is assigned at commit time and increases monotonically.
- **Across collections:** no total order. Multi-collection transactions are atomic but their relative ordering with single-collection transactions is determined by individual collection commit order.
- **Timestamps are metadata.** Transaction ordering is determined by log append order (revision), not by wall-clock timestamps. Clock skew does not affect correctness.

---

## 7. Bounds and Limitations

### 7.1 Sybil Attacks

The honest majority assumption (§1.5) counts *nodes*, not *identities*. A Sybil attacker who controls many identities near a specific block ID could dominate that block's cluster.

**Mitigations:**
- Node identity is bound to Ed25519 key pairs (cost of identity generation).
- FRET network size estimation detects anomalous density and flags low-confidence estimates.
- The `validateSmallCluster()` check compares local cluster size against FRET's global estimate.
- Dispute escalation recruits validators from progressively wider ring segments, diluting the Sybil attacker's influence.

**Bound.** Sybil resistance is proportional to the cost of key generation and the effectiveness of FRET's density estimation. A sufficiently resourced attacker with N/2 identities breaks the honest majority assumption entirely.

### 7.2 Network Partition Duration

During a partition, the minority partition is unavailable for writes. Read-only operations from local cache continue to work but may serve stale data.

**Healing.** When partitions heal, divergent state is reconciled:
- *Behind*: normal sync catches up.
- *Ahead*: tentative transactions are validated against the canonical chain.
- *Forked*: conflicting commits trigger transaction invalidation cascade — the transaction with fewer confirmations is reversed and its dependents are re-evaluated.

**Bound.** Partition healing requires connectivity restoration and is bounded by sync round-trip time plus conflict resolution time.

### 7.3 Transaction Size

No protocol-level limit on transaction size (number of statements, collections, or operations). However:
- Large transactions increase the probability of conflict (more blocks touched).
- Multi-collection transactions incur sequential PEND overhead (one round-trip per collection).
- Re-execution during validation has cost proportional to transaction size.

### 7.4 Clock Assumptions

Minimal. Timestamps are used only for:
- Transaction expiration (requires clocks to be roughly synchronized within the expiration window — typically seconds to minutes).
- Stamp ID generation (used for identity, not ordering — clock skew produces different IDs but does not affect correctness).
- Reputation penalty decay (exponential decay over time — clock skew affects decay rate but not safety).

**Bound.** Correctness requires only that honest nodes' clocks are within the transaction expiration window of each other. No tight synchronization is needed.

### 7.5 Scalability

- **Cluster size K:** Determines local fault tolerance and consensus latency. K=3 is minimum; larger K provides more replication but higher per-transaction cost.
- **Network size N:** Dispute escalation cost is O(K log N) in the worst case. Normal operation (no disputes) is O(K) regardless of N.
- **Contention:** High contention on a single block serializes transactions through that block's cluster. Throughput is bounded by consensus round-trip time.

---

## 8. Composition of Guarantees

The properties above compose to provide the following end-to-end guarantee:

> **If the global network has an honest majority, and honest nodes' clocks are within the expiration window of each other, then:**
>
> 1. Every submitted transaction either commits or is rejected within bounded time.
> 2. No two conflicting transactions both commit.
> 3. Committed transactions are durable and survive up to 25% node failure per cluster.
> 4. Multi-collection transactions are atomic.
> 5. Concurrent transactions are isolated at the snapshot level with write-skew prevention.
> 6. Byzantine validators are detected and ejected, with validation cost proportional to the fraction of Byzantine validators encountered.
> 7. Network partitions cannot cause split-brain; the minority partition blocks writes rather than risk inconsistency.
> 8. A Byzantine coordinator cannot cause honest validators to commit invalid state.
> 9. Recovering nodes reconstruct correct state despite Byzantine peers, given honest cluster majority.
> 10. Block content integrity is unconditionally verifiable; read freshness is guaranteed within transactions.

These guarantees degrade gracefully: as the Byzantine fraction increases, validation spends more work on dispute resolution but maintains safety. Only when f ≥ N/2 can safety be violated.

---

## 9. Toward Formal Verification

The theorems above are informal proof sketches. A formal verification effort would proceed in stages:

### Stage 1: TLA+ Specification

Model the consensus protocol (cluster voting, dispute escalation, 2PC) as a TLA+ state machine. Key properties to model-check:
- **Safety:** `[]~(Committed(T1) /\ Committed(T2) /\ Conflicting(T1, T2))` — conflicting transactions never both commit.
- **Liveness:** `<>(Committed(T) \/ Rejected(T))` — every transaction eventually resolves.
- **Agreement:** `[](Decision(node_i, T) = Decision(node_j, T))` — all honest nodes agree.

TLA+ is well-suited because:
- The consensus protocol has a small number of phases (PEND, COMMIT, DISPUTE, RESOLVE).
- The state space is bounded by cluster size and escalation depth.
- Existing TLA+ specs for 2PC and Paxos-like protocols provide reusable patterns.

### Stage 2: Property-Based Testing

Augment the existing test suite with property-based tests (e.g., fast-check) that generate random transaction schedules, network partitions, and Byzantine behaviors, then verify invariants hold across all generated scenarios.

### Stage 3: Mechanized Proofs

For the core consensus algorithm only (dispute escalation convergence, race resolution determinism), consider mechanized proofs in Lean or Coq. The scope should be narrow — prove the core safety property formally and leave the rest to model checking and testing.

---

## Appendix: Property Dependency Graph

```
                    ┌─────────────────────┐
                    │  Global Honest       │
                    │  Majority (f < N/2)  │
                    └──────────┬──────────┘
                               │
          ┌────────────────┬───┴───┬────────────────┐
          │                │       │                │
          ▼                ▼       ▼                ▼
┌─────────────────┐ ┌───────────┐ │  ┌────────────────┐
│ Dispute          │ │ Consensus │ │  │ Equivocation   │
│ Convergence (T8) │ │ Safety    │ │  │ Detection (T11)│
└────────┬────────┘ │ (T1)      │ │  └────────────────┘
         │          └─────┬─────┘ │
         │                │       │
         ▼                ▼       ▼
┌─────────────────┐ ┌──────────┐ ┌──────────────────┐
│ Adaptive BFT    │ │ Partition│ │ Sync/Recovery    │
│ Validation (T10)│ │ Safety   │ │ Integrity (T14)  │
└─────────────────┘ │ (T2)     │ └──────────────────┘
                    └──────────┘

┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Deterministic │    │ Snapshot     │    │ Atomicity    │
│ Replay (T4)   │    │ Isolation    │    │ (T3)         │
│               │    │ (T5)         │    │              │
└──┬─────┬─────┘    └──────┬───────┘    └──────┬───────┘
   │     │                 │                    │
   │     │                 ▼                    ▼
   │     │          ┌──────────────┐    ┌──────────────┐
   │     │          │ Read Dep     │    │ 2PC State    │
   │     │          │ Tracking     │    │ Persistence  │
   │     │          └──────┬───────┘    └──────────────┘
   │     │                 │
   ▼     ▼                 ▼
┌──────────────┐    ┌──────────────────┐
│ SHA-256       │    │ Read-Path        │
│ Collision     │    │ Integrity (T15)  │
│ Resistance    │    └──────────────────┘
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ Coordinator      │
│ Innocuity (T13)  │
└──────────────────┘
```
