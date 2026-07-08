# Correctness Properties of the Optimystic Protocol

This document states the properties that Optimystic guarantees, the assumptions under which they hold, and the mechanisms that enforce them. It is structured as a series of theorems with informal proof sketches, intended as a foundation for eventual formal verification.

For implementation details, see [transactions.md](transactions.md), [right-is-right.md](right-is-right.md), and [internals.md](internals.md).

> **Implementation status notice.** §5 (Byzantine Fault Tolerance) and the dispute-related theorems — Theorems 1 (Case 3), 2 (escalation clause), 7 (clause 2), 8, 8b, and 10 (Tiers 3–4 and cost model) — describe a **target** mechanism that is **partially implemented**. Per-theorem status notes below flag each gap. The shipping system today provides a materially weaker guarantee than the `f < N/2` headline: validity disagreements are *detectable* (the `ClusterRecord` carries a `disputed` flag and rejection evidence) within a cluster that has an honest super-majority of ≥⌈0.67·K⌉ approvals (`superMajorityThreshold = 0.67`, `libp2p-node-base.ts:605`), but disputes are not initiated pre-commit, the dispute service is off by default (`disputeEnabled = false`, `dispute/types.ts:124`), and `initiateDispute` has no production caller. See `docs/architecture.md` §Status & Evolution and `tickets/blocked/dispute-synchronous-escalation-decision.md` for the strategic decision on completing the full mechanism.

---

## 1. System Model

### 1.1 Network

**Asynchronous with eventual delivery.** Messages between non-partitioned honest nodes may be delayed or reordered but are eventually delivered. There is no bound on message delay, but transactions carry an expiration timestamp that provides a practical upper bound on waiting.

**Partitions are possible.** The network may partition into disjoint subsets. During a partition, nodes in different subsets cannot communicate. Partitions eventually heal.

### 1.2 Nodes

**Crash-recovery.** Honest nodes may crash at any point and restart. On recovery, a node restores its persisted *per-cluster* coordinator state — the `broadcasting`-phase record a single block cluster keeps so it can resume its own consensus round (`PersistedCoordinatorState`, db-p2p) — and resumes protocol participation. This is per-block-cluster durability, **not** a cross-collection transaction decision journal (see Theorem 3, which no longer assumes one). Volatile state (in-flight messages, uncommitted overlays) is lost on crash.

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

> **Status (§1.5):** The `f < N/2` tolerance is the target the full dispute mechanism is designed to reach. The currently-shipping subset provides a weaker guarantee: a Byzantine minority up to ~33% of a cluster (at the default `superMajorityThreshold = 0.67`, `libp2p-node-base.ts:605`) can drive an invalid transaction to commit flagged-but-not-blocked, because dispute escalation is off by default and unwired. See Theorem 10 status note for the concrete current bound.

---

## 2. Definitions

**Block.** The fundamental unit of versioned storage, identified by a cryptographic block ID. Each block has a revision number that increases monotonically with each committed mutation.

**Collection.** A logical grouping of blocks with a consistent access pattern. *Tree* collections provide indexed key-value access via B-tree. *Diary* collections provide append-only log access.

**Transaction.** A set of SQL statements that mutate one or more collections as a single logical unit (atomic *in intent*; across collections, visibility is eventual — see Theorem 3). A transaction is identified by its *transaction ID* — a SHA-256 hash of (stamp ID, statements, read dependencies). The transaction ID is the content address of the transaction.

**Read dependency.** A pair *(blockId, revision)* recording that a transaction observed a specific block at a specific revision during execution. The set of all read dependencies is the transaction's *read set*.

**Cluster.** A set of *K* peers responsible for a block, selected deterministically by FRET ring distance from the block ID. Cluster membership is a function of network topology and is eventually consistent.

**Membership binding.** The peer set responsible for a transaction is bound into the transaction's cryptographic identity. A transaction record declares a *membership version*: version 2 (emitted by all current coordinators) folds a *membership digest* — `SHA256` of the sorted peer-id list, i.e. `membershipDigest(peers)` — into the `messageHash`, `promiseHash`, and `commitHash` a member signs. Consequently **for a version-2 record, equal `messageHash` implies an equal responsible peer set**: two coordinators that disagree about who is responsible produce two *different* `messageHash`es (two competing transactions the race/conflict machinery resolves), not one hash with a silent internal disagreement. The digest is over peer *ids only* — multiaddrs and public keys (which churn, or are a function of the id) are excluded, so it is stable under address churn and peer-map ordering. Legacy version-1 (unversioned) records leave the peer set unbound and hash exactly as before this binding was introduced, so already-committed history and its stored commit certificates keep verifying unchanged (see Theorem 14). *This establishes the binding only; it does not by itself decide whether a declared peer set is a legitimate cluster for the block — that admission check is a separate follow-up (the membership admission gate).*

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

