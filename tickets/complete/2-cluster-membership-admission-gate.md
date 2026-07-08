description: Cluster members now independently check that the group of nodes a transaction claims is responsible actually looks like the real responsible group before they agree to it, so a minority slice of the network can't pretend to be the whole cluster.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (admission gate: admitMembership / evaluatePromise / deriveExpectedClusterView; ClusterMemberComponents + constructor; MEMBERSHIP_NOT_ADMITTED, ExpectedClusterView, DeriveExpectedClusterCallback exports)
  - packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig: clusterSize?, membershipAdmissionFraction?)
  - packages/db-p2p/src/libp2p-node-base.ts (deriveExpectedCluster wiring; clusterSize folded into consensusConfig)
  - packages/db-p2p/test/cluster-membership-admission.spec.ts (15 tests)
  - docs/correctness.md (Theorem 2 rewrite; §7.1 Sybil + §7.2 partition cross-links)
difficulty: hard
----

## What landed

Each cluster **member** now runs a **membership admission gate** before it signs an `approve` on the
promise phase. Previously a member signed an approve for whatever peer set the coordinator declared, so a
coordinator on a minority partition could declare a self-shrunk `K′ < K` cluster and reach 75% of `K′`. The
gate makes the member independently re-derive its own view of the block's cluster (via
`IKeyNetwork.findCluster` + FRET confidence) and refuse to vote inside a set it can't admit.

Predicate (in `admitMembership`, `cluster-repo.ts`), with `D` = declared set, `E` = derived set,
`K_est = |E|`:

1. **Self-membership** — member's id ∈ `D` (always enforced, even under the opt-in).
2. **Floor (confident path)** — `|D| ≥ max(minAbsoluteClusterSize, ⌈membershipAdmissionFraction·K_est⌉)`.
3. **Consistency (confident path)** — `|D △ E| ≤ ⌈clusterSizeTolerance·K_est⌉`.

**Fail-closed posture:** when the member cannot confidently derive `E` (no capability, or FRET confidence
≤ 0.5 — what a partition induces), it refuses any below-full-size `D` measured against the configured
`clusterSize`. With neither a confident view nor a configured `clusterSize`, the gate preserves the legacy
approve (backward compatibility). `allowUnvalidatedSmallCluster` is the escape hatch (skips size/consistency
gates, not self-membership). Failures emit an explicit `reject` with reason prefix `membership-not-admitted`
(exported `MEMBERSHIP_NOT_ADMITTED`) so the dispute path observes them.

Wiring: injected `DeriveExpectedClusterCallback` on `ClusterMemberComponents`, sourced at the composition
root from `keyNetwork.findCluster(blockId)` + `fretService.getNetworkSizeEstimate().confidence` (same
derivation the coordinator uses). `ClusterConsensusConfig` gained optional `clusterSize` and
`membershipAdmissionFraction` (default 0.75); `clusterSize` is folded into the shared `consensusConfig` so
member and coordinator read one value. Confidence threshold is the constant
`ClusterMember.MembershipConfidenceThreshold = 0.5`, matching the coordinator's `validateSmallCluster` gate.

## Review findings

**Verdict:** implementation is sound and matches the design. Cross-checked the two invariants the gate's
correctness hinges on and both hold: the member derives its view with the SAME key encoding the coordinator
uses (`new TextEncoder().encode(blockId)` → `findCluster`, cluster-coordinator.ts:118 vs
libp2p-node-base.ts:711), and the confidence threshold `> 0.5` matches the coordinator's
`validateSmallCluster` (cluster-coordinator.ts:352). Config fields exist and typecheck; integration suites
set `clusterSize` == cohort size so `|D| ≥ clusterSize` keeps them on the admit path.

### Checked — aspect by aspect
- **Correctness / security (the whole point):** the three predicates + fail-closed branch implement the
  Theorem-2 defense as documented. Self-membership is enforced independent of the opt-in. Encoding and
  threshold parity with the coordinator verified (above).
- **Edge cases:** found and fixed one — see below. Boundary (`symDiff == maxDiff`), disjoint-same-size,
  full-size-under-low-confidence, and no-capability paths are all covered by tests.
- **Error handling:** `deriveExpectedClusterView` swallows `findCluster` errors → `undefined` → treated as
  not-confident (fail-closed). Correct direction.
