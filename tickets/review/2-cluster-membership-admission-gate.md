description: Cluster members now independently check that the group of nodes a transaction claims is responsible actually looks like the real responsible group before they agree to it, so a minority slice of the network can't pretend to be the whole cluster.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (admission gate: admitMembership / evaluatePromise / deriveExpectedClusterView ~ new methods; ClusterMemberComponents + constructor; MEMBERSHIP_NOT_ADMITTED, ExpectedClusterView, DeriveExpectedClusterCallback exports)
  - packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig: added clusterSize?, membershipAdmissionFraction?)
  - packages/db-p2p/src/libp2p-node-base.ts (deriveExpectedCluster wiring; clusterSize folded into consensusConfig)
  - packages/db-p2p/test/cluster-membership-admission.spec.ts (new — 14 tests)
  - docs/correctness.md (Theorem 2 rewrite; §7.1 Sybil + §7.2 partition cross-links)
difficulty: hard
----

## What landed

Each cluster **member** now runs a **membership admission gate** before it signs an `approve` on the
promise phase. Previously a member would sign an approve for whatever peer set the coordinator declared,
as long as the signatures and the (membership-bound, per the prereq) hash checked out — which let a
coordinator on a minority partition declare a self-shrunk `K′ < K` cluster and reach 75% of `K′`. The gate
makes the member independently re-derive its own view of the block's cluster and refuse to vote inside a
set it can't admit.

### The predicate (in `admitMembership`, cluster-repo.ts)

Let `D` = declared set (`record.peers`), `E` = member's own derived set, `K_est = |E|`. Admit iff:

1. **Self-membership** — member's id ∈ `D` (always enforced, even under the opt-in). Else reject
   `membership-not-admitted:self-not-member`.
2. **Floor (confident path)** — `|D| ≥ max(minAbsoluteClusterSize, ⌈membershipAdmissionFraction · K_est⌉)`.
   Else `membership-not-admitted:below-floor`.
3. **Consistency (confident path)** — `|D △ E| ≤ ⌈clusterSizeTolerance · K_est⌉`. Else
   `membership-not-admitted:inconsistent-with-derived-view`.

**Fail-closed posture:** when the member cannot confidently derive `E` (no capability, or FRET confidence
≤ 0.5 — what a partition induces), it refuses any below-full-size `D` measured against the configured
`clusterSize` → `membership-not-admitted:low-confidence-downsize`. With **neither** a confident view nor a
configured `clusterSize`, the gate cannot judge a downsize and preserves the legacy approve (backward
compatibility for nodes/tests with nothing wired). `allowUnvalidatedSmallCluster` is the documented escape
hatch (skips size/consistency gates but not self-membership).

On failure the member emits an explicit `reject` (stable reason prefix `membership-not-admitted`, exported
as `MEMBERSHIP_NOT_ADMITTED`) so the coordinator's rejection accounting and the dispute path observe it —
never a silent timeout.

### Wiring

- New injected `DeriveExpectedClusterCallback = (blockId) => Promise<{ peers; confidence }>` on
  `ClusterMemberComponents`. At the composition root it calls `keyNetwork.findCluster(blockId)` +
  `fretService.getNetworkSizeEstimate().confidence` — the same derivation source the coordinator uses,
  injected so `ClusterMember` stays transport-agnostic (mirrors `reconcileBlock` / `fretService`).
