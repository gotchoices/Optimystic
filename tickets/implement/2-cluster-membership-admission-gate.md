description: A node that is asked to help commit a piece of data currently trusts whoever started the transaction about which group of nodes is responsible, even signing off on a group that is really just a small slice of the network — which lets a minority of nodes pretend to be the whole responsible group. Make each node independently check that the declared responsible group actually looks like the real one before it agrees.
prereq: bind-cluster-membership-into-signed-record
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMemberComponents ~101-121, validateRecord ~509-523, promise-phase handling; add member-side membership derivation)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (validateSmallCluster ~347-385 — coordinator-side reference behavior to mirror)
  - packages/db-core/src/network/i-key-network.ts (findCluster — the derivation source)
  - packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig — thresholds/tolerance)
  - docs/correctness.md (Theorem 2 Partition Safety, §7.1 Sybil, §7.2 Partition)
difficulty: hard
----

## Background

`bind-cluster-membership-into-signed-record` (the prereq) makes a transaction's peer set part of its
signed identity: two different peer sets now produce two different `messageHash`es. That closes the
*silent-divergence* hole. It does **not** decide *which* peer set is the legitimate cluster for a block —
a member still signs an `approve` for whatever set the coordinator declares, as long as the signatures
and the (now membership-bound) hash check out.

That residual gap is the partition / self-shrink hazard behind Theorem 2 in `docs/correctness.md`. The
super-majority arithmetic ("both sides of a partition would need ⌈0.75K⌉ + ⌈0.75K⌉ ≤ K peers, a
contradiction") assumes a single shared cluster size **K**. Nothing forces the members of a minority
partition to use the *full-network* K: a coordinator on the minority side re-derives a smaller local
cluster of size K′ < K and can reach 75% of **K′**. The coordinator-side `validateSmallCluster`
(`cluster-coordinator.ts:347-385`) already fails **closed** by default when FRET confidence is low — but
that guard only runs on the coordinator. **The members have no equivalent check**: `ClusterMember` today
only reports network size to FRET; it never derives its own view of who should be in the cluster, so it
will happily vote inside a self-shrunk set.

## What this ticket does

Give each cluster member an **admission gate**: before it contributes a promise/approve to a record, it
independently derives its own view of the block's cluster and checks that the record's declared peer set
is a *legitimate* cluster it belongs to. A member that cannot admit the declared set declines to approve
(reject vote, or abstain) rather than rubber-stamping a set the coordinator chose. This makes membership
something the members **agree on**, not merely something bound to a hash.

### Member-side cluster derivation

Inject a derivation capability into `ClusterMember` (via `ClusterMemberComponents`) — the same source the
coordinator uses, i.e. `IKeyNetwork.findCluster(blockId)` (`packages/db-core/src/network/i-key-network.ts`)
or a thin `deriveExpectedCluster(blockId): Promise<{ peers: ClusterPeers; confidence: number }>` wrapper
that also surfaces FRET's network-size confidence. Keep `ClusterMember` transport-agnostic — inject the
capability, don't import FRET directly (mirror how `reconcileBlock` / `fretService` are injected today).

The gate is **optional/injected**: nodes that cannot derive a view (no FRET, tests) fall back to current
behavior, but that fallback must be the *closed* posture for downsizing (see below), not an open one.

### Admission predicate

Let `D` = the declared set (`record.peers`), `E` = the member's own derived expected set, `K_est` = the
member's confident network-size / cluster-size estimate.

Admit `D` for voting iff **all** hold:

1. **Self-membership.** The member's own peer id ∈ `D`. A member asked to vote in a cluster it does not
   belong to rejects — it is not this block's responsibility.
2. **Not a self-shrink below the floor.** `|D| ≥ floor`, where
   `floor = max(minAbsoluteClusterSize, ⌈admissionFraction · K_est⌉)` **when the member has a confident
   estimate**, and `floor = clusterSize` (the configured full size) when `allowClusterDownsize` is false.
   This is the anti-partition guarantee: a minority side's `D` is exactly the shrunk set, and the floor
   derived from the member's *own* estimate rejects it.
3. **Consistency with the member's view.** `D` is within the existing `clusterSizeTolerance` of `E` — i.e.
   the symmetric difference `|D △ E|` is within tolerance and `D` is not a wholesale-disjoint or
   drastically-smaller set than `E`. Honest transient churn (a peer or two) is absorbed; a self-shrunk or
   fabricated set is not.

On failure the member does **not** contribute an approve. Prefer an explicit `reject` vote with a
diagnostic reason (`membership-not-admitted`) so the coordinator's existing rejection accounting
(`executeTransaction` `:283-310`) and the dispute machinery see it, rather than a silent timeout.

### Partition / low-confidence posture (fail closed)

When the member **cannot confidently derive** `E`/`K_est` (low FRET confidence — exactly what a partition
induces), the gate must **fail closed for any downsizing decision**: do not admit a below-full-size `D`.
This mirrors the coordinator's hardened `validateSmallCluster` default (`admit = allowUnvalidatedSmallCluster ?? false`).
A member on a minority side, unsure of the true network size, must refuse to vote a shrunk cluster into
super-majority. The `allowUnvalidatedSmallCluster` config opt-in (single-node / local dev) applies to the
member gate too, with the same "knowingly below the safe floor" semantics.

### Divergent-but-honest convergence (replacing the old reject-each-other behavior)

Because the prereq binds membership into `messageHash`, two honest members with genuinely different views
now hold two *different* transactions (different hashes), not one contested record — so the old
`'Peers mismatch'` hard-throw path is already gone as an honest-divergence route. This ticket completes
convergence: honest members admit the *same* legitimate set (their derived views agree within tolerance),
so the coordinator that used the members' actual cluster reaches super-majority, and a coordinator that
used a wrong/shrunk set fails to. No new consensus round is introduced — the gate is a local admission
predicate evaluated before voting.

## Edge cases & interactions

- **Churn between prepare and commit.** A peer legitimately joins/leaves mid-transaction. Decision: the
  membership frozen into the record (its identity, per the prereq) is **honored for the life of the
  transaction**; an epoch/topology change does not invalidate an in-flight record. The `clusterSizeTolerance`
  window absorbs a small drift so the transaction still reaches super-majority. If churn exceeds tolerance,
  the transaction simply fails admission on enough members and is retried by the coordinator against a
  freshly derived set — document this as the recovery path. Do not attempt to mutate a record's peer set
  in flight (it would change its hash/identity).
- **Partition / low FRET confidence.** Covered above — fail closed. Add a test: a member whose derived
  `E` is a small shrunk set *and* whose FRET confidence is low must reject a below-full-size `D`, even
  when the record's signatures and membership digest are internally valid.
- **Self not in cluster.** A record whose `peers` omits the receiving member: reject (predicate 1). Guards
  against a coordinator routing a record to a non-member to pad counts.
- **Honest transient divergence.** `D` and `E` differ by one peer (normal eventual-consistency lag):
  admit (within tolerance). Test both directions (D has an extra peer E lacks; E has a peer D lacks).
- **Tolerance boundary.** Test exactly at and just beyond `clusterSizeTolerance` to pin the accept/reject
  edge; a fabricated set half the size of `E` must land firmly on reject.
- **Interaction with the dispute cascade.** A `membership-not-admitted` rejection feeds the existing
  dispute/escalation path (`design-dispute-synchronous-escalation` consumes it). Keep the rejection reason
  string stable and the membership object it inspects unchanged from the prereq.
- **Solo / small legitimate clusters.** A genuinely small network (confident low `K_est`) must still be
  able to transact: the floor uses the member's *own confident* estimate, so a true 3-node network admits
  a 3-node `D`; only an *unjustified* shrink (low confidence, or `|D|` far below `K_est`) is rejected.
- **Derivation cost / caching.** `findCluster` per inbound record adds a lookup on the promise path.
  NOTE this at the call site: if it shows up as hot, cache the derived view per `(blockId, short TTL)` —
  a tripwire, not work to do now.

## Key tests (TDD targets)

- Member in a healthy full cluster admits the coordinator's declared full set (fast path, unchanged
  behavior).