Membership binding (§2) sharpens the "same inputs" premise here: for version-2 records the responsible peer set is folded into the `messageHash`, so equal `messageHash` implies an equal peer set. Two honest members with different views of who is responsible therefore hold two *different* hashes — two competing transactions this same race resolution adjudicates — rather than one record they silently disagree about. (Whether a declared set is a *legitimate* cluster for the block is enforced by the separate membership admission gate; this theorem relies only on the binding.)

*Case 3: Cluster is Byzantine-majority.* If the local cluster has a Byzantine majority that approves both conflicting transactions, the minority honest nodes trigger a dispute. The dispute escalates to enlistees selected by FRET ring distance. Since the global network has an honest majority, the escalation eventually reaches an audience where honest nodes outnumber Byzantine ones. The losing side (including the Byzantine approvers) is ejected. Only one transaction commits.

> **Status (Theorem 1, Case 3 — target, not yet built):** Cases 1 and 2 are current. Case 3 is the target design. In the shipping system, a Byzantine local super-majority (≥⌈0.67·K⌉ approvers at the default `superMajorityThreshold`) **commits the transaction anyway** and sets `record.disputed = true` with rejection evidence (`cluster-coordinator.ts:312-332`). No dispute is initiated pre-commit. The dispute service is off by default (`disputeEnabled = false`, `dispute/types.ts:124`) and `initiateDispute` has no production caller. The "honest minority ejects the Byzantine majority" path described in Case 3 requires the full synchronous escalation mechanism — the subject of `tickets/blocked/dispute-synchronous-escalation-decision.md`.

**Depends on:** Global honest majority (§1.5), Ed25519 unforgeability (§1.3), deterministic race resolution.

### Theorem 2: Partition Safety (No Split-Brain)

**Statement.** During a network partition, at most one partition can commit transactions for any given block.

**Proof sketch.**

Commit requires a super-majority of the cluster — by default, ≥75% of cluster peers must approve (promise phase).

Suppose the network partitions into subsets *A* and *B*. For a block with cluster size *K*, the cluster members are distributed across the partitions. For both partitions to independently commit:
- *A* needs ≥ ⌈0.75K⌉ approvals from peers in *A*
- *B* needs ≥ ⌈0.75K⌉ approvals from peers in *B*

This requires ⌈0.75K⌉ + ⌈0.75K⌉ ≤ K honest participating peers, which simplifies to approximately 1.5K ≤ K — a contradiction. Therefore at most one partition can achieve super-majority.

This counting argument assumes both partitions are voting on *the same K-peer cluster*. Two mechanisms make that assumption enforceable rather than implicit:

- **Membership binding (§2)** folds the peer set into the `messageHash` for version-2 records, so a partition that promises/commits against a different (e.g. self-shrunk) peer set is signing a *different* `messageHash` — a distinct transaction, not a second super-majority for the same one. Binding alone, however, does not stop a coordinator from *choosing* a smaller `K′ < K` cluster and reaching ⌈0.75·K′⌉ of it: both sides could bind their own shrunk sets and each reach super-majority of its own `K′`.
- **The membership admission gate** closes that residual self-shrink hole. Before a cluster member signs an `approve`, it independently re-derives its own view `E` of the block's responsible cluster (from `IKeyNetwork.findCluster`) and refuses to vote unless the coordinator's declared set `D` is a legitimate cluster it belongs to: `D` must contain the member, must not be a shrink below `⌈admissionFraction · K_est⌉` of the member's *own* confident cluster-size estimate `K_est = |E|`, and must lie within `clusterSizeTolerance` of `E`. Crucially, when the member **cannot confidently derive** `E` — exactly what a partition induces, since FRET's network-size confidence collapses when peers vanish — the gate **fails closed**: it refuses any below-full-size `D` (measured against the configured full `clusterSize`), so a member on a minority side cannot be recruited to vote a self-shrunk cluster into super-majority. A member declining emits an explicit `membership-not-admitted` reject (feeding the dispute accounting), not a silent timeout. The `allowUnvalidatedSmallCluster` opt-in is the single documented escape hatch (single-node / local dev knowingly below the floor), mirroring the coordinator's `validateSmallCluster` posture.

