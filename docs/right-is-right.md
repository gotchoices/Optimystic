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

### File Map

| File | Role |
|------|------|
| `db-core/src/cluster/structs.ts` | `ClusterRecord.disputed`, `disputeEvidence` fields; `ClusterConsensusConfig` extensions |
| `db-p2p/src/dispute/types.ts` | All dispute type definitions |
| `db-p2p/src/dispute/dispute-service.ts` | Core dispute orchestration |
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