- Member rejects a `D` that is a strict shrink below `⌈admissionFraction · K_est⌉` when confident.
- Member with **low** FRET confidence rejects any below-full-size `D` (fail-closed partition guard) — the
  core Theorem 2 regression test.
- Two members on opposite sides of a simulated partition cannot both reach super-majority: the minority
  side's members refuse admission, so only the majority side commits (split-brain prevention, end-to-end).
- Member rejects a record whose `peers` omits itself.
- Member admits a `D` differing from `E` by one peer (within tolerance), rejects a wholesale-disjoint or
  half-size `D`.
- `allowUnvalidatedSmallCluster` opt-in lets a solo/dev member admit an undersized `D` (documented escape
  hatch still works).

## TODO

- Extend `ClusterMemberComponents` with an injected membership-derivation capability
  (`deriveExpectedCluster` / `IKeyNetwork`); wire it at the composition root the same way `fretService`
  is wired.
- Implement the admission predicate (self-membership, floor-from-own-estimate, tolerance-vs-derived-view)
  and evaluate it on the promise/approve path **before** the member signs an approve.
- Fail closed on low-confidence derivation for any downsize; honor `allowUnvalidatedSmallCluster` as the
  explicit opt-in.
- Emit an explicit `reject` (reason `membership-not-admitted`) on failure so rejection accounting and the
  dispute path observe it.
- Add the tests above (unit for the predicate; a partition-simulation integration test for split-brain
  prevention).
- Add the `NOTE:` tripwire at the `findCluster`-per-record call site about caching the derived view.
- Update `docs/correctness.md` Theorem 2: membership is now agreed via the member-side admission gate
  (each honest member enforces a shared K from its own confident estimate and fails closed under low
  confidence), so a minority partition cannot reach super-majority of a self-shrunk cluster. Cross-link
  §7.1 (Sybil) and §7.2 (partition).
- Run `yarn build` and the db-p2p cluster + coordinator tests; stream output with `tee`.