- `ClusterConsensusConfig` gained optional `clusterSize` (member's full-size reference) and
  `membershipAdmissionFraction` (default 0.75). `clusterSize` is now folded into the node's shared
  `consensusConfig` so member and coordinator read one value.
- Confidence threshold is the constant `ClusterMember.MembershipConfidenceThreshold = 0.5`, matching the
  coordinator's `validateSmallCluster` gate.

## How to validate

Build + targeted suites all green locally:

```
# from packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cluster-membership-admission.spec.ts" --colors
```

- `yarn build` (db-core then db-p2p) — clean.
- New spec: **14 passing** (fast path, self-membership, floor, tolerance boundary, disjoint,
  fail-closed/Theorem-2 regression, opt-in, member-layer split-brain).
- Regression: `cluster-repo` + `cluster-coordinator*` (56), mesh/consensus/byzantine/invalidation/sig
  (84), dispute/cascade/reputation (62), coordinator-repo (39) — all passing, no changes needed. The
  mesh-harness sets `allowUnvalidatedSmallCluster: true`, so the gate is transparent there.

### Use cases the gate must satisfy (review targets)

- Healthy full cluster: member admits the coordinator's declared full set (fast path unchanged).
- Confident member rejects a strict shrink below the floor; admits a genuinely small cluster it is
  confident about (solo/small-network liveness preserved).
- **Low FRET confidence + shrunk view rejects any below-full-size D** — the core partition / Theorem 2
  regression. Two members on opposite sides of a simulated partition: minority refuses, majority approves.
- Record omitting the receiving member → reject.
- One-peer churn within tolerance → admit; wholesale-disjoint or half-size → reject.
- `allowUnvalidatedSmallCluster` opt-in admits an undersized D (but not a non-member).

## Honest gaps / where to push (reviewer: treat tests as a floor)

- **Gate runs only on the PROMISE path**, before signing an approve. A member that receives an
  already-at-consensus record via broadcast (cohort drift — never promised) executes it in `handleConsensus`
  **without** the gate. This is deliberate (the gate's job is to withhold *this member's approve*; if a
  super-majority already formed without it, executing is replication). But it means an attacker who can
  already assemble a super-majority on an illegitimate set from *other* (Sybil) members would still get
  honest late-joiners to execute — that's the Sybil-cohort regime already deferred to cohort-topic
  membership certs, not closed here. **Confirm this scoping is acceptable**; if execution-time refusal is
  wanted, that's new work.
- **Split-brain test is at the member layer**, not a full mesh-harness partition with real routing +
  MockMeshKeyNetwork returning shrunk clusters and low-confidence FRET. It demonstrates the asymmetry
  (minority refuses / majority admits) with two independently-configured members. A deeper mesh-level
  partition-simulation integration test would be a stronger regression — candidate to add.
- **Real behavior change for real deployments (flag prominently).** Real nodes now **fail closed** on any
  declared set below the configured `clusterSize` whenever FRET confidence ≤ 0.5. A genuinely small
  production network running below `clusterSize` with `allowDownsize: true` but **no** confident FRET will
  now be *rejected* unless `allowUnvalidatedSmallCluster` is set. This is the intended safety posture, but
  operators must know it. The existing real-libp2p integration tests are safe by construction (they set
  `clusterSize` equal to the actual cohort size, e.g. `clusterSize: 2` with a 2-node cohort, so
  `|D| ≥ clusterSize` → admit; `clusterSize: 1` takes the self-bypass fast path and never hits the gate).
- **Integration suites not run under this ticket.** `*.integration.spec.ts` (real libp2p, multi-coordinator
  writes, substrate) were not executed here (slow / need real network + FRET convergence). The
  clusterSize==cohort-size reasoning above says they should pass, but that is *reasoned, not run* — CI or a
  reviewer with the integration harness should confirm, especially that FRET reaches confidence > 0.5 (or
  `|D| ≥ clusterSize`) fast enough that fresh-network writes aren't refused as low-confidence downsizes.
- **Derivation key.** `deriveExpectedClusterView` derives from `record.coordinatingBlockIds[0]` only — the
  same block the coordinator selects the cluster from (`coordinator-repo.ts:400`). Multi-coordinating-block
  transactions aren't split-derived; matches coordinator behavior but worth a glance.
- **Confidence threshold 0.5 is hardcoded** (constant, not config), intentionally matching the coordinator.
  If the coordinator's gate ever becomes configurable, keep them in lockstep.

## Review findings

- **Tripwire (parked, not a ticket):** `deriveExpectedClusterView` calls `findCluster` once per inbound
  record on the promise path — one routing lookup per vote. Left a `NOTE:` at the call site
  (cluster-repo.ts, inside `deriveExpectedClusterView`) to cache the derived view per `(blockId, short TTL)`
  if it ever shows as hot; it's a pure topology read so a few-seconds-stale view is safe for admission.
