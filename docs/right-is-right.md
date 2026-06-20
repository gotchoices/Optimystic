# Right-is-Right: Validity Disputes & Cascading Consensus

## Overview

Optimystic's cluster consensus uses a two-phase commit where cluster peers independently validate transactions and vote. The **Right-is-Right** architecture handles the case where peers disagree on transaction **validity** — not staleness or other innocuous rejections, but fundamental disagreement about whether a transaction is valid.

The core principle: **if cluster peers don't agree on validity, they can no longer coexist in the same network.** One side is wrong — whether from bugs, stale software, or malice — and must be ejected. The algorithm itself is agnostic about which side is "right"; it simply escalates until one side achieves consensus among a wider audience, and the losing side is dropped.

## Economic Model

Every escalation costs the network work. The system is designed so that **whoever is wrong pays for that work** through reputation penalties and ejection. This creates natural economic pressure:

- **Against bad validation**: if your engine is wrong, you'll lose the dispute and get ejected. Fix your software.
- **Against frivolous disputes**: escalation is expensive. If you're wrong, the cost falls on you.
- **Geometric cost curve**: a single bad peer in a cluster costs one escalation round (~2x work). A coordinated attack costs multiple rounds (~4x, 8x...). Near-global corruption degenerates to blockchain-style everyone-votes consensus — but this should essentially never happen for legitimate transactions.

The investment in a slow dispute pays for itself: once bad peers are ejected, subsequent transactions in that ring segment are faster.

## The Algorithm: Team A vs Team B

At this layer, there is no external referee to determine who is "right." The algorithm works in terms of **Team A** (peers who approve validity) and **Team B** (peers who reject validity). Whichever side the expanding audience agrees with wins; the other side is ejected. Correctness emerges from the assumption that the wider network is majority-honest — a bad local cluster gets outvoted when the audience grows.

### Fast Path: Unanimous Agreement

If all cluster peers agree — all approve or all reject validity — the transaction proceeds (or fails) at full speed. No dispute, no extra cost. This is the common case.

### Dispute Path: Validity Disagreement

Any disagreement on validity triggers the dispute mechanism. The transaction is **blocked** — it does not commit until the dispute resolves. This is intentionally slow, because the network is diagnosing itself.

### Trust Model

1. The **coordinator** validates first, then sends the transaction to the cluster. By sending it, the coordinator has implicitly endorsed validity — it is on Team A.
2. **Members** validate independently. If a member disagrees, it knows the coordinator is on the other side and cannot be trusted to fairly orchestrate the dispute.
3. Disagreeing members return their disapproval (so things move quickly), then independently orchestrate the escalation.
4. The **client** is an observer and initiator, not a voter. It signs transactions with its public key. After a dispute resolves, it sides with whichever nodes it agrees with and bans the others. A bad client ends up in a sparser network with only peers that share its (incorrect) view.

### Dissent Coordinator Selection

When members disagree with the coordinator's validity assessment, a **dissent coordinator** must be deterministically selected to lead the escalation. The cluster record tells each member who the other members are. Using a deterministic rule (e.g., the dissenting member nearest the block ID in FRET numeric distance), all parties independently compute who leads the dissent — no coordination needed.

This also helps in the non-malicious case: the original coordinator can inform the client who the dissent coordinator is, so the client knows where to look for status.

### Client Transaction Signatures

The client's public key and signature on the transaction serve two purposes:

1. **Authentication**: cluster members can verify that a transaction is unmodified when the client contacts them directly
2. **Recovery**: if the coordinator is unresponsive or disputed, the client can reach out to other cluster members to learn their stance on the original transaction

### Cascading Escalation

```
 Cluster (K peers)     Enlistees Ring 1 (K)    Enlistees Ring 2 (K)     ...
     │                        │                        │
     │  unanimous?            │                        │
     │  YES → fast path       │                        │
     │  NO  → split           │                        │
     │                        │                        │
     │  D enlists ──────────> │                        │
     │                        │  unanimous?            │
     │                        │  YES → resolved        │
     │                        │  NO  → split           │
     │                        │                        │
     │                        │  D' enlists ─────────> │
     │                        │                        │  ...
```

