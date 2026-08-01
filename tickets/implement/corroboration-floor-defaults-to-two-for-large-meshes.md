----
description: When a node repairs a damaged copy of data it asks other peers to agree before trusting what they send, and out of the box it now settles for a single peer's word — so anything that makes the peer group look smaller than it really is can push bad data onto a node that was never configured otherwise. Give the repair check its own default so it stops trusting one voice on an unconfigured deployment.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, docs/transactions.md, docs/internals.md
difficulty: medium
repro: verified
----

# Give the repair corroboration floor its own size yardstick

## The defect, in one sentence

`packages/db-p2p/src/libp2p-node-base.ts:754` resolves `assumedClusterSize` to `2` when the operator
sets nothing, and both block-repair paths measure their "how many peers must agree" floor against
that number — so on any unconfigured node a peer-group view shrunk to one peer relaxes the floor to
a single, uncorroborated voter.

## Reproduced

A scratch spec (since deleted) built a `CoordinatorRepo` with the exact config literal
`createLibp2pNodeBase` produces for default options — `{ clusterSize: 10, assumedClusterSize: 2, … }`
— gave it a peer view of self + one other peer, and had that one peer claim a higher revision than
the local copy. The repair fired and adopted the lone claim. With `assumedClusterSize` left unset
(the fallback `CoordinatorRepo` already implements) the same scenario declines, logging
`cluster-fetch:no-quorum`. So the regression is purely in what the composition root hands down, not
in the corroboration logic itself.

The arithmetic behind it: `corroboratorCapacity(visiblePeers = 1, yardstick = 2) = max(1, 1) = 1`,
and `quorumSize` caps its floor of two at that capacity → floor 1 → one voter carries the claim.
With yardstick 10 the capacity is `max(1, 9) = 9`, the floor stays 2, and a lone claim is refused.

## Root cause

One config field, `assumedClusterSize`, feeds two consumers whose failure modes are opposites:

| Consumer | When it reads the field | Cost of a value that is too small | Cost of one too large |
|---|---|---|---|
| Membership admission gate (`cluster/cluster-repo.ts`, `admitMembership`) | only on its fallback path, when the node has no confident network-size estimate | a partition-induced downsize slips past while the node is unconfident | node refuses legitimate writes — unavailability |
| Repair corroboration floor (`quorum-restore.corroboratorCapacity`, called by `CoordinatorRepo.queryClusterForLatest` and `createReconcileBlock`) | **every repair, unconditionally** | a shrunken view buys a lone peer full trust | a block stays unrepaired — degraded, not dead |

The admission gate wants a permissive default (an unconfigured two-node mesh must be able to
transact); the corroboration floor wants a strict one (its downside is only a deferred repair). The
previous ticket `split-admission-floor-from-replication-factor` set the shared default to `2` for the
gate's sake, and the floor inherited it.

`CoordinatorRepo` already contains the correct fallback for the floor —
`this.assumedClusterSize = policy.assumedClusterSize ?? policy.clusterSize`
(`repo/coordinator-repo.ts:207`) — but it is unreachable from a real node, because the composition
root fills the field in before handing it over.

## The fix: two resolved values, one operator-facing field

Keep exactly one knob for operators (`clusterPolicy.assumedClusterSize`). At the composition root,
resolve it into **two** values and hand each consumer the one it needs:

```
declared = options.clusterPolicy?.assumedClusterSize          // undefined = "operator said nothing"

consensusConfig.assumedClusterSize      = declared ?? minAbsoluteClusterSize (2)   // admission gate — unchanged
repairCorroborationClusterSize          = declared ?? consensusConfig.clusterSize  // repair floor — new
```

Both repair paths (read-repair and commit-path reconcile) must receive the *same*
`repairCorroborationClusterSize`, exactly as they share `assumedClusterSize` today — the existing
NOTE at `libp2p-node-base.ts:786` about keeping them coupled still applies verbatim.

**Why a distinct name rather than overloading `assumedClusterSize` in the `CoordinatorRepo` config.**
That config object is also what builds `ClusterCoordinator`; a field whose value silently differs
from the member's copy of the same field is a trap for the next reader. `ClusterCoordinator` happens
to ignore `assumedClusterSize` today, so overloading would work — which is precisely why it would go
unnoticed when that stops being true.

### What this changes for operators

- **Unconfigured deployment of any size** — yardstick becomes `clusterSize` (default 10), so the
  floor of two corroborators binds again and a shrunken view gains nothing. This is the
  pre-regression behavior.
