description: A node used its "how many copies to keep" setting to also decide how small a group of peers it would accept a write from, which made small deployments refuse every write out of the box. The second job now has its own setting with a small default, so a two- or three-node deployment works without configuration.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/docs/cluster.md, docs/correctness.md, packages/reference-peer/src/cli.ts, packages/reference-peer/README.md
difficulty: medium
----

# Complete: membership admission gate gets its own size setting

## What shipped

A cluster member decides whether to sign an `approve` for a write by checking that the peer set the
coordinator declared is a legitimate cluster it belongs to. Part of that check is a size floor. That
floor was being computed from `clusterSize`, which is the replication factor — how many copies of a
block to keep. The two are different questions, and because `clusterSize` defaults to `10`, an
unconfigured two- or three-node deployment computed a floor it could never meet and refused every write.

### The split

- `ClusterConsensusConfig.assumedClusterSize?: number` (new, `packages/db-core/src/cluster/structs.ts`)
  — the smallest cohort the operator asserts the deployment can genuinely field. `undefined` means
  "unknown", which the gate treats as "cannot judge a downsize" and admits (the legacy path many call
  sites with no `consensusConfig` rely on).
- `clusterSize`'s doc rewritten to say it is the replication factor only and is not a security yardstick.
- `ClusterMember` (`packages/db-p2p/src/cluster/cluster-repo.ts`) reads `assumedClusterSize` and no
  longer reads `clusterSize` anywhere. A single private `admissionFloor(k)` —
  `max(minAbsoluteClusterSize, ceil(membershipAdmissionFraction · k))` — now serves both branches, which
  fixes a second defect: the fallback branch previously demanded the *full* configured size with no
  fraction and no slack, making it strictly harsher than the measured path on the same numbers.
- Both size-reject reasons now carry their numbers, prefix intact:
  `membership-not-admitted:below-floor (declared=3, floor=6, kEst=8)` and
  `membership-not-admitted:low-confidence-downsize (declared=3, floor=6, assumedClusterSize=8)`.
- `libp2p-node-base` threads `clusterPolicy.assumedClusterSize`, defaulting it to
  `minAbsoluteClusterSize`.
- A one-shot `cluster-member:admission-config` log at construction, so an operator diagnosing a
  rejection can see the node's resolved gate parameters.

### The tradeoff, accepted deliberately

A large network whose operator configures nothing gets a weaker gate in one specific situation: when its
own network-size estimate is unconfident (which is what a partition induces), the floor falls back to
`assumedClusterSize`, defaulted to `2`. A large healthy network takes the confident measured branch and
is at full strength regardless of configuration. The reasoning: "write-dead by default" is a *certain*
failure for every small deployment; "gate degraded under partition" is a *conditional* failure for large
deployments whose operator declined to configure anything, and is one setting away from fixed. The
follow-up that removes the trade entirely (deriving the floor from the largest cohort ever observed) is
parked in `backlog/feat-admission-floor-from-observed-cohort-high-water-mark`.

The review re-examined this direction with fresh eyes and endorses it, with one caveat acted on below:
the "one setting away from fixed" escape hatch has to actually be reachable, and it wasn't everywhere.

## Review findings

### Checked, clean

- **The core split itself.** `clusterSize` is no longer read by `ClusterMember`; the only remaining
  `clusterSize` readers are the corroboration floor (`quorum-restore.ts`, `reconcile-block.ts`,
  `coordinator-repo.ts`), FRET's dynamic-`d` (`spread-on-churn.ts`), cohort assembly
  (`libp2p-key-network.ts`, `network-manager-service.ts`) and the coordinator's downsize check
  (`cluster-coordinator.ts`) — all genuinely replication-factor questions, none of them security
  yardsticks. The decoupling holds.
- **The `clusterSize: 1` direction.** This is the one configuration the change made *stricter*
  (old floor `1`, new floor `2`), so it was checked for a regression. It is not reachable in the shipped
  composition: a one-peer cluster is refused by the *coordinator* first
  (`cluster-coordinator.ts:294`, `Cluster size 1 below minimum 2 and not validated`) unless
  `allowUnvalidatedSmallCluster` is on — and when it is on, the member gate short-circuits to admit
  before reaching any floor. Member and coordinator share one `consensusConfig` object in
  `libp2p-node-base`, so they cannot diverge on that flag within a node.
- **Reason strings are safe to lengthen.** Independently re-verified the implementer's claim:
  `disputeEvidence.rejectReasons` is a per-peer map (`cluster-coordinator.ts:356-364`), the signed
  payload hashes the string each vote carries, and `cluster-coordinator.ts:337` only interpolates
  reasons into an error message no spec asserts verbatim.
- **`docs/internals.md` correctly left alone.** Its three `clusterSize` mentions (lines ~311, ~319, ~532)
  are the corroboration floor and FRET's dynamic-`d`, not the admission gate. Same for
  `docs/transactions.md:509-510` and `NodeOptions.clusterSize`'s doc comment — those belong to
  `implement/corroboration-floor-uses-assumed-cluster-size`, which is sequenced next.
- **No test asserts the `cluster-member:admission-config` construction log fires.** Reviewed and agreed
  with the implementer's call: it is a fire-and-forget side effect with no observable return, and a
  logger spy would couple the spec to the logging shape for no behavioral guarantee. Deliberately not
  added.

### Found and fixed in this pass (minor)

- **Stale doc comment the change missed.** `cluster-repo.ts:120-122` (on `DeriveExpectedClusterCallback`)
  still described the removed behavior — "a configured `clusterSize` still lets the gate fail closed on
  an unjustified downsize". The implementer rewrote `admitMembership`'s doc but not this one. Rewritten
  to point at `assumedClusterSize`.