Because each honest member enforces the *same* `K` from its own confident estimate and fails closed under low confidence, the minority partition cannot assemble even ⌈0.75·K′⌉ *admitting* members for its shrunk `K′` — the counting contradiction is restored on the members' side, not just assumed. Membership is thus something the members **agree on**, not merely something the coordinator declares. See §7.1 (Sybil) and §7.2 (partition).

Additionally, the self-coordination guard detects network shrinkage exceeding 50% from the high-water mark and blocks writes. The partition detector flags rapid churn (≥5 peer departures in 10 seconds) as a potential partition, suppressing transaction initiation.

**Bound.** This holds for any partition split where neither side has ≥75% of the cluster. A partition where one side retains ≥75% of peers can commit — this is correct behavior, as the larger partition is the "real" network. A side that genuinely *is* the surviving network (peers truly gone, not partitioned away) is admitted by the gate's confident path — a confident small `K_est` legitimizes a correspondingly small cluster; only an *unjustified* shrink (low confidence, or `|D|` far below `K_est`) is refused.

**Depends on:** Super-majority threshold (75%), membership binding (§2), the member-side membership admission gate, FRET network-size confidence, partition detection, self-coordination guard.

> **Status (Theorem 2):** The core partition-safety argument is largely **current**: membership binding (§2) and the member-side membership admission gate both landed (prereqs `bind-cluster-membership-into-signed-record`, `cluster-membership-admission-gate`). Two caveats: (1) **Threshold discrepancy** — the proof's counting argument uses ≥75% (⌈0.75·K⌉) but the code default is `superMajorityThreshold = 0.67` (`libp2p-node-base.ts:605`; 0.75 in the test/mesh harness). With 0.67 the contradiction holds (0.67+0.67 = 1.34 > 1), but the actual floor is ≥⌈0.67·K⌉, not ≥⌈0.75·K⌉. (2) **Escalation clause** — if a minority partition were somehow to form a disputed super-majority despite the gate, the only recourse would be dispute escalation to recruit a wider honest majority (same mechanism as Theorem 1 Case 3). That escalation path is target / not built; the gate is the primary current defense.

### Theorem 3: Multi-Collection Atomicity of Intent (Eventual, Reported Visibility)

**Statement.** A transaction that spans multiple collections records its *intent to commit the whole set* atomically. Its writes then become visible collection-by-collection: normally all land, but a permanent failure on one collection — or a coordinator crash mid-commit — can leave a **partial landing** in which some collections are durably committed and others are not. The system never silently claims success on a partial landing: it names the durable set and the not-landed set so the application (or a future reconciler) resolves the split.

> **This is weaker than all-or-nothing — read this first.** Earlier drafts of this theorem claimed unconditional all-or-nothing across collections and a "persisted 2PC journal" that recovers a crashed coordinator to a single commit-or-abort outcome. The implementation does not deliver that and no such cross-collection journal exists. What is guaranteed is *atomicity of intent* plus *eventual, reported visibility*, defined below. Genuine cross-collection all-or-nothing is an opt-in future mode — see the backlog item `feat-cross-collection-atomic-commit` and `crdt-sync.md` Stages 4–5.

**Definitions (stated on first use).**

- **Atomicity of intent.** A multi-collection transaction has one content-addressed identity — `transaction.id` = SHA-256(stamp id, statements, reads) (§2). Every participating collection's PEND carries that same identity, so the *intent to commit the whole set* is fixed atomically at the point all collections have pended. No collection can be pended under a different identity: different content produces a different `transaction.id` (Theorem 13, "inconsistent content").
- **Eventual visibility (not atomic visibility).** The COMMIT phase lands each collection independently (`TransactionCoordinator.commitPhase`, fanned out per collection). A reader observing collection A's write of a transaction is **not** guaranteed to observe collection B's write of the same transaction at that instant. Cross-collection visibility is eventual and, on a partial landing, requires reconciliation.
- **Partial landing.** When one collection's COMMIT fails permanently while another succeeds, the durably-committed collections stay committed (there is no cross-collection undo) and the failed ones do not.

**Proof sketch.**

*Phase 1 (PEND).* The coordinator PENDs every collection's cluster. If any collection's PEND fails, the coordinator cancels every already-pended collection and aborts with nothing durable — a clean, retryable failure (the common case for a conflict / stale-read / validation rejection, which surfaces at PEND before any commit). Reaching the end of PEND establishes **atomicity of intent**: all collections hold the same `transaction.id`, pended.