- **Genuine two-node mesh** — needs one setting to self-repair: either `clusterPolicy.assumedClusterSize: 2`
  (an explicit declaration, which does **not** lower the replication factor), or an honest
  `clusterSize: 2`, which the existing `?? clusterSize` fallback already handles. The previous ticket
  wanted small meshes to work with zero configuration; this reintroduces one setting for the *repair*
  path only — writes and voting still work unconfigured. That is the deliberate trade, and it is
  narrower than the pre-regression state.
- **`mesh-harness`** (`src/testing/mesh-harness.ts:249`) passes `clusterSize: nodeCount` and no
  `assumedClusterSize`, so it lands on the fallback and keeps working unchanged. Verify, don't assume.

### Making it testable — the reason the regression went unnoticed

The config literal lives inline inside `createLibp2pNodeBase`, so nothing can assert on it without
booting a real libp2p node. Extract the resolution into a pure, exported function in a new module
(no name clash today: `src/cluster/cluster-policy.ts`):

```ts
/** Everything the two size yardsticks are derived from. */
export interface ClusterPolicyOptions {
	clusterSize?: number;
	clusterPolicy?: {
		allowDownsize?: boolean;
		sizeTolerance?: number;
		superMajorityThreshold?: number;
		allowUnvalidatedSmallCluster?: boolean;
		assumedClusterSize?: number;
	};
}

export type ResolvedClusterPolicy = ClusterConsensusConfig & {
	clusterSize: number;
	/**
	 * Yardstick the repair corroboration floor measures a (possibly shrunken, always unauthenticated)
	 * cohort view against. Distinct from `assumedClusterSize` — see the module doc.
	 */
	repairCorroborationClusterSize: number;
};

export function resolveClusterPolicy(options: ClusterPolicyOptions): ResolvedClusterPolicy;
```

`createLibp2pNodeBase` then calls it instead of building the literal, and a unit test asserts both
numbers for the default-options case — the layer the real node actually uses, which no test reached.

### Consumer-side changes

- `CoordinatorRepo`: widen the `cfg` type to
  `Partial<ClusterConsensusConfig> & { clusterSize?: number; repairCorroborationClusterSize?: number }`
  and resolve `cfg?.repairCorroborationClusterSize ?? cfg?.assumedClusterSize ?? clusterSize`. Rename
  the private field from `assumedClusterSize` to `repairCorroborationClusterSize` so the call site at
  line 599 reads honestly. Keeping the `?? assumedClusterSize` middle term preserves behavior for
  direct constructors (existing tests, embedders).
- `createReconcileBlock`: rename the required dep `assumedClusterSize` →
  `repairCorroborationClusterSize` (same meaning, honest name) and update its jsdoc; it is an internal
  interface with two call sites (`libp2p-node-base.ts:790`, plus tests).
- `corroboratorCapacity(cohortPeerCount, assumedClusterSize)` in `quorum-restore.ts`: rename the second
  parameter to match, and **delete the caveat paragraph at lines 81–86** — it exists only to document
  this bug, and it names this ticket slug. Grep for the slug afterwards; `packages/db-p2p/dist/` also
  carries a stale copy that will be regenerated by the build.

### Deliberately out of scope

- **A construction-time warning when `clusterSize` far exceeds `assumedClusterSize`.** Once the two
  yardsticks are separate, the surprising configuration is gone: an operator only reaches the relaxed
  branch by explicitly declaring it. `ClusterMember` already logs the resolved pair as a fact
  (`cluster/cluster-repo.ts:266-269`).
- **Deriving the yardstick from observation** (largest peer group this node has ever seen for the key)
  — that removes the trade entirely and is already filed as
  `backlog/feat-admission-floor-from-observed-cohort-high-water-mark`. It should subsume both
  yardsticks when it lands; leave a pointer at `resolveClusterPolicy`, don't build it here.
- **`backlog/bug-key-network-cluster-size-default-diverges`** (peer selection defaults to 16 while
  consensus assumes 10). Independent, and this fix makes `clusterSize` matter slightly more; the
  divergence direction is harmless for the floor (real cohorts are *larger* than the yardstick, so the
  floor binds harder, not softer). Cross-reference only — not a prerequisite.

## Tests

Two must not both be able to pass silently:

