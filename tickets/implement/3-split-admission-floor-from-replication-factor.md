----
description: A node currently uses its "how many copies of data to keep" setting to also decide how small a group of peers it will accept a write from, and the out-of-the-box value is big enough that small deployments refuse every write. Give the second job its own setting with a small default so a two- or three-node deployment works without configuration.
files: packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig, ~lines 60-136), packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember fields ~216-263, admitMembership ~845-948), packages/db-p2p/src/libp2p-node-base.ts (NodeOptions.clusterPolicy ~184-196, consensusConfig ~702-716), packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/docs/cluster.md (~700-740), docs/internals.md
difficulty: medium
----

# Give the membership admission gate its own size setting

## The problem, in plain terms

`clusterSize` means **replication factor**: how many peers should hold a copy of each block. It is
what the coordinator aims for when it picks a cohort.

The membership admission gate (added by `cluster-membership-admission-gate`) borrowed the same
number for a second, unrelated purpose. When a node receives a write and cannot independently
confirm how big the network is, it refuses to co-sign any write whose declared peer set is smaller
than `clusterSize`. Because `clusterSize` defaults to `10`
(`libp2p-node-base.ts:715`), a node that was never configured refuses every write from any group
smaller than ten — so a two- or three-node deployment is silently write-dead out of the box.

The two jobs want opposite values: replication wants the number **high**; the admission check wants
it **no higher than the number of peers that actually exist**. One setting cannot serve both.

## What we are doing about it

Split the setting (option 1 in the `plan/` ticket).

- **`clusterSize` keeps only its original meaning** — replication factor / target cohort breadth.
  Default stays `10`. The admission gate stops reading it entirely.
- **New optional setting `assumedClusterSize`** — *the smallest cohort the operator asserts this
  deployment can genuinely field.* This is the yardstick the admission gate falls back to when it
  cannot measure a cohort for itself. `libp2p-node-base` defaults it to `minAbsoluteClusterSize`
  (which that file already sets to `2`), so an unconfigured small deployment works.

### Why not the other two options

Option 2 (derive the yardstick purely from what the node currently observes) was rejected: cohort
views come from `IKeyNetwork.findCluster`, which is unauthenticated, so a partition or a
routing-level attacker could shrink a node's view and talk the requirement down. That is the exact
tension `corroboratorCapacity` already resolved the other way
(`packages/db-p2p/src/cluster/quorum-restore.ts`, commit `50af693`), which deliberately takes
`max(observed, configured − 1)`. Staying consistent with that decision matters more than the
convenience.

Option 3 (one setting, smaller default) leaves the conflation in place and merely moves which
deployments break.

### The tradeoff we are accepting, stated plainly

With `assumedClusterSize` defaulting to `2`, a **large** network whose operator configures nothing
gets a weaker gate than today in one specific situation: when its own network-size estimate is
unconfident. That situation is exactly what a partition induces, so the weakening is not
cost-free.

We accept it because:

- The unconfident branch is the *only* place the setting is read. A large, healthy network takes the
  confident branch, where the gate measures against the node's own derived cohort and is at full
  strength regardless of configuration.
- "Write-dead by default" is a certain failure for every small deployment; "gate degraded under
  partition" is a conditional failure for large deployments whose operator declined to configure
  anything. Trading a certain failure for a conditional one is the right direction.
- The fix for a large operator is a single explicit setting (`assumedClusterSize: 10`), and the
  reject message will now name it (see below).

A follow-up that removes the tradeoff — deriving the floor from the largest cohort this node has
*ever* observed, a quantity an attacker can only push up — is parked in
`backlog/feat-admission-floor-from-observed-cohort-high-water-mark`. Do not build it here.

## Second defect fixed in the same pass: the fallback branch has no slack

Compare the two branches of `admitMembership` (`cluster-repo.ts:868-948`) today:

- **Confident** branch: floor is `max(minAbsoluteClusterSize, ceil(membershipAdmissionFraction × kEst))`
  — with `kEst = 10` and the default fraction `0.75`, a declared set of 8 is admitted.
- **Unconfident** branch: requires `declared.length >= configuredClusterSize` — the *full* size, no
  fraction, no tolerance. With a configured size of 10, a declared set of 8 is rejected.

So the fallback is stricter than the measured path would be on the same numbers, and has zero slack
for ordinary churn or a peer not yet discovered. A deployment sitting at or barely above its
replication factor gets intermittent rejections purely from discovery timing. Fix this by running
**both** branches through one shared floor function, differing only in which size they feed it.

## Target shape

In `ClusterConsensusConfig` (`packages/db-core/src/cluster/structs.ts`):