*Phase 2 (COMMIT).* The coordinator commits each collection's pended blocks independently. The failure mode that breaks all-or-nothing is a **permanent stale loss**: a racing transaction advances a collection's log tail between that collection's PEND and its COMMIT, so this transaction's commit for that collection can never win. `commitCollection` returns `{success:false}` and deliberately does **not** retry — the identical request can never succeed against the advanced tail. Meanwhile the sibling collections commit. Those durable commits are per-collection and there is no cross-collection undo, so the winner cannot be un-committed to match the loser. This is a *permanent* split, not a transient one a journal could later heal.

*Honest reporting (what replaces "recovery to atomic").* On a partial landing `coordinator.commit()` throws `CoordinatorPartialCommitError`, naming `committedCollections` (durable — CANNOT be rolled back) and `failedCollections` (never committed — local state reverted for retry); `coordinator.execute()` surfaces the same partition on its `ExecutionResult`. The coordinator gives the committed collections the success-path local treatment (fold to read cache + reset tracker + drop pending) and restores only the failed collections, so local memory matches durable state. It does **not** uniformly roll back — that would re-stage already-durable actions as pending and make memory disagree with storage. The application must **reconcile** the named committed set against the failed set: it must not blindly retry the whole transaction, and must not treat the outcome as a clean abort.

*Coordinator crash mid-commit-loop.* The db-core `TransactionCoordinator` is an in-memory orchestrator with **no cross-collection decision journal**. If it dies mid-commit-loop, the collections that already committed stay committed; the pended-but-uncommitted collections are released by each cluster's independent expiration cleanup (Theorem 7). The observable outcome is identical to a stale-loss partial landing — intent recorded, visibility partial, reconciliation applies. There is no coordinator-side journal that "queries each cluster and completes or rolls back."

*Per-cluster persistence is not a cross-collection journal.* db-p2p does persist a *per-block-cluster* coordinator state (`ITransactionStateStore` / `PersistedCoordinatorState`) that lets a single block cluster resume its own `broadcasting` phase after a restart (`cluster-coordinator.ts`). That is a per-cluster durability aid for one collection's consensus round — **not** a cross-collection decision record and **not** the basis of a multi-collection all-or-nothing guarantee. The two must not be conflated.

**Depends on:** per-collection consensus (Theorems 1, 6), content-addressed transaction identity (§2, Theorem 13), expiration-based cleanup of abandoned pends (Theorem 7), and honest partial-commit reporting (`CoordinatorPartialCommitError` / `ExecutionResult.committedCollections`). It does **not** depend on a cross-collection 2PC state journal — none exists.

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

2. **Dispute termination.** Each dispute escalation round has a timeout (default 60 seconds). If arbitrators don't respond within the timeout, the round concludes with available votes. The dispute mechanism cannot loop: each round enlists fresh peers by dispersed sampling from the whole population (excluding those already drawn), and the global honest majority ensures eventual resolution (see Theorem 8).

   > **Status (Theorem 7, clause 2 — target, not yet built):** Multi-round escalation with per-round timeouts does not exist in the shipping code. `initiateDispute` (`dispute-service.ts:137`) hard-codes `round = 0` (single round, no recursion), has no production caller, and the service is off by default (`disputeEnabled = false`, `dispute/types.ts:124`). Clauses 1 (expiration enforcement) and 3 (retry backoff) are current.

3. **Retry backoff.** Failed commit attempts use exponential backoff (2s → 4s → 8s → 16s → 30s cap, max 5 attempts). After exhausting retries, the transaction is abandoned with an error.

**Bound.** Worst-case termination time is the transaction's expiration timestamp. Typical termination is within one or two round-trip times for non-conflicting transactions.

**Depends on:** Expiration timestamps, cleanup intervals, retry limits, dispute timeouts.

### Theorem 8: Dispute Convergence

**Statement.** The Right-is-Right dispute mechanism terminates in O(log N) escalation rounds, where N is the network size.