1. **Cluster validates** — coordinator sends transaction to K cluster peers. If unanimous → done.
2. **Split detected** — disagreeing members elect a dissent coordinator (D) deterministically. D enlists the next K peers by FRET ring distance (beyond the original cluster) for re-execution.
3. **Enlistees validate** — if enlistees are unanimous, the dispute is resolved. The losing side (whichever team the enlistees disagree with) is ejected.
4. **Enlistees also split** — if the expanded audience also disagrees, the disagreeing subset escalates further to the next ring. The audience grows geometrically.
5. **Convergence** — escalation continues until one side achieves consensus at a given level. In the worst case (near-global disagreement), this degenerates to whole-network consensus — the blockchain extreme. But for honest disagreements, resolution typically happens at step 2 or 3.

### Resolution & Ejection

When one side wins at any escalation level:

- The losing peers are **ejected** — surviving peers stop recognizing them
- The **ring segment self-heals**: ejected peers' slots are filled by the next-nearest peers in the FRET DHT
- **Reputation penalties** are applied, affecting the ejected peers' standing network-wide
- If the coordinator was on the losing side, the client must re-engage with a coordinator from the winning side

## Scenario Analysis

The actors — client (C), coordinator (O), members (M), enlistees (E) — can each be on the "right" or "wrong" side. From the algorithm's perspective, these are just Team A and Team B. The scenarios below use "good" and "bad" for readability, where "bad" means "evaluates validity incorrectly" regardless of cause.

### 1. All Agree — Fast Path

`C:good, O:good, M:all-good` — C submits valid tx, O validates (pass), all M validate (pass). Unanimous. Fast path, commit. No dispute, no cost.

### 2. Bad Minority in Cluster

`C:good, O:good, M:majority-good + minority-bad` — Most M approve, minority M disapprove. Minority elect D, D enlists E. E agree with majority → bad minority ejected. **Cost**: one escalation round. Ring segment heals.

### 3. Bad Majority in Cluster

`C:good, O:good, M:minority-good + majority-bad` — Majority M disapprove. They elect D, D enlists E. E agree with O and the approving minority → bad majority ejected. Cluster reforms from FRET neighbors. **Cost**: higher — most of the cluster replaced. But the wider network is honest, so the bad local majority gets outvoted.

### 4. Bad Coordinator, Good Members

`C:good, O:bad, M:all-good` — O endorses something invalid, sends to cluster. ALL members disagree → unanimous rejection. O can't commit. Members flag O. Client contacts members directly (signed tx allows verification), learns coordinator was wrong, bans O, retries with a different coordinator. **Cost**: one failed round.

### 5. Bad Client, Good Coordinator

`C:bad, O:good, M:all-good` — C submits invalid tx. O validates → rejects immediately. Transaction never reaches cluster. C tries other coordinators — same result. Bad C is locked out. **Cost**: zero to the network.

### 6. Bad Client + Bad Coordinator, Good Members

`C:bad, O:bad, M:all-good` — C submits invalid tx, bad O passes it, sends to cluster. ALL members reject → unanimous rejection. O can't commit. Members flag O. C and O are isolated — C can't find an honest coordinator willing to pass its invalid tx. **Cost**: one wasted round for the cluster.

### 7. Bad Client + Bad Coordinator + Bad Minority Members

`C:bad, O:bad, M:majority-good + minority-bad` — Bad O passes invalid tx, bad minority M approve, good majority M disapprove. Good majority elect D, enlist E. E agree with good majority → bad O + bad minority ejected. **Cost**: one escalation round.

### 8. Bad Client + Bad Coordinator + Bad Majority Members

`C:bad, O:bad, M:minority-good + majority-bad` — The worst local scenario. Bad O + bad majority approve, good minority disapprove. Good minority elect D, enlist E. E (from the wider honest network) agree with good minority → bad O + bad majority ejected. Cluster rebuilds. **Cost**: expensive — full cluster replacement. But the ring heals.

### 9. Cascading Split (Bad Enlistees Too)

`C:bad, O:bad, M:minority-good + majority-bad, E:split` — First escalation also splits. Disagreeing E escalate further. Audience keeps growing geometrically. Eventually honest nodes outnumber bad ones (assuming globally honest majority). **Cost**: geometric. This is the degeneration to blockchain-style consensus — but it only happens with near-global corruption.