```ts
/**
 * Configured full cluster size — the replication factor / target cohort breadth. This is what the
 * coordinator aims for when selecting a cohort. It is NOT a statement about how many peers exist,
 * and nothing may use it as a security yardstick; see {@link assumedClusterSize}.
 */
clusterSize?: number;

/**
 * The smallest cohort the operator asserts this deployment can genuinely field — typically
 * `min(clusterSize, number of nodes actually run)`. Read ONLY when a node cannot independently
 * measure a cohort (no derivation capability wired, or no confident network-size estimate), where
 * it stands in for the measured estimate in the membership admission floor.
 *
 * Undefined means "unknown": the admission gate then cannot tell a downsize from a legitimately
 * small cluster and preserves legacy approve behavior. Composition roots should supply a concrete
 * value; `libp2p-node-base` defaults it to `minAbsoluteClusterSize`.
 */
assumedClusterSize?: number;
```

In `ClusterMember` (`packages/db-p2p/src/cluster/cluster-repo.ts`):

```ts
/** Operator-asserted smallest genuine cohort size, or undefined when unknown. */
private readonly assumedClusterSize: number | undefined;

/**
 * The smallest declared peer set admissible against a cohort-size reference `k`, whether `k` is
 * measured (the confident path's `kEst`) or asserted (`assumedClusterSize`). One function so the
 * fallback can never be stricter than the measured path — which it was.
 */
private admissionFloor(k: number): number {
	return Math.max(this.minAbsoluteClusterSize, Math.ceil(this.membershipAdmissionFraction * k));
}
```

`configuredClusterSize` is removed. `admitMembership`'s unconfident branch becomes:

```ts
if (!confident) {
	// No asserted size and no measured one: the gate cannot judge a downsize at all, so preserve
	// legacy approve (nodes/tests constructed without a size reference).
	if (this.assumedClusterSize === undefined) {
		return { admit: true };
	}
	const floor = this.admissionFloor(this.assumedClusterSize);
	if (declared.length >= floor) {
		return { admit: true };
	}
	// ...log, then reject with the numbers (see below)
}
```

and the confident branch's floor becomes `this.admissionFloor(kEst)` — same arithmetic as today,
now shared.

In `NodeOptions.clusterPolicy` (`libp2p-node-base.ts`), a new field:

```ts
/**
 * The smallest cohort this deployment can genuinely field — normally the number of nodes you
 * actually run, capped at `clusterSize`. Used only as the membership admission gate's fallback
 * yardstick when the node has no confident network-size estimate. Defaults to
 * `minAbsoluteClusterSize` (2), which is what lets a small mesh transact without configuration;
 * a large deployment should set this to its real cohort size so the gate can still police a
 * partition-induced downsize while its size estimate is unconfident.
 */
assumedClusterSize?: number;
```

wired into `consensusConfig` as `options.clusterPolicy?.assumedClusterSize ?? <the minAbsoluteClusterSize
literal already there>`.

## Reject messages must name the knob

The reporter lost time because `membership-not-admitted:low-confidence-downsize` gave no hint that a
local setting caused it. Both size rejections get their numbers appended, keeping the existing
machine-readable prefix intact:

```
membership-not-admitted:low-confidence-downsize (declared=2, floor=8, assumedClusterSize=10)
membership-not-admitted:below-floor (declared=3, floor=6, kEst=8)
```

`rejectReason` is part of the signed vote payload (`computeSigningPayload`, `cluster-repo.ts:694`)
and is verified as-carried by both `ClusterMember.verify...` (line ~737) and
`dispute-service.ts:678`, so a longer string round-trips fine — signer and verifier both hash the
string the record carries. Two honest members with different local config will now emit *different*
reason strings for the same record; `disputeEvidence.rejectReasons` is a per-peer map
(`cluster-coordinator.ts:356-364`), so that is fine, but confirm nothing compares reasons across
peers for equality.

## Also: state the effective policy once at construction

Log the resolved gate parameters once when a `ClusterMember` is built, so an operator diagnosing a
rejection can see what the node actually resolved:

```ts
log('cluster-member:admission-config', {
	assumedClusterSize: this.assumedClusterSize,
	minAbsoluteClusterSize: this.minAbsoluteClusterSize,
	membershipAdmissionFraction: this.membershipAdmissionFraction,
	allowUnvalidatedSmallCluster: this.allowUnvalidatedSmallCluster
});
```

Deliberately a fact at `log`, not a warning: `assumedClusterSize < clusterSize` is the normal
default state, so warning on it would fire for every node and be ignored.

## Edge cases & interactions

- **No `consensusConfig` at all** (many existing specs construct `ClusterMember` this way):
  `assumedClusterSize` is `undefined` → legacy approve preserved. `cluster-membership-admission.spec.ts:138`
  and the `cluster-repo.spec.ts` members depend on this; they must keep passing unchanged.
- **`clusterSize` set but `assumedClusterSize` absent**: the gate no longer reads `clusterSize`, so
  a declared set of 2 is now *admitted* where today it is rejected. This is the intended behavior
  change and the whole point of the split — pin it with a test so a future refactor cannot quietly
  re-couple them. `cluster-membership-admission.spec.ts:220-225` currently asserts the opposite and
  must be re-pointed at `assumedClusterSize`.