- `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` — a new sibling of
  `'does not relax the floor when a LARGER configured cluster merely looks small'` (line 525) that
  builds its config from `resolveClusterPolicy({})` rather than a hand-written literal, shrinks the
  peer view to one peer, and asserts `cluster-fetch:no-quorum`. This is the case that fails on `main`
  today. Keep the existing test (it pins the direct-constructor fallback) and the healing test at
  line 548 (`assumedClusterSize: 2` still repairs).
- A new spec for `resolveClusterPolicy` (suggest `test/cluster-policy.spec.ts`) pinning, for
  `resolveClusterPolicy({})`: `assumedClusterSize === 2` (admission-gate default preserved — the
  previous ticket's intent) **and** `repairCorroborationClusterSize === 10`; plus that an explicit
  `clusterPolicy.assumedClusterSize` sets both, and that `clusterSize` alone moves only the repair
  yardstick.
- `packages/db-p2p/test/reconcile-block.spec.ts` — the commit-path mirror: with the node-resolved
  yardstick and a cohort list of one peer, a lone peer's claim must not be reconciled in.

## Docs to revise once behavior changes

These currently describe the shipped (buggy) behavior on purpose and will be wrong after the fix:

- `packages/db-p2p/src/cluster/quorum-restore.ts` — the `corroboratorCapacity` caveat (lines 81–86).
- `packages/db-p2p/src/libp2p-node-base.ts` — `clusterSize` jsdoc (~177–185),
  `clusterPolicy.assumedClusterSize` jsdoc (~197–207), and the `consensusConfig` comment (~744–754).
- `packages/db-p2p/src/cluster/reconcile-block.ts` — the dep jsdoc (~40–49).
- `packages/db-p2p/src/repo/coordinator-repo.ts` — the field jsdoc (~147–152) and the fallback comment
  (~202–207), which stop describing dead code.
- `docs/transactions.md` (~509) and `docs/internals.md` (~311–320) — both state the yardstick is
  `assumedClusterSize` and warn about its small default.
- `docs/correctness.md` (~112, ~456, ~465) discusses `assumedClusterSize` for the **admission gate**,
  which this ticket does not change — re-read before editing rather than pattern-matching the field
  name.

## TODO

Phase 1 — extract and split the resolution

- Add `packages/db-p2p/src/cluster/cluster-policy.ts` with `ClusterPolicyOptions`,
  `ResolvedClusterPolicy`, and `resolveClusterPolicy`, carrying the module doc that explains why two
  yardsticks exist and which consumer reads which.
- Move the `consensusConfig` literal (`libp2p-node-base.ts:734-755`) into it verbatim, including the
  `minAbsoluteClusterSize = 2` constant and its "must not drift" note; have `createLibp2pNodeBase`
  call `resolveClusterPolicy(options)`.
- Export it from the package's public surface only if a test outside `db-p2p` needs it; otherwise keep
  it internal.

Phase 2 — thread the new yardstick to both repair paths

- `CoordinatorRepo`: widen `cfg`, add the `repairCorroborationClusterSize` term ahead of the existing
  fallback chain, rename the private field and its jsdoc, update the call site (line 599).
- `createReconcileBlock`: rename the dep and its jsdoc.
- `corroboratorCapacity`: rename the second parameter; delete the caveat paragraph naming this ticket.
- `libp2p-node-base`: pass `repairCorroborationClusterSize` to both `createReconcileBlock` (line ~790)
  and the `coordinatorRepo` cfg (line ~840); keep/refresh the coupling NOTE so it names the new field.
- Check `packages/reference-peer/src/cli.ts` (it plumbs `--cluster-size` / assumed size) and
  `src/testing/mesh-harness.ts` still resolve sensibly; adjust only if a small mesh loses self-repair.

Phase 3 — tests

- New `test/cluster-policy.spec.ts` for the resolver defaults.
- New shrunken-view case in `test/coordinator-repo-read-repair.spec.ts` built from
  `resolveClusterPolicy({})`; confirm it fails before Phase 2 and passes after.
- New commit-path case in `test/reconcile-block.spec.ts`.
- Run `yarn test` in `packages/db-p2p` streaming to a log (`2>&1 | tee /tmp/db-p2p.log | tail -60`);
  the suite is long, so do not redirect silently. Also run the type check for the package.

Phase 4 — docs

- Update every site in "Docs to revise" to describe the shipped behavior, and grep for
  `corroboration-floor-defaults-to-two-for-large-meshes` to confirm no source reference survives.