> **Status (Theorem 8 — target / not implemented):** Multi-round escalation does not exist in the shipping code. `initiateDispute` (`dispute-service.ts:137`) hard-codes `round = 0`, selects one arbitrator ring, collects votes once, and resolves — there is no recursion, no geometric widening, no round-to-round ejection loop. Additionally, `initiateDispute` has no production caller and the dispute service is off by default (`disputeEnabled = false`, `dispute/types.ts:124`). The dispersed arbitrator sampling *function* (`sampleArbitrators`, `db-p2p/src/dispute/arbitrator-selection.ts`) is implemented and supports a `round` parameter, but nothing drives it past 0 and the call site is unwired in production. The O(log N) convergence guarantee is not a shipping property; this theorem states the target design.

**Proof sketch.**

At each escalation round, the dissent coordinator enlists *K* additional peers (where *K* is the cluster size) by **dispersed sampling** — the peers nearest *K* pseudo-random ring coordinates (`hash(blockId ‖ round ‖ epoch ‖ i)`), which are uniform over the ring. Crucially, each round's *K* enlistees are drawn from the *whole* population, not the next concentric ring segment: geometric widening only dilutes a locale-Sybil if each wider sample is more representative, and uniform dispersion guarantees that (concentric widening would instead exhaust the attacker's captured neighborhood first). The dispute is resolved when enlistees reach 2/3 super-majority among decisive votes.

Let *p* be the fraction of honest nodes globally (p > 1/2 by assumption). At each round, the probability that the new enlistees have an honest 2/3 majority is:

*P(resolve at round r)* ≥ P(≥ 2K/3 of K enlistees are honest)

For p > 1/2 and K ≥ 3, this probability is bounded below by a constant. Therefore the expected number of rounds is O(1). Because each round samples from the whole keyspace, an adversary controlling nodes near specific ring positions gains no local advantage over the arbitrators; in the worst case escalation still may require O(log N) rounds as the audience expands to cover the global population.

Each round ejects the losing side, so the honest fraction of active nodes *increases monotonically*. After at most ⌈log₂(N/K)⌉ rounds, the entire network has been consulted, and the honest majority decides.

**Cost.** Round *r* involves *r × K* total peers. The total work across all rounds is bounded by O(K × log(N/K)), which is O(K log N) for K ≪ N. In the common case (no Byzantine nodes nearby), the fast path handles the transaction with zero dispute cost.

**Depends on:** Global honest majority, deterministic dispersed arbitrator sampling (uniform over the ring), ejection of losing peers, dispute timeout per round.

### Theorem 8b: Invalidation-Cascade Termination & Convergence

**Statement.** When a proven-invalid `T_inv` is reversed, the re-evaluation of its transitive read-dependents terminates and converges to the same end state on every honest member.

> **Status (Theorem 8b — built but not live end-to-end):** The cascade primitive (`db-p2p/src/dispute/cascade.ts`) and reversal machinery (`invalidation.ts`) are implemented and unit-tested; the termination and convergence arguments in the proof sketch apply to that code. However, end-to-end origination wiring is missing: the composition root does not supply `revalidate`/`onInvalidation` callbacks, and the node-side emit of invalidation change events is not in place, so a `challenger-wins` resolution does not originate a durable `InvalidationEntry` end-to-end in production. See `right-is-right.md` §Durable Invalidation "Wiring status" and §Client Notification "Wiring status".

**Proof sketch.**

*Termination.* A read dependency records the revision a transaction observed, which is the revision of an *earlier* committed write (Theorem 5). So within a collection a dependent's revision strictly exceeds the invalidated revision it depends on: the dependency graph is a forward DAG, never a cycle (a same-collection back-edge is treated as corruption and errors). The cascade processes candidates in revision order, deduped by `actionId`, marking each invalidated action permanently and re-examining only retained candidates against a monotonically growing invalidated frontier. Each round either invalidates ≥1 fresh action or makes no progress (fixpoint) — and the candidate population is finite (the recent log suffix bounded by the dispute TTL), so the number of progressing rounds is bounded by the number of dependents. Two hard horizons (`maxCascadeDepth`, `maxCascadeTransactions`) cap it absolutely; on overflow the cascade halts with the applied children durable and the remainder flagged for operator re-sync — it never loops and never silently truncates.

*Convergence.* Each child invalidation is the same deterministic, content-addressed primitive as the root (compensating revisions recomputed from stored revisions, not engine replay) and is idempotent on `(invalidatedActionId, disputeId)`. With a deterministic re-evaluator, every member replaying the same seed + logs produces the same children in the same order, reaching the same state — so no per-child consensus round is required. Re-running a partially-applied cascade re-derives the frontier from the durable log and skips already-applied children, so a crash mid-cascade is restartable and reconverges without duplicate entries.

