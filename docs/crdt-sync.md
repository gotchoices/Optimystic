# Evolving Optimystic Toward CRDT-Style Sync

## Intent

Optimystic today is a **CP** system. Every transaction is ordered by a single critical cluster (its collection's log tail), and no transaction is considered committed until that cluster reaches super-majority signed promises. This gives strong linearizability per collection, snapshot isolation across collections, and Byzantine-tolerant ordering — at the cost of availability during partitions and a hotspot at the log tail.

This document explores an alternative: treating the transaction log itself as a CRDT — a grow-only set of signed, self-describing transactions — and deriving collection state as a pure function of replaying that log in HLC order with per-transaction precondition checks.

The structural shift is modest in code but meaningful in semantics. The current system's cluster-driven sequencing is replaced by *deterministic reconstruction* — every honest node replays the same log in the same order and arrives at the same state, with no single cluster acting as sequencer. The open questions are about where this is a win, where it is a loss, and where it is simply a different point on the CAP surface.

This document assumes familiarity with [optimystic.md](optimystic.md), [transactions.md](transactions.md), and [correctness.md](correctness.md). It is paired with [partition-healing.md](partition-healing.md), which builds on this model to handle partition-induced invariant violations with application-defined rules.

## The Central Insight

Claim: if every committed transaction carries (a) its read dependencies and (b) a single Hybrid Logical Clock (HLC) commit point, and all transactions at the same HLC commit atomically, then the set of committed transactions across the network is a **grow-only set CRDT** — and collection state is a pure, deterministic function of replaying that set in HLC order with each transaction's preconditions re-checked against the state just prior to its HLC.

Stated mechanically:

```
State(collection, t) = replay(
    filter(log, hlc ≤ t),
    sorted_by(hlc, tiebreak_by_nodeId)
)

where replay(txs):
    state = ∅
    for tx in txs in hlc order:
        if tx.reads all hold against state:
            state = apply(state, tx.writes)
        # else: tx is observed and logged but has no effect
    return state
```

Two nodes that have observed the same set of transactions compute the same state, regardless of the order in which the transactions arrived. Merge is union. Convergence falls out of the grow-only-set property.

A useful reframing: this is not "a CRDT specialized to serializable transactions." It is **deterministic serializable transactions over a CRDT log**. The CRDT is the log (G-Set, merge is union); the state is *not* a CRDT — it is a replay. Tier 1 of the system is the replay function; tier 2 (see [partition-healing.md](partition-healing.md)) is an application-defined reconcile function that handles invariant violations the replay exposes.

This separates two properties that are usually conflated:

* **Convergence** — all replicas eventually compute the same state. Guaranteed by the HLC-ordered replay.
* **Correctness** — the state satisfies application invariants. Not automatic; handled by tier 2.

Conflating these is the root of much confusion in "can we just use CRDTs?" discussions.

## Relation to the Current Design

In today's model (see [transactions.md](transactions.md)):

* A transaction carries a *stamp ID* (stable from BEGIN), a set of statements, read dependencies, and a computed *transaction ID* (content hash at COMMIT).
* At PEND, every affected block's cluster re-executes the transaction through the declared engine, verifies read dependencies, and signs a promise.
* At COMMIT, each collection's log-tail cluster drives 2PC consensus; all must succeed for the transaction to land.
* Read-dependency validation provides snapshot isolation with write-skew prevention (correctness.md §Theorem 5).
* Deterministic replay (correctness.md §Theorem 4) guarantees that any correct validator produces identical operations given identical base state and schema.

The CRDT evolution preserves deterministic replay, read-dependency semantics, content-addressed identity, and pluggable engines. It replaces:

* **Log-tail cluster sequencing** with a hybrid logical clock.
* **Synchronous 2PC per transaction** with asynchronous arrival plus deterministic replay.
* **All-or-nothing commit at submission time** with a *tentative → stable* visibility model.

## Transactions as Conditional Deltas

Under the new model, a transaction looks like:

```typescript
type CrdtTransaction = {
  stamp: TransactionStamp;        // as today
  statements: string[];            // as today
  reads: ReadDependency[];         // as today — now load-bearing at every replay
  writes: BlockOperation[];        // as today
  hlc: HybridLogicalClock;         // NEW — commit-point timestamp
  id: string;                      // content hash including hlc
  // invariants, reconcile — deferred to partition-healing.md
};

type HybridLogicalClock = {
  wallMs: number;                  // physical component
  logical: number;                 // causal counter
  nodeId: string;                  // Ed25519 peer ID for tiebreak
};
```

The `hlc` field replaces "whenever the log-tail cluster sequences me" with "whenever the issuing node assigns this transaction's commit point, after observing any causally-prior transactions." HLC semantics guarantee:

1. **Causal consistency.** If transaction A causally precedes B (B reads something A wrote), then `A.hlc < B.hlc`.
2. **Total order.** Ties are broken by `nodeId`, giving a total order across the network.
3. **Bounded skew from wall time.** The physical component tracks wall clock within message-delivery bounds; clock skew manifests as apparent reordering but not ambiguity.

Read dependencies are already captured today at every block access through `TransactorSource.tryGet()`. They remain unchanged as a primitive — only their role shifts. Today they are checked once, at the submitting node's PEND phase. Under the new model, *every validator re-checks them during replay*, against the state at the transaction's own HLC.

## Same-HLC Atomicity

"Atomicity at the same HLC" is cleanest as: **one transaction has exactly one HLC**, regardless of how many keys or blocks it touches. All writes and all read-dependency checks within a transaction commit together, at that single logical instant. Two distinct transactions never share an HLC, because the tiebreaking `nodeId` component differs.

This simplifies replay: the "state just prior to HLC(T)" is unambiguous because no other transaction occupies T. It also removes any need to reason about interleaved effects within a transaction — the transaction is the atomic unit, and HLC is its identity in time.

For multi-collection transactions, the same HLC appears in every affected collection's replay. Different collections may reach the same HLC at slightly different wall-clock times (asynchronous propagation), but once they do, they all see the transaction as having committed at the same logical instant. Atomicity-of-intent is structural; atomicity-of-visibility is eventual.

## HLC Generation and Causal Tracking

A node generates an HLC for a new transaction as:

```
new_hlc.wallMs  = max(local_wall, last_observed_hlc.wallMs)
new_hlc.logical = (new_hlc.wallMs == last_observed_hlc.wallMs)
                    ? last_observed_hlc.logical + 1
                    : 0
new_hlc.nodeId  = self.peerId
```

`last_observed_hlc` is the maximum HLC the node has seen via any means — including transactions received from other nodes. This is the standard Kulkarni-Demirbas HLC construction.

Causal dependencies are captured implicitly: a node cannot assign an HLC earlier than any transaction whose effects it has observed. If the node reads a block whose most-recent committed revision was written at `hlc_X`, any new transaction building on that read has `hlc ≥ hlc_X`.

This replaces today's revision-number-per-block as the causality primitive with HLC-per-transaction. Block revisions still exist as the physical versioning mechanism, but their ordering derives from transaction HLC rather than from a cluster-assigned sequence.

## Convergence via Deterministic Replay

Deterministic replay (today's Theorem 4) already requires:

* Matching engine ID
* Matching schema hash
* Matching base state (verified via read dependencies)
* Matching statement ordering

With HLC as the ordering primitive, these requirements are unchanged for a single transaction. Across transactions, determinism additionally requires that *the replay order is itself deterministic* — which HLC plus `nodeId` tiebreak provides.

The consequence: any two nodes holding the same set of transactions compute the same state for any collection at any HLC point, without coordinating.

The model has one observable difference from today's behavior: **the log can contain transactions that appear, after replay, to have no effect.** A transaction whose read dependencies fail against the replayed state simply doesn't apply — it is observed, content-addressed, and permanently recorded, but its writes do not land. Under today's model, such a transaction is rejected at PEND and never enters the log.

The implication for consumers: "this transaction is in the log" no longer means "this transaction's writes are in effect." Queries must target the *replayed state*, not the *log presence*. This is a meaningful API-level shift — see §"What Becomes Harder" below.

## Tentative vs Stable: The Stability Horizon

Under CRDT sync, a transaction has three states from any given node's perspective:

1. **Local.** The issuing node has assigned an HLC and applied the transaction to its own replay. No one else has seen it yet.
2. **Propagated.** Other nodes have received the transaction and included it in their replays. The transaction is in the log, but its effect may still shift as more causally-concurrent transactions arrive.
3. **Stable.** The node is confident no earlier-HLC transaction will arrive. The transaction's replayed effect is final.

Stability is achieved when the node has observed transactions from every relevant peer with `hlc > T`. In practice:

* Within a cluster (peers responsible for the same block), stability is fast — peers exchange recent transactions on every cluster heartbeat.
* Across the network, stability requires either a bounded clock-skew assumption plus a stability window, or explicit **watermark gossip**: each node periodically publishes "I will not issue transactions with HLC below X" for its own peer ID.

Watermark gossip is the principled construction: stability at HLC X holds once every peer in the relevant scope has published a watermark ≥ X. This is the same idea as Kafka's low-watermark and Spanner's safe time, adapted to a P2P topology.

**Why this matters.** A transaction that looks successful at the local node may be preempted by a lower-HLC transaction that arrives later (e.g., from a partitioned peer catching up). Under the replay model, the preemption is just replay producing a different result — no explicit rollback is needed internally. But externally-visible effects (notifications, UI updates, downstream actions) *do* need to wait for stability, or they fire and cannot be unfired. The outbox pattern addresses this.

## External Effects and the Outbox

Every practical database eventually emits external effects: send emails, dispatch webhooks, update external indexes, talk to legacy systems. These are not part of the CRDT replay — they leak out of the system.

Under today's model, external effects can fire on commit because commit is globally agreed. Under CRDT sync, "committed" means "in the log," not "state is stable." Firing on commit can produce observable side effects that don't match the eventual replayed state.

The right shape is an **outbox** pattern tied to the stability horizon:

1. An action declares its external effects as *outbox entries* rather than imperative calls.
2. Outbox entries are part of the transaction's writes — they go through replay and can be preempted.
3. A node-local **effect dispatcher** polls the outbox, firing an effect only when:
   * the transaction is stable (past the stability horizon for the relevant scope), and
   * the transaction's replayed effect actually applied (read dependencies held).
4. Effect dispatch is idempotent by `(transaction ID, effect index)`. Duplicate dispatches from multiple nodes are deduplicated by the external system or a dedicated effect-lease record.

The outbox record is itself a CRDT entry — adding it is a write, marking it dispatched is a later write. Concurrent dispatchers race harmlessly because dispatch is idempotent.

This is strictly *more visible* than today's model: effects are explicit records in the collection, not hidden in application handlers. It trades immediate-fire availability for the ability to safely un-prefer a result that turns out to have been preempted. The stability-horizon delay (typically sub-second intra-cluster, seconds inter-cluster) is the visible cost.

## What Survives; What Changes

| Component | Today | Under CRDT Sync |
|-----------|-------|-----------------|
| Block storage | Versioned blocks, revision-per-tx | Unchanged — revisions derive from replay order |
| Content addressing | SHA-256 block IDs | Unchanged |
| Engines (`QuereusEngine`, `ActionsEngine`) | Translate statements → operations; re-execute for validation | Unchanged |
| Read dependency tracking | Captured; checked at PEND | Captured; checked at every replay |
| Transaction stamp and content hash | Stamp ID at BEGIN; Transaction ID at COMMIT | Unchanged in shape; `id` includes `hlc` |
| Log-tail cluster consensus | Critical-block 2PC; ordering authority | **Removed as sequencer.** Log-tail clusters remain as storage authorities for the log-chain blocks but do not decide ordering. |
| HLC | Not used | Primary ordering primitive |
| Cluster signatures | Promise plus commit on every tx | **Shifted to durability attestation.** A cluster peer storing a tx signs "I have stored it at my local replay rev N"; ordering is separate. |
| Right-is-Right disputes | Validity disagreement blocks tx | **Validity disagreement at replay.** A peer that replays and gets a different state hash from its neighbors signals a dispute; escalation proceeds as today. |
| Partition behavior | Minority partition blocks writes | Each partition progresses locally; divergence resolved at merge (see [partition-healing.md](partition-healing.md)) |
| Availability | CP | Tunable per-collection / per-invariant |

The critical change is the removal of the log-tail cluster as ordering authority. This has two consequences:

* **The hotspot at the log tail disappears.** Every node can commit a transaction locally by issuing an HLC; propagation is asynchronous gossip within the cluster.
* **The "all-or-nothing at commit time" guarantee weakens.** A transaction enters the log; whether its effects are visible is a replay result that can shift until stability.

## Byzantine Resilience Under CRDT Sync

Today's Byzantine tolerance rests on Ed25519-signed promises and commits plus the dispute escalation mechanism ([right-is-right.md](right-is-right.md), Theorem 10). CRDT sync preserves this with adjusted primitives:

* **Transaction authenticity.** Each transaction is client-signed (already the target per right-is-right.md §"Client Signatures"). Any node can verify the signature without trusting the serving peer. Unchanged.
* **Storage authenticity.** A cluster peer signs "I have stored transaction T at my local replay rev N." This is a *durability attestation*, not an ordering vote. A super-majority of durability attestations gives the same K×¾ threshold as today's commit signatures — the transaction is durably replicated before being treated as stable.
* **Replay disagreement.** If two peers in a cluster replay the same log and produce different states, exactly one is running divergent software or has been fed a divergent log by a Byzantine peer. This is caught by periodic cross-peer state-hash comparison within the cluster. Disagreement triggers a Right-is-Right dispute whose subject is "what is the correct replay result at HLC X?" — decidable by fresh validators re-replaying from the last agreed checkpoint.
* **Equivocation.** Today a Byzantine peer could sign conflicting promises for one transaction. Under CRDT sync, equivocation shifts: a Byzantine node might try to issue two transactions that present the same HLC. `nodeId` is part of the HLC, so two transactions from the same node necessarily have different HLCs unless their `(wallMs, logical)` pairs also match — in which case they must either be the same transaction (same content hash, idempotent) or equivocation evidence that bans the node.

The global honest-majority assumption (correctness.md §1.5) is still required and still sufficient. The mechanism shifts from "honest majority gates ordering" to "honest majority attests durability and catches replay divergence."

## What Becomes Harder

**Snapshot isolation semantics shift.** Today, once a transaction commits, its writes are visible to every later reader. Under CRDT sync, a transaction's writes are visible from its HLC onward, but a reader at HLC `T' > T` may see no effect if a lower-HLC transaction arrives later and invalidates the read dependencies. This is still a form of snapshot isolation — every replay at `T'` is internally consistent — but the snapshot at `T'` can change as more transactions arrive. Applications reading "current state" must choose:

* **Stable read** — query state at the stability horizon (slightly stale, final).
* **Tentative read** — query state at the latest local HLC (fresh, may shift).

Most reads in current applications assume stable semantics by default. The API should make this distinction explicit; `readAt: 'stable' | 'tentative' | HlcTimestamp` is the natural parameter.

**Write-skew prevention is preserved but re-examined.** Read dependencies continue to prevent write-skew at replay time. But write-skew detection is now *per-replay-instance* rather than *at commit*. Two transactions that would write-skew each other both enter the log; under replay, one wins (whichever's read dependencies hold against the other's already-applied writes) and the other is skipped. This is the expected CRDT semantics but differs from today's "reject the loser at PEND."

**Atomicity across collections is re-examined.** Today's GATHER phase (transactions.md §"The GATHER Phase") uses a temporary supercluster to drive multi-collection 2PC. Under CRDT sync, a single transaction can still span multiple collections — it simply has one HLC across all of them, and replay in any collection sees the same transaction with the same preconditions. Atomicity-of-intent is preserved (all writes share an HLC; all apply or none). Atomicity-of-visibility is weakened as described above: different collections may see the transaction stabilize at slightly different times, but every replay in every collection eventually reaches the same result.

**Transaction rejection is subtler.** Today, the issuing client learns at PEND or COMMIT whether its transaction succeeded. Under CRDT sync, "did my writes land?" is a function of the replayed state at the stability horizon. The issuing client knows its transaction is in the log almost immediately but must wait for stability to know if its writes took effect. For many workloads this is acceptable (the stability window is small). For latency-sensitive workloads with tight feedback, the issuing client can compute its own tentative replay and report the optimistic result, revising if stability disagrees.

**Starvation is possible without a fence.** Under today's model, a transaction that keeps losing race resolution eventually wins because its hash changes on retry (correctness.md §Theorem 9). Under CRDT sync, a transaction whose reads keep getting preempted can fail repeatedly with stable semantics — the issuing client never gets a clear affirmative answer. The mitigation is a **fence primitive**: the issuing node can opt-in to synchronous commit for a specific transaction, reverting to today's log-tail sequencing for that single operation. Fenced transactions interoperate with CRDT-sync transactions — the fenced tx gets an HLC chosen by the log-tail cluster rather than by the issuer, and every subsequent tx with a lower HLC fails its reads deterministically.

**Garbage collection of the log.** Today the log can be truncated via checkpointing. Under CRDT sync, garbage collection requires global agreement that no causally-preceding transaction will arrive with a lower HLC. The stability horizon provides this: transactions older than the network-wide stability watermark minus a safety margin can be compacted (replay result materialized, raw log entries archived to Arachnode inner rings).

## Migration Path

A full rewrite is unnecessary. The design can evolve in stages, and strong-consistency collections coexist with CRDT-sync collections in the same network.

### Stage 1 — Introduce HLC on every transaction

The transaction stamp already carries a `timestamp` and `peerId`. Extend it with a logical counter and adopt the HLC construction at issuance. HLC is recorded but ordering authority remains with log-tail clusters. No semantic change yet — HLC is observational.

### Stage 2 — Make replay authoritative for opt-in collections

For a designated subset of collections (opt-in via collection config), replace log-tail sequencing with HLC-ordered replay. Read dependencies become the authoritative conflict check. Log-tail cluster still stores the log but no longer decides ordering. Multi-collection transactions continue to use GATHER plus 2PC.

### Stage 3 — Stability horizon and outbox

Introduce watermark gossip between cluster peers. Expose `readAt: 'stable' | 'tentative' | HlcTimestamp` in query APIs. Move external-effect emission into an outbox fired at stability.

### Stage 4 — Multi-collection without GATHER

With HLC, a multi-collection transaction no longer needs a synchronous supercluster — each collection independently replays the transaction with the same HLC. Atomicity-of-intent is structural; atomicity-of-visibility is eventual. The GATHER phase becomes optional, used only for collections or invariants that still require synchronous cross-collection commit (see [partition-healing.md](partition-healing.md) §"Reservation and Escrow").

### Stage 5 — Tunable per-collection

Each collection declares its consistency profile:

* **Strong** (today's default) — log-tail sequencing, synchronous commit, CP.
* **Replay** (CRDT sync) — HLC ordering, tentative→stable visibility, available under partition with reconciliation rules.

The two modes coexist. A Tree collection might run in replay mode for a chat app; the accounts Tree might run in strong mode where any overdraft is unacceptable. A collection can also be **hybrid**: replay mode by default with per-invariant escrow for specific fields — see partition-healing.md.

This layered evolution means no flag day. The current guarantees hold for every collection that stays in strong mode. Opt-in to replay is a deliberate application choice with explicit partition semantics.

## Relation to Prior Work

This design sits in well-explored territory. Pointers:

* **Calvin** (Thomson et al., 2012) — deterministic database over an ordered log; the "replay is authoritative" pattern.
* **Parallel Snapshot Isolation** (Sovran et al., 2011) — snapshot isolation across sites without synchronous coordination.
* **TAPIR** (Zhang et al., 2015) — inconsistent replication with application-level conflict resolution at higher layers.
* **Invariant Confluence / I-Confluence** (Bailis et al., 2014) — which invariants can be maintained without coordination; foundational for [partition-healing.md](partition-healing.md).
* **Hybrid Logical Clocks** (Kulkarni et al., 2014) — the clock construction underlying ordering here.
* **CRDTs** (Shapiro et al., 2011) — the convergence discipline; what we get for free when the log is a G-Set.
* **Concurrent Revisions** (Burckhardt et al., 2010) — fork/merge with application-defined reconciliation; a close cousin of the reconcile primitive in [partition-healing.md](partition-healing.md).
* **Local-first software** (Kleppmann et al., 2019) — philosophical framing for prioritizing local progress and merge.

Optimystic's novel contribution in this design is not in any of these primitives individually. It is in combining:

* Content-addressed distributed block storage
* Pluggable engines with deterministic replay
* Ed25519-signed transactions with client authorship
* Right-is-Right-style Byzantine dispute, extended to cover replay disagreement
* Per-collection consistency profiles (strong ↔ replay)

... into a coherent P2P stack where applications choose their consistency posture per-collection without abandoning Byzantine resilience.

## Open Questions

* **Watermark gossip frequency and bandwidth.** What is the minimum watermark exchange rate that provides acceptable stability latency without dominating bandwidth? Likely piggyback on existing cluster heartbeats.
* **Replay cost for long histories.** Materializing state at a given HLC requires replaying all prior transactions. Checkpointing (state-at-stable-horizon snapshotted and signed) is the obvious answer; needs a design pass and integration with Arachnode archival.
* **Tentative read semantics at the application boundary.** What API makes "this is tentative" hard to ignore? SQL naturally resists (a `SELECT` returns rows, not rows + stability level). The Quereus integration likely needs a connection-level `SET read_mode = stable|tentative` plus a per-query hint.
* **Fence semantics under CRDT sync.** A fenced transaction pulls in the old log-tail-consensus machinery for one operation. Does it block concurrent CRDT-sync transactions at the log tail, or only block transactions with lower HLC? The latter is more available but requires careful proof that causality still holds.
* **Clock-skew bounds.** HLC tolerates clock skew but doesn't erase it; a node whose wall clock is far ahead can issue transactions that appear causally later than they should. Should clusters reject transactions whose HLC `wallMs` is wildly out of line with cluster-observed real time? Likely yes, with a tolerance window.

## See Also

* [partition-healing.md](partition-healing.md) — how application-defined rules reconcile partitioned replays. Builds on the model here.
* [transactions.md](transactions.md) — the current transaction protocol.
* [correctness.md](correctness.md) — properties the current design guarantees.
* [right-is-right.md](right-is-right.md) — validity-dispute mechanism, preserved and extended under CRDT sync.