- **Resource cleanup:** no new timers/handles; `dispose()` path unchanged.
- **Type safety:** new exports (`ExpectedClusterView`, `DeriveExpectedClusterCallback`,
  `MEMBERSHIP_NOT_ADMITTED`) are typed; `clusterSize`/`membershipAdmissionFraction` optional on the config.
- **DRY / modularity:** gate is transport-agnostic via the injected callback (mirrors `reconcileBlock`);
  derivation source shared with the coordinator. No duplication.
- **Docs:** `docs/correctness.md` Theorem 2 rewrite + §7.1/§7.2 cross-links read correctly against the
  shipped behavior; no stale claims found in the touched files.

### Found & fixed inline (minor)
- **Confident-but-empty derived view false-reject (liveness).** When `deriveExpectedCluster` returned a
  confident view with an *empty* peer set (`K_est = 0`), `maxDiff = ⌈tol·0⌉ = 0`, so predicate 3 rejected
  *any* non-empty declared set as `inconsistent-with-derived-view` — a stricter, worse outcome than an
  *absent* view (which fails closed only on downsize). Fixed by treating an empty confident view as
  not-confident, so it takes the fail-closed-or-legacy branch instead of spuriously rejecting a legitimate
  full cluster. Not normally reachable (a responsible member's `findCluster` includes at least itself), but
  guards a transient empty read. Added a regression test (`empty derived view` describe block); admission
  spec now **15 passing**.

### Filed as new ticket (major — deferred, needs infra)
- **`backlog/debt-mesh-level-partition-admission-regression`** — the split-brain test is member-layer only
  (two independently-configured members), not a real mesh partition with routing + shrunk-cluster key
  network + collapsing FRET confidence. A deeper integration regression is worth adding but needs harness
  work: the existing mesh harness sets `allowUnvalidatedSmallCluster: true`, which disables the gate, so it
  can't exercise it as-is.

### Recorded as tripwires (not tickets)
- **Per-vote routing lookup.** `deriveExpectedClusterView` calls `findCluster` once per inbound promise
  record. Existing `NOTE:` at the call site (cluster-repo.ts) already parks the "cache per (blockId, short
  TTL) if hot" idea; left as-is.
- **Default `clusterSize = 10` + fail-closed = real deployment behavior change.** A genuinely small
  production network below the configured `clusterSize` with unconverged FRET (confidence ≤ 0.5) and no
  `allowUnvalidatedSmallCluster` will have writes **refused** until FRET converges. This is the intended
  safety posture and the implement handoff already flags it prominently; the escape hatch exists. Purely
  conditional ("only bites a small net running below clusterSize with cold FRET and no opt-in"), so recorded
  here rather than filed. Operators of small nets should set `clusterSize` to the real cohort size (as the
  integration tests do) or opt in.

### Reviewed & accepted as-scoped (no action)
- **Gate runs only on the PROMISE path.** A member that receives an already-at-consensus record via
  broadcast executes it in `handleConsensus` without the gate. Deliberate: the gate's job is to withhold
  *this member's approve*; executing an already-formed super-majority is replication. The residual
  Sybil-cohort concern (attacker assembles a super-majority from other Sybil members) is separately deferred
  to cohort-topic membership certs, not this ticket.
- **Derivation key = `coordinatingBlockIds[0]` only.** Matches the coordinator's cluster selection; multi-
  coordinating-block transactions aren't split-derived, consistent with coordinator behavior.

### Empty categories
- **New backlog `bug-`/`feat-` tickets:** none — no defects beyond the one fixed inline, no scope gaps
  warranting a feature ticket.
- **`blocked/`:** none — no human-only decisions or out-of-repo dependencies surfaced.

## Validation

- `yarn build` (db-core → db-p2p): clean.
- `cluster-membership-admission.spec.ts`: **15 passing** (14 original + 1 new empty-view regression).
- Full non-integration db-p2p suite: **1192 passing, 11 pending, 1 failing**. The single failure is
  `mid-ddl-crash.spec.ts` (Tree DDL crash recovery, solo node) — **pre-existing and unrelated**: outside the
  cluster subsystem this diff touches, and the solo-node case takes the `peerCount <= 1` self-bypass and
  never reaches the gate. Flagged in `tickets/.pre-existing-error.md` for the triage pass.
- Integration suites (`*.integration.spec.ts`) not run here (slow / need real libp2p + FRET convergence);
  they set `clusterSize` == cohort size so `|D| ≥ clusterSize` keeps them on the admit path — reasoned, to be
  confirmed by CI.