- **Degenerate `assumedClusterSize`** of `0`, `1`, or a negative: `admissionFloor` must not produce
  something below `minAbsoluteClusterSize` and must not throw. `assumedClusterSize: 1` yields floor
  `2`, so a solo node still needs `allowUnvalidatedSmallCluster` — correct, and worth a test.
- **`assumedClusterSize` larger than the cohort that actually exists**: writes are refused. That is
  the operator's own assertion being enforced, so it is correct — but it is also the original
  reported failure mode, which is why the reject message must name the value.
- **Declared set exactly at the floor** admits (`>=`, not `>`). Check both `ceil` boundaries:
  `ceil(0.75 × 8) = 6` and `ceil(0.75 × 3) = 3`.
- **Confident-but-empty derived view** (`{ peers: {}, confidence: 0.9 }`) must still route to the
  unconfident branch, as today (`cluster-repo.ts:891-894`) — now measured against
  `assumedClusterSize` rather than `clusterSize`.
- **`allowUnvalidatedSmallCluster`** still short-circuits the size gates and still does NOT bypass
  self-membership (predicate 1). Unchanged; keep both existing specs green.
- **Self-membership (predicate 1)** stays unconditional and first.
- **Signed-payload round trip**: any spec that signs a reject and re-verifies it (dispute specs,
  `cluster-repo.spec.ts`) must still pass with the longer reason string.
- **Coordinator error text**: `cluster-coordinator.ts:337` interpolates reasons into
  `Transaction rejected by validators (...)`. Check no spec asserts that message verbatim.
- **`mesh-harness.ts` and the integration meshes** set `allowUnvalidatedSmallCluster: true`
  (`src/testing/mesh-harness.ts:175,258`), so they bypass the gate entirely — they will not catch a
  regression here. Unit coverage is the only guard.
- **Out of scope, still open**: `backlog/bug-key-network-cluster-size-default-diverges` (the key
  network falls back to `16` while everything else falls back to `10`). This change removes the
  *admission* consequence of that divergence but not the divergence itself. Do not fold it in.
- **Do not touch `corroboratorCapacity`** in this ticket — that is the follow-on, sequenced next.

## Key tests

In `packages/db-p2p/test/cluster-membership-admission.spec.ts`:

- `assumedClusterSize: 2`, declared set of 2, no derivation capability → **approve**. This is the
  reported regression: today with `clusterSize: 10` it rejects.
- `assumedClusterSize: 8`, declared set of 3, low confidence → **reject**, reason matching
  `/^membership-not-admitted:low-confidence-downsize \(declared=3, floor=6, assumedClusterSize=8\)/`.
- `assumedClusterSize: 8`, declared set of **6** (`= ceil(0.75 × 8)`), low confidence → **approve**.
  New slack; today this is rejected. This is the churn/discovery-timing fix.
- `clusterSize: 10` with no `assumedClusterSize`, declared set of 2 → **approve**. Pins that the two
  settings are decoupled.
- No `consensusConfig` at all → **approve** (legacy path intact).
- `assumedClusterSize: 1` → floor is `minAbsoluteClusterSize`; a solo declared set rejects unless
  `allowUnvalidatedSmallCluster` is on.
- Existing partition/split-brain specs (lines 203-280) keep their assertions after swapping
  `clusterSize: 8` → `assumedClusterSize: 8`; the minority side must still be refused.

## TODO

- Add `assumedClusterSize?: number` to `ClusterConsensusConfig`; rewrite the `clusterSize` doc
  comment there to say it is the replication factor only and must not be used as a security yardstick.
- In `ClusterMember`: replace the `configuredClusterSize` field with `assumedClusterSize`, add the
  private `admissionFloor(k)` helper, and route both branches of `admitMembership` through it.
- Rewrite the unconfident branch per the shape above; update the `admitMembership` doc comment, which
  currently describes the removed "configured full `clusterSize`" behavior.
- Append `(declared=…, floor=…, assumedClusterSize=…)` / `(declared=…, floor=…, kEst=…)` to the two
  size reject reasons, leaving the existing prefixes intact; keep the structured `log(...)` fields.
- Add the one-shot `cluster-member:admission-config` construction log.
- Add `clusterPolicy.assumedClusterSize` to `NodeOptions`, thread it into `consensusConfig` in
  `libp2p-node-base.ts` defaulting to the `minAbsoluteClusterSize` literal already there.
- Update `packages/db-p2p/test/cluster-membership-admission.spec.ts`: swap the gate-facing
  `clusterSize:` usages to `assumedClusterSize:`, relax the exact-equality reason assertions to
  prefix/regex matches, and add the new cases above.
- Update `packages/db-p2p/docs/cluster.md` (config table around lines 700-740 and the rejection-reason
  list around line 611) and any `docs/internals.md` text describing `clusterSize` as the admission
  yardstick.
- Run `yarn build` and `yarn test` from `packages/db-p2p` and `packages/db-core`; stream output with
  `tee` rather than silent redirection.