**Bound.** Re-evaluation is conservative at block granularity (Theorem 5's structural-block false positives carry over): it may invalidate a dependent that read an unchanged field of a changed block. This is a performance concern (the dependent is resubmitted), not a correctness one — over-invalidation never retains a genuinely-dependent transaction.

**Depends on:** Read-dependency capture and persistence (`ActionEntry.reads`), revision monotonicity (Theorem 5/6), deterministic content-addressed reversal, idempotent invalidation entries, cascade horizons.

### Theorem 9: Progress Under Contention

**Statement.** Under contention, at least one of the conflicting transactions commits per conflict cycle.

**Proof sketch.**

When conflicting transactions race, `resolveRace()` deterministically selects exactly one winner. The order is now: **(1) higher aged priority, (2) more promises, (3) higher message hash.** The winner commits. The loser is rejected and may retry.

*Aged priority (concurrent-contention progress).* A transaction carries an advisory `priority` (default 0) that rises by one per failed retry attempt — attempt-count-derived, so it needs no wall clock and is clock-skew-free (consistent with §7.4) — capped at a small constant `MaxPriority`. Priority is fairness-only: it is excluded from the transaction id, the client signature, the operations hash, and every stale-read/validity check (so Theorem 1 is untouched), and it rides inside the signed cluster `message`, so it is integrity-protected in transit. Because `resolveRace` consults priority *first*, once a starved transaction's priority exceeds a fresh rival's initial priority (0) — i.e. after at most `MaxPriority` losing attempts — every honest member deterministically picks the aged transaction over every fresh rival, so it wins every subsequent *concurrent* race. Two capped-out transactions (both at `MaxPriority`) fall back to the existing promise/hash tiebreak — deterministic and symmetric, no deadlock. Combined with backoff+jitter (§ retry policy) thinning self-inflicted contention, the concurrent-starvation probability collapses from "2⁻ᵏ but memoryless" to "a bounded number of losses, then a deterministic win."

*Byzantine note.* A coordinator can self-assert `priority == MaxPriority` on every transaction. `resolveRace` clamps to the cap and priority never touches validity, so this cannot cause two conflicting commits (safety intact) — it only wins races it might have ~50% won anyway, degrading to at-worst-status-quo fairness (the same graceful-degradation class as spam under honest-majority). Binding priority to *provable* age is out of scope (see the reservation follow-up below).

**Bound.** Starvation prevention is now **deterministic among concurrently-pending conflicts** — an aged transaction beats any co-pending fresh rival within `MaxPriority + 1` rounds. It is **not** yet deterministic against *sequential* starvation: a stream of quick transactions that each commit-and-finish inside the window while a large transaction is still re-reading never co-pend with it, so they never meet it in `resolveRace` — the large transaction just keeps being stale-rejected at PEND. Closing that residual needs a cluster-side admission reservation (deferring fresh conflicting pends for an aged high-priority transaction); it is deliberately deferred to backlog `feat-occ-priority-reservation` (a distinct, stateful, Byzantine-sensitive subsystem). Until then, applications should still pair the aged-priority progress guarantee with bounded retry + backoff; the `StaleFailure` diagnostic informs those retry decisions.

---

## 5. Byzantine Fault Tolerance

### Theorem 10: Adaptive Byzantine Tolerance (Validation)

**Statement.** Transaction validation tolerates up to *f < N/2* Byzantine nodes globally, with validation cost proportional to the local Byzantine fraction.

This is not standard BFT. The tolerance is *adaptive*: the validation protocol automatically escalates its defense based on the fraction of Byzantine validators encountered.

> **Status (Theorem 10):** *Tiers 1 and 2* (unanimous fast path; honest super-majority commits with minority flagged) are **current**: when ≥⌈`superMajorityThreshold`·K⌉ peers approve, `ClusterCoordinator.executeTransaction` commits and sets `record.disputed = true` with evidence for any rejecting minority (`cluster-coordinator.ts:312-332`). Note the threshold discrepancy: the proof uses ≥75% (K/4 Byzantine floor) but the code default is `superMajorityThreshold = 0.67` (`libp2p-node-base.ts:605`; 0.75 in the test/mesh harness) — at 0.67 the effective Tier-2 Byzantine tolerance is ~33%, not 25% as stated. *Tiers 3 and 4* (honest minority triggers dispute; cascading escalation; geometric widening) and the **cost model table** are **target / not built**: the dispute service is off by default (`disputeEnabled = false`, `dispute/types.ts:124`), `initiateDispute` has no production caller, and multi-round escalation does not exist. **Effective guarantee today:** *Byzantine-detectable under an honest cluster super-majority* — a Byzantine minority up to ~33% of a cluster can drive an invalid transaction to commit, flagged but not blocked and never arbitrated by default.

**Proof sketch.**

*Tier 1 — Fast path (f_local = 0).* If all cluster validators are honest, the transaction validates unanimously. Cost: one round trip. This is the common case.

*Tier 2 — Local super-majority (f_local < K/4).* If fewer than 25% of cluster validators are Byzantine, the honest super-majority (≥75%) overrides the minority. The transaction validates with the minority flagged. Cost: one round trip plus reputation updates.

*Tier 3 — Local minority honest (K/4 ≤ f_local < K).* If the Byzantine fraction exceeds the local super-majority threshold, the honest minority triggers a dispute. The dissent coordinator enlists validators from the wider network. Since the global honest fraction p > 1/2, the enlistees are expected to be majority-honest. Cost: one or more escalation rounds.

*Tier 4 — Cascading escalation (wide Byzantine presence).* If enlisted validators are also split, escalation continues by drawing further dispersed samples from the whole population (a larger `count` per round). Each round ejects losing validators, increasing the honest fraction. Cost: O(log N) rounds in the worst case.

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

> **Status (cost model table — target):** This table describes the adaptive escalation goal. In the shipping system all transactions incur the flat cost of a single cluster round (Tiers 1–2 rows). Tiers 3–4 cost rows are not yet reachable.

**Depends on:** Global honest majority, dispute escalation mechanism, reputation-based ejection, FRET ring topology for deterministic validator selection and dispersed arbitrator sampling.

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

For version-2 records (§2, membership binding) the `membershipDigest` is folded into each preimage — `hash = SHA256(messageHash + message + membershipDigest)` for promises and `SHA256(messageHash + message + membershipDigest + promises)` for commits — so a signature is valid only for the exact responsible peer set it was signed against. Version-1 (unversioned) records omit the digest and hash exactly as the two formulas above, preserving verification of pre-binding history.

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
- **Across collections:** no total order. Multi-collection transactions are atomic *in intent* but their visibility lands collection-by-collection (Theorem 3), so their relative ordering with single-collection transactions is determined by each collection's independent commit order — and on a partial landing some collections may reflect the transaction while others do not until reconciliation.
- **Timestamps are metadata.** Transaction ordering is determined by log append order (revision), not by wall-clock timestamps. Clock skew does not affect correctness.

---

## 7. Bounds and Limitations

### 7.1 Sybil Attacks

The honest majority assumption (§1.5) counts *nodes*, not *identities*. A Sybil attacker who controls many identities near a specific block ID could dominate that block's cluster.

**Mitigations:**
- Node identity is bound to Ed25519 key pairs (cost of identity generation).
- FRET network size estimation detects anomalous density and flags low-confidence estimates.
- The `validateSmallCluster()` check compares local cluster size against FRET's global estimate (coordinator side).
- The **member-side membership admission gate** (see Theorem 2) makes each cluster member independently re-derive and admit the responsible set before voting, so a coordinator cannot unilaterally shrink a block's cluster to a Sybil-dominated slice and have honest members rubber-stamp it — a below-floor or low-confidence declared set is refused.
- Dispute escalation samples arbitrators by **verifiable dispersed sampling**, not ring adjacency: each arbitrator is the peer nearest a pseudo-random ring coordinate derived from `hash(blockId ‖ round ‖ epoch ‖ i)`. Because SHA-256 output is uniform over the ring, the coordinates land spread across the whole keyspace, so arbitrators are drawn from the *entire* population, not the disputed block's neighborhood. A Sybil attacker who placed identities near the block to capture its cluster does **not** thereby own the arbitrators — capturing them would require identities near many independent random points, i.e. a fraction of the whole network rather than one locale. The draw is deterministic (every honest node given the same `(blockId, round, epoch)` and agreed membership computes the identical set) yet not pre-positionable (the coordinates are pinned only once the real-time `round` and the agreed-membership `epoch` are fixed). *Note: earlier revisions drew the next K peers by XOR distance to the block — concentric selection that walked straight through the attacker's captured neighborhood and is what this replaces.*

**Bound.** Sybil resistance is proportional to the cost of key generation and the effectiveness of FRET's density estimation. A sufficiently resourced attacker with N/2 identities breaks the honest majority assumption entirely. Dispersed arbitrator sampling raises the *local* Sybil cost — dominating one block's cluster no longer suffices to also capture its arbitrators.

> **Status (§7.1 dispersed-arbitrator sampling):** The dispersed sampling *function* (`sampleArbitrators`, `db-p2p/src/dispute/arbitrator-selection.ts`) is implemented and current — the `arbitrator-independent-sampling` prereq landed. However it is exercised only inside the unwired single-round dispute path: `initiateDispute` has no production caller and the dispute service is off by default (`disputeEnabled = false`, `dispute/types.ts:124`). The Sybil-resistance argument for arbitrators applies to the target design; no end-to-end dispute round currently selects and queries arbitrators in production.

### 7.2 Network Partition Duration

During a partition, the minority partition is unavailable for writes. Read-only operations from local cache continue to work but may serve stale data. Write-unavailability on the minority side is *enforced*, not merely expected: the member-side membership admission gate (see Theorem 2) fails closed under the low FRET confidence a partition induces, so minority members refuse to admit a self-shrunk cluster and no super-majority forms there.

**Healing.** When partitions heal, divergent state is reconciled:
- *Behind*: normal sync catches up.
- *Ahead*: tentative transactions are validated against the canonical chain.
- *Forked*: conflicting commits trigger transaction invalidation cascade — the transaction with fewer confirmations is reversed and its dependents are re-evaluated. The reversal is durable and audit-preserving: rather than rewriting the prior-hash-linked log, a compensating **`InvalidationEntry`** is appended that restores each affected block's as-if-absent content via a new monotonic revision, gated on a `challenger-wins` dispute certificate and applied deterministically on every member through the critical cluster (see `docs/right-is-right.md` § Durable Invalidation). The single-collection reversal primitive is implemented; walking read-dependents across collections is the invalidation-cascade follow-up. **Status: built but not live end-to-end** — same partial status as Theorem 8b. The cascade and reversal code exist and are unit-tested, but end-to-end origination wiring (emit, composition-root callbacks) is not in place, so partition healing via durable invalidation does not yet run in production.

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
> 4. Multi-collection transactions are atomic in *intent* (every collection pends under one content-addressed identity) with *eventual, reported visibility* — normally all collections commit; a partial landing is reported (`committedCollections` / `failedCollections`) for reconciliation, never silently claimed as success (Theorem 3).
> 5. Concurrent transactions are isolated at the snapshot level with write-skew prevention.
> 6. Byzantine validators are detected and flagged (the `ClusterRecord` carries a `disputed` flag and rejection evidence for minority rejecters) — detection is **current**. Ejection via dispute escalation and the adaptive validation cost curve are the **target design**; see Theorem 10 status note.
> 7. Network partitions cannot cause split-brain; the minority partition blocks writes rather than risk inconsistency.
> 8. A Byzantine coordinator cannot cause honest validators to commit invalid state.
> 9. Recovering nodes reconstruct correct state despite Byzantine peers, given honest cluster majority.
> 10. Block content integrity is unconditionally verifiable; read freshness is guaranteed within transactions.

These guarantees degrade gracefully: as the Byzantine fraction increases, validation spends more work on dispute resolution but maintains safety. Only when f ≥ N/2 can safety be violated.

---

## 9. Toward Formal Verification

The theorems above are informal proof sketches. A formal verification effort would proceed in stages:

> **Status (§9):** This section targets the *design*, not the current implementation. In particular, Stage 1 (TLA+ model-checking of the dispute escalation state machine) covers phases — `DISPUTE`, `RESOLVE`, multi-round cascading escalation — that are not yet built in the shipping code. A reader planning a TLA+ effort should note that the escalation phases exist only in the design documents (`right-is-right.md`); the implementation to model-check for BFT properties is the target architecture, not the current code. Theorems 1–3, 4–6, 9, 11–15 reference mechanisms that are current and would be valid targets for formal verification today.

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
│ Deterministic │    │ Snapshot     │    │ Atomic-Intent│
│ Replay (T4)   │    │ Isolation    │    │ (T3)         │
│               │    │ (T5)         │    │              │
└──┬─────┬─────┘    └──────┬───────┘    └──────┬───────┘
   │     │                 │                    │
   │     │                 ▼                    ▼
   │     │          ┌──────────────┐    ┌──────────────┐
   │     │          │ Read Dep     │    │ Per-Coll.    │
   │     │          │ Tracking     │    │ Consensus    │
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