### 10. Unresponsive Coordinator

`C:good, O:unresponsive` — C has a timeout. After expiration, C contacts cluster members directly (C's signature lets members verify authenticity). Members report status. C identifies a functioning coordinator or the dissent coordinator and re-engages. O gets flagged for non-responsiveness.

## Open Design Questions

- **Escalation fan-out**: when D enlists enlistees, how many? Same as original cluster size? Double? Larger fan-out converges faster but costs more per round.
- **Escalation termination threshold**: at each level, must enlistees be unanimous to resolve, or does a super-majority suffice? Requiring unanimity is cleaner conceptually (unanimity is always the rule, audience just grows) but a single buggy enlistee could force unnecessary escalation.
- **Ejection durability**: how are ejection rulings stored and propagated? They likely need to be signed, durable artifacts that new peers in the ring segment can discover — otherwise ejected peers could rejoin immediately.
- **Rejoin policy**: after ejection (e.g., a node fixes its buggy software), what's the path back? Time-based decay? Original ruling re-validation ("evidence" ruling is kept with evictions?)?

## Current Implementation

The current implementation represents a first iteration of these concepts. The design above captures the target architecture; the implementation will evolve toward it.

### Current Behavior: Threshold-Based Resolution

Promise resolution currently uses a configurable `superMajorityThreshold` (default: 0.67):

```
superMajority = ceil(peerCount * superMajorityThreshold)
maxAllowedRejections = peerCount - superMajority
```

A transaction proceeds to commit when `approvedPromises >= superMajority`. When it proceeds despite minority rejections, the `ClusterCoordinator` marks the record:

```typescript
record.disputed = true;
record.disputeEvidence = {
  rejectingPeers: string[],
  rejectReasons: { [peerId: string]: string }
};
```

**Target change**: instead of threshold-based override, any validity disagreement blocks the transaction and triggers the dispute/escalation path.

### Current Behavior: Async Dispute

Currently, disputes run asynchronously — the transaction commits first, then the minority can challenge. Arbitrators are selected by ring distance (FRET) beyond the original cluster, re-execute the transaction, and vote. A 2/3 super-majority of decisive votes determines the outcome.

**Target change**: disputes will be synchronous (block the transaction) with cascading escalation.

### Durable Invalidation (Reversing a Proven-Invalid Commit)

When a dispute resolves `challenger-wins`, the committed transaction `T_inv` has been **proven invalid**. The reversal is durable, replicated, and audit-preserving — it is *not* an in-memory status flip.

**Compensating entry, never rewrite.** The collection log is an append-only, prior-hash-linked chain; entries are immutable once committed. So the reversal is represented as a new **`InvalidationEntry`** appended to the log (a third arm alongside `action` and `checkpoint`), carrying:

- `invalidatedActionId` / `invalidatedRev` — the action being reversed and the revision it pins;
- `resolution` — a `DisputeResolutionProof` (the independently-verifiable subset of the resolution: outcome, `messageHash`, and the signed arbitrator votes);
- `reverted[]` — per-block `{ blockId, fromRev, restoredContentHash }` recording the compensating revision each block received.

**Append-forward reversal.** Block revisions are monotonic and prior revisions are retained. The invalidation does not delete `T_inv`'s revisions; for each block `T_inv` wrote it writes a **new** revision whose content equals the block's state *as if `T_inv` had not committed* — `materializeBlock(invalidatedRev − 1)` with any surviving later actions replayed on top. The content is recomputed from stored revisions only (never by re-running the engine), so `restoredContentHash` is deterministic across members.

**Consensus path.** The invalidation is an `invalidate` operation carried through the **same critical-cluster machinery** as any transaction (`ClusterMember.applyConsensusOperation`): it takes a revision slot, serializes against concurrent commits, and is applied deterministically on every member — no new global lock.

**Invalidation certificate.** A member applies an `InvalidationEntry` only if its `resolution` is a valid certificate — `outcome === 'challenger-wins'` and the `agree-with-challenger` votes meet the 2/3 decisive-vote threshold, each Ed25519 signature verified against its arbitrator's embedded key, each vote bound to the specific reversed transaction, drawn from the legitimately-selected arbitrator set, and counted at most once per arbitrator. This is the reversal analogue of the commit certificate: a compromised peer can withhold an invalidation but **cannot forge** one. Application is idempotent, keyed on `(invalidatedActionId, disputeId)`.

> **Unforgeability — all three bindings now hold (target #2, dedup #3, arbitrator-set #1).** Votes are signed over a *target- and set-bound v3 payload* `v3:${disputeId}:${vote}:${computedHash}:${targetHash}:${setHash}`, where `targetHash = hashString(messageHash | invalidatedActionId | sortedBlockIds)` and `setHash = hashString(sortedArbitratorSet)`. `verifyInvalidationCertificate(proof, target, options?)` recomputes both from the proof's `messageHash` plus the **apply-path target**, so a genuine proof for transaction X can no longer be replayed against an unrelated transaction Y — every signature fails. The count loop dedups by `arbitratorPeerId` and drops an equivocating arbitrator from both sides, so a single vote cannot manufacture a super-majority. v1/v2/unversioned votes are rejected, not accepted-by-default.
>
> The arbitrator-set binding (#1) closes the synthetic-cohort hole in defense-in-depth layers, strongest-available-wins. **Layer 1 (always):** the proof carries `arbitratorSet` (the K peer-ids the challenger selected via `selectArbitrators`) and `arbitratorSetSignature` (the challenger's Ed25519 signature over `(disputeId, target, arbitratorSet)`, verified against its embedded key); the verifier counts only votes whose `arbitratorPeerId ∈ arbitratorSet`, and a tampered set breaks the challenger signature. This binds the originator and defeats a third-party relay. **Layer 2 (best effort):** when the verifying member holds a topology view (`ClusterMember` has `peerNetwork`/FRET), an injected recompute capability re-derives the eligible set and rejects a forged one — closing even a *fully-malicious challenger* that self-signed a sybil set. **Degradation (none-available):** a member that can neither recompute the historical topology (late-joiner / churned view) nor anchor the set via the trust chain accepts on layer 1 alone and **logs** that it applied an invalidation it could not fully anchor — never a silent accept, never a false reject that would break liveness for late-joiners.
>
> **Residual.** The no-recompute-no-anchor case is the one remaining gap: it is closed in full when the cohort-topic membership-cert trust-anchor chain (`tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`) lands, at which point layer 3 upgrades from accept-and-log to a hard gate, and the live FRET recompute (layer 2) is wired at the composition root with a churn-tolerance window. No durable reversal is originated or applied end-to-end yet (the node-side emit/composition-root wiring is still pending), so this is not a live exploit today.

**Scope.** This mechanism is the single-collection / single-transaction core: it reverses one proven-invalid `T_inv`. Finding and re-evaluating the *transitive read-dependents* of that reversal — across collections — is the **Read-Dependency Cascade** below. Surfacing the reversal to clients (push + authoritative pull) is **Client Notification** below. Delete-restore (reversing a block-*creating* `T_inv`) is recorded but still deferred (the core recognizes a creation only at `invalidatedRev <= 1`). See `db-core/src/log/struct.ts` (`InvalidationEntry`, `DisputeResolutionProof`), `db-core/src/log/log.ts` (`addInvalidation` / `findInvalidation`), and `db-p2p/src/dispute/invalidation.ts` (proof builder, certificate verifier, compensating computation, deterministic applier).

### Read-Dependency Cascade (Re-evaluating the Transitive Dependents)

Reversing `T_inv` is not the end: transactions that **read** a revision `T_inv` produced may now rest on invalid data. The cascade finds those read-dependents and **re-evaluates** each — invalidating only the ones that no longer hold and leaving the rest in place. It is *re-evaluation, not blanket reversal*: a transaction that appeared in the dependency chain but did not actually depend on the bad value is retained untouched.

**Dependency relation.** A committed `T2` is a read-dependent of an invalidated `T1` iff `T2`'s read set contains a `(blockId, revision)` that `T1` produced. Read dependencies are the block-granular `(blockId, revision)` pairs already captured for stale-read detection (`docs/correctness.md` Theorem 5) — the cascade reuses them in reverse: instead of "is this read stale vs the current tip", it asks "did this read observe a now-invalidated revision". This required persisting the committed read set: `ActionEntry.reads` now carries each committed transaction's `(blockId, revision)` pairs (an entry written without them — a legacy entry — is treated as an *unknown dependency*, conservatively re-evaluated, never assumed independent).

**Re-evaluation (retain vs invalidate).** Walk each in-scope collection log forward from `T_inv`, collecting candidates whose read set intersects an invalidated `(blockId, rev)`. For each candidate, decide against the *reverted* state:
- **Retain** — the value it read is unchanged by the revert (a different field changed, a structural-block false dependent, or a redundant write that reverted to the same bytes). Its revision stands.
- **Invalidate** — the value it read no longer holds: append its own `InvalidationEntry` carrying `cascadeRoot = T_inv`, then recurse — its reverted writes feed the next round of candidates.

The default re-evaluator (`contentEqualityReevaluator`) is engine-free and deterministic from stored revisions: it compares the content the dependent *observed* (`blockId@rev`) against the `restoredContentHash` the invalidation recorded. This is *sound but conservative* at block granularity — it never wrongly retains, but because reads are block-granular it may invalidate a dependent that read an unchanged field of a changed block. That is safe (over-invalidation just resubmits the transaction). Field/operation-granular pruning — re-executing the transaction and checking its operations still reproduce — requires an engine and is supplied by injecting a custom re-evaluator. A genuinely-invalidated dependent is **not** auto-reapplied with rewritten operations (that would change its content id / identity); the client resubmits it through the normal optimistic loop.

**Termination & bound.** Dependencies follow strictly increasing revision (a read observes an earlier write), so within a collection the dependency graph is a forward DAG — a back-edge is corruption and errors rather than looping. A dispute can only be raised within the dispute TTL, so `T_inv` is recent, bounding the log suffix walked; and most candidates retain, so the live cascade is far smaller than the suffix. Two hard horizons — `maxCascadeDepth` and `maxCascadeTransactions` (`ClusterConsensusConfig`) — cap it absolutely: on overflow the cascade **stops**, the already-applied child invalidations stand, and the un-cascaded remainder is flagged for operator-escalated full re-sync (a health signal, never a silent truncation). Unbounded automatic reversal is never attempted.

**Multi-collection.** The **root** `T_inv` reversal is atomic across every collection it wrote (its `collectionIds`), via the same GATHER/PEND/COMMIT 2PC as the original commit (Theorem 3). Read-dependents may live in *other* collections (cross-collection read edges), so the forward walk and candidate set span every collection reachable via read-set edges. The **child** invalidations are independent per-transaction events (each its own consensus / deterministic replay), **not** part of the root's atomic set — a member replaying the same seed + logs with a deterministic re-evaluator converges on the same children without a per-child consensus round.

**Restartability.** Each child invalidation is durable and idempotent (keyed on `(invalidatedActionId, disputeId)`, discoverable via `findInvalidation`), so a crashed or partially-applied cascade is restartable: re-running re-derives the frontier from the log and skips already-applied children, converging without duplicate entries. Reverting an ancestor without its dependents is safe-but-stale (the dependents read invalid data but remain detectable), so the cascade is never left silently half-done without a health flag. See `db-p2p/src/dispute/cascade.ts`.

### Client Notification (Learning a Commit Was Reversed)

A client that received `committed` for `T_inv` must be able to learn it was later reversed. Mirroring the commit model, there are two paths — a **push** hint for connected subscribers and an **authoritative pull** on the next status query — and the push **accelerates** but never **gates**: correctness depends only on the authoritative reverted state and the cert verify, never on a notification arriving.

**Push — reuse the reactivity channel.** An `InvalidationEntry` is a committed collection change, so it rides the *same* notification path as a commit (`docs/reactivity.md` §Notification origination): the change event flows through `IBlockChangeNotifier.onCollectionChange` → `ReactivityOriginationManager` → `buildNotificationV1` → emit. The notification reuses the **invalidation's** own commit cert — the threshold signature the cohort produced for the consensus-ordered `invalidate` op, captured by `ClusterMember.applyConsensusInvalidation` via `buildCommitCert` and keyed by the deterministic `invalidationActionId(invalidatedActionId, disputeId)` (`db-p2p/src/cluster/commit-cert.ts`) — bit-for-bit as the notification's `sig`, with no re-signing. So an invalidation notification verifies against the tail cohort's `MembershipCertV1` exactly like a commit notification. A minimal typed marker distinguishes the two: `CollectionChangeEvent.invalidation` / `NotificationV1.invalidation` (a flag) plus `invalidatedActionId`. A generic subscriber ignores the marker and simply refreshes; an invalidation-aware client reacts (drops derived results, resubmits). The marker is a hint — the subscriber still re-reads the authoritative reverted state.

**Pull — authoritative durable status.** `NetworkTransactor.getStatus` reports `committed-invalidated` from **durable** state: for an action that is no longer its block's latest (so block state alone reads `aborted`), it consults the owning collection's log via `Log.findInvalidation`. This survives a node restart (it reads the appended `InvalidationEntry`, not an in-memory map) and is per-node-independent. The dispute layer's in-memory map (`DisputeService.getDisputeStatus`) may stay as a fast cache, but the log is the source of truth. A still-*pending* transaction whose base was invalidated is left `pending` (it will fail its own validation — "pending → will-be-rejected"), never mislabeled `committed-invalidated`.

**Client reaction.** A client holding a result derived from now-invalidated state treats it like a stale read: on `update`/`updateAndSync`, `Collection` surfaces the invalidations that landed since its last sync (`Log.getInvalidationsFrom`, which — unlike `getFrom` — does *not* skip invalidation entries), drops the reverted blocks from its read cache, and replays pending work against the reverted base. This needs no new protocol — invalidation collapses into the same "your base moved, re-sync and retry" path a stale-read rejection already runs, and resubmission is a distinct content-addressed transaction (so it never double-applies). A single dispute can fan out several cascade-child notifications; a client coalesces them by `invalidatedActionId` (`coalesceInvalidatedActionIds`, `db-core/src/reactivity/notification.ts`) so each affected unit is re-derived once.

**Forge resistance.** A compromised forwarder can drop or delay an invalidation notification but cannot forge one — it would need the invalidation's `k − x` threshold signature, which it does not hold; the subscriber verifies the reused cert exactly as for a commit. Dropping it costs the client nothing: the next authoritative read (or `getStatus`) surfaces the reversal regardless.

> **Wiring status.** The push types + pure assembler (`buildNotificationV1`), the invalidation commit-cert capture, the durable `getStatus` path, the client-reaction in `Collection`, and the coalescing helper are implemented and unit-tested. The node-side **emit** of the invalidation change event (the `InvalidationApplySink` calling into the `StorageRepo` change feed with the marker set) is the composition-root wiring shared with the parent invalidation tickets (gap #1) and is gated behind the certificate-binding fix — see `tickets/fix/invalidation-certificate-arbitrator-binding.md`. See `db-core/src/reactivity/{wire,notification}.ts`, `db-core/src/transactor/{change-notifier,network-transactor}.ts`, `db-core/src/log/log.ts` (`getInvalidationsFrom`), and `db-p2p/src/cluster/{cluster-repo,commit-cert}.ts`.

### Dissent Coordinator

**Target addition**: deterministic selection of a dissent coordinator from the disagreeing members, based on FRET distance to the block ID.

### Client Signatures

**Target addition**: client public key and signature on transactions, enabling direct member contact for recovery and status.

### Engine Health Monitor

Each node tracks its dispute losses within a rolling time window. If losses exceed a threshold (default: 3 in 10 minutes), the node flags itself as unhealthy and stops initiating disputes. Auto-recovers when losses decay below threshold. This mechanism remains relevant in the target design — a node that keeps losing disputes should stop escalating.

### Reputation & Penalties

| Reason | Weight | Applied When |
|--------|--------|-------------|
| `FalseApproval` | 40 | Peer approved a transaction that the wider audience determined was invalid |
| `DisputeLost` | 30 | Peer's rejection was determined to be wrong |

Accumulated penalties lead to deprioritization (score >= 20) and banning (score >= 80), with exponential decay over time.

### Protocol

libp2p protocol: `/{prefix}/dispute/1.0.0` — length-prefixed JSON, opt-in via `disputeEnabled` on `ClusterConsensusConfig`.

### Key Types

Defined in `db-p2p/src/dispute/types.ts`:

| Type | Purpose |
|------|---------|
| `ValidationEvidence` | Validator's re-execution results (computed hash, engine ID, schema hash, block state hashes) |
| `DisputeChallenge` | Escalation payload (record, challenger evidence, signature, expiration) |
| `ArbitrationVote` | Arbitrator's independent assessment and evidence |
| `DisputeResolution` | Final outcome with affected peers and penalties |
| `DisputeConfig` | Protocol configuration |
| `EngineHealthState` | Node-local health tracking state |
| `DisputeStatus` | Transaction query status: `committed-disputed`, `committed-validated`, `committed-invalidated` |

Reversal types (defined in `db-core` so the log layer never imports `db-p2p`):

| Type | Purpose |
|------|---------|
| `InvalidationEntry` | Compensating log entry reversing a proven-invalid action (`db-core/src/log/struct.ts`) |
| `DisputeResolutionProof` | Independently-verifiable subset of a resolution carried in the entry (outcome + signed votes) |
| `InvalidateRequest` | The `invalidate` consensus operation that drives a reversal through the critical cluster (`db-core/src/network/struct.ts`) |

### File Map

| File | Role |
|------|------|
| `db-core/src/cluster/structs.ts` | `ClusterRecord.disputed`, `disputeEvidence` fields; `ClusterConsensusConfig` extensions |
| `db-p2p/src/dispute/types.ts` | All dispute type definitions |
| `db-p2p/src/dispute/dispute-service.ts` | Core dispute orchestration; originates the durable invalidation on `challenger-wins` |
| `db-p2p/src/dispute/invalidation.ts` | Proof builder, certificate verifier, compensating-state computation, deterministic applier, shared `hashBlockContent` |
| `db-p2p/src/dispute/cascade.ts` | Read-dependent detection, re-evaluation (retain vs invalidate), recursion with dedup + forward-only DAG guard, horizon escalation |
| `db-core/src/log/struct.ts` / `log.ts` | `InvalidationEntry` / `DisputeResolutionProof` types; `ActionEntry.reads` (persisted read set); `Log.addInvalidation` / `findInvalidation` / `getInvalidationsFrom` (client-reaction surface) |
| `db-core/src/cluster/structs.ts` | `ClusterConsensusConfig.maxCascadeDepth` / `maxCascadeTransactions` cascade horizons |
| `db-core/src/transactor/change-notifier.ts` / `reactivity/wire.ts` | Invalidation push marker: `CollectionChangeEvent.invalidation` / `NotificationV1.invalidation` (flag + `invalidatedActionId`) |
| `db-core/src/reactivity/notification.ts` | `buildNotificationV1` threads the marker; `coalesceInvalidatedActionIds` collapses cascade notifications client-side |
| `db-core/src/transactor/network-transactor.ts` | `getStatus` durable `committed-invalidated` from the log (survives restart) |
| `db-p2p/src/cluster/commit-cert.ts` | `invalidationActionId` key; cluster captures the invalidation's commit cert for reactivity reuse |
| `db-p2p/src/dispute/client.ts` | Network client for sending challenges and receiving votes |
| `db-p2p/src/dispute/service.ts` | libp2p protocol handler for incoming dispute messages |
| `db-p2p/src/dispute/engine-health-monitor.ts` | Rolling-window dispute loss tracking and health flagging |
| `db-p2p/src/dispute/arbitrator-selection.ts` | FRET ring-distance based independent arbitrator selection |
| `db-p2p/src/dispute/index.ts` | Module exports |
| `db-p2p/src/reputation/types.ts` | `PenaltyReason.FalseApproval` (40), `PenaltyReason.DisputeLost` (30) |
| `db-p2p/src/cluster/cluster-repo.ts` | Threshold-based `getTransactionPhase()` in `ClusterMember` |
| `db-p2p/src/repo/cluster-coordinator.ts` | Sets `disputed` flag and evidence on `ClusterRecord` |
| `db-p2p/src/libp2p-node-base.ts` | Wires dispute service, consensus config, and arbitrator selection |
| `db-p2p/test/dispute.spec.ts` | Comprehensive test suite (22 tests) |