- **A non-finite `assumedClusterSize` made the node refuse every unconfident write.** The implementer
  flagged this in the handoff and left it; it is a two-line fix and worth having, because the failure is
  silent and total. `Math.max(2, NaN)` is `NaN` and `declared.length >= NaN` is `false`, so a `NaN` from
  e.g. `Number()` of a malformed env var would reject every write the node could not measure — with a
  reason string reading `floor=NaN`, which is at least diagnosable but far too late. `admissionFloor` now
  treats a non-finite scaled size as no usable reference and falls back to `minAbsoluteClusterSize`,
  matching how it already clamps `0` and negatives. Covers `Infinity` and a non-finite
  `membershipAdmissionFraction` too. Two tests added.
- **`docs/correctness.md` §7.2 still claimed unconditional enforcement.** Theorem 2 (line ~112) was
  updated to state the trade, but §7.2 Network Partition Duration (line ~465) still read
  "Write-unavailability on the minority side is *enforced*, not merely expected" with no qualifier — a
  claim the new default makes false for an unconfigured deployment. Qualified, and §7.1's Sybil
  mitigation bullet (line ~456) got a matching pointer.
- **The escape hatch was unreachable from this project's own reference deployment.** The ticket's
  defense of the tradeoff is "a large operator sets one explicit setting" — but `packages/reference-peer`
  exposes `--cluster-size` and `--super-majority-threshold` and had no way to set `assumedClusterSize` at
  all. Before this change `--cluster-size 20` incidentally armed the gate at 20; after it, a
  reference-peer node had a floor of 2 with no CLI recourse. Added `--assumed-cluster-size <number>`
  (parser mirroring `parseClusterSize`, registered in the shared `withCommonPeerOptions` helper so
  `interactive`/`service`/`run` stay in lockstep, threaded into `clusterPolicy`), plus a README entry
  written for an operator rather than an implementer. Verified the flag registers via
  `node packages/reference-peer/dist/src/cli.js service --help`.
- **A magic literal claiming to track another literal.** `libp2p-node-base` had
  `assumedClusterSize: ... ?? 2` with a comment saying it defaults to `minAbsoluteClusterSize` — which
  was separately hardcoded as `2` in the same object literal. Hoisted to a named
  `const minAbsoluteClusterSize = 2` so the two cannot drift.
- **Test boundary asymmetry.** The implementer noted the unconfident branch was pinned at-floor but not
  at-floor-minus-one. Added the twin (`declared=5, floor=6`), so an off-by-one in `admissionFloor` cannot
  pass silently on either side of either branch.

### Found, recorded as a tripwire (conditional — no ticket)

- **The partition-safety margin is now 1.005, and both branches sit on it.** Theorem 2's counting
  argument needs each side of a split to be unable to recruit enough distinct honest members: the
  condition that actually has to hold is `2 · membershipAdmissionFraction · superMajorityThreshold > 1`.
  At shipped defaults that is `2 · 0.75 · 0.67 = 1.005` — true, but with essentially no slack. This was
  already the confident path's margin; what this change did was move the *unconfident* path onto it too
  (it previously demanded the full asserted size, i.e. `2 · 1.0 · 0.67 = 1.34`). Nothing is wrong today
  and no configuration in the repo breaks it, so this is knowledge rather than work. Parked in two
  places: a `NOTE:` on `admissionFloor` in `packages/db-p2p/src/cluster/cluster-repo.ts`, and an
  expansion of the existing Status caveat under Theorem 2 in `docs/correctness.md` (which previously
  cited `0.67 + 0.67 = 1.34` without accounting for the admission fraction at all).

### Found, already tracked — not re-filed

- **The gate has no end-to-end coverage.** `src/testing/mesh-harness.ts` sets
  `allowUnvalidatedSmallCluster: true`, so no mesh or integration test exercises the gate; unit coverage
  in `test/cluster-membership-admission.spec.ts` is its only guard. This is already
  `backlog/debt-mesh-level-partition-admission-regression`, so it was **not** re-filed. That ticket was
  amended instead, because this change made its plan stale: arming the gate in the harness now takes two
  changes, not one — the harness wires no `deriveExpectedCluster` callback, so every member takes the
  "cannot measure" branch, and on that branch the gate needs an `assumedClusterSize` to have any size
  reference at all. Without one the harness approves everything and a test written against it would pass
  vacuously.

### Deliberately out of scope

- `backlog/bug-key-network-cluster-size-default-diverges` (the key network falls back to `16` while
  everything else falls back to `10`) is untouched. This change removed the *admission* consequence of
  that divergence, not the divergence.
- The corroboration floor still reads `clusterSize`, so `NodeOptions.clusterSize`'s doc comment about a
  two-node deployment needing `clusterSize: 2` remains accurate and was left alone.
  `implement/corroboration-floor-uses-assumed-cluster-size` owns it.

## Validation

Run from the repo root after the review edits, all green:

| command | result |
|---|---|
| `yarn build` | pass (all packages) |
| `yarn lint` | pass (exit 0, no output) |
| `yarn test` | pass — `db-core` 1266, `db-p2p` 1431 passing / 41 pending, remainder 52 + 49 + 44 + 43 + 12 + 125 + 326 + 6 + 258 |
| `node packages/reference-peer/dist/src/cli.js service --help` | new `--assumed-cluster-size` flag registers |

`db-p2p` went 1428 → 1431 (three new cases: the non-finite `assumedClusterSize` pair, the non-finite
`membershipAdmissionFraction` case, and the below-floor boundary twin). The membership admission spec is
now 25 cases.

`yarn test:integration` was not run — it is environment-gated and slow, and as noted above it could not
have caught a regression here anyway because the mesh harness disables the gate.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
