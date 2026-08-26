----
description: A safety check that stops a small group of cut-off machines from voting themselves into control of shared data is switched off in the fake test network, so no test proves it works when routing, network-size confidence, and voting all interact. Turn it on and test a real split.
prereq: mesh-harness-real-reconcile
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (createMesh node assembly; MockMeshKeyNetwork; MeshFailureConfig)
  - packages/db-p2p/src/cluster/cluster-repo.ts:975-1125 (admitMembership, admissionFloor, deriveExpectedClusterView, MEMBERSHIP_NOT_ADMITTED)
  - packages/db-p2p/src/cluster/cluster-repo.ts:118-140 (ExpectedClusterView, DeriveExpectedClusterCallback)
  - packages/db-p2p/src/libp2p-node-base.ts:791-818 (the production deriveExpectedCluster this must mirror)
  - packages/db-p2p/src/cluster/cluster-policy.ts (assumedClusterSize, allowUnvalidatedSmallCluster)
  - packages/db-p2p/test/cluster-membership-admission.spec.ts (member-layer split-brain test — the floor this builds above)
  - packages/db-p2p/test/support/capture-log.ts
  - docs/correctness.md (Theorem 2 — the property this gate implements)
difficulty: hard
----

# Mesh harness: arm the membership admission gate and drive a real partition

## What is wrong

The membership admission gate makes each cluster member independently re-derive its own view of a
block's responsible peer set and refuse to sign an `approve` inside a set it cannot admit. It is the
defence that stops a minority partition from voting a self-shrunk cluster into super-majority
(`docs/correctness.md`, Theorem 2).

The mesh harness disables it **twice over**:

1. It sets `allowUnvalidatedSmallCluster: true`, the documented escape hatch. `admitMembership`
   returns `{ admit: true }` immediately after the self-membership check, skipping the size and
   consistency predicates entirely (`cluster-repo.ts:988`).
2. It wires no `deriveExpectedCluster` callback. Even with the hatch closed, every member would take
   the "cannot measure the cohort" path, where the gate needs an `assumedClusterSize` to have any
   size reference at all. With neither, `admitMembership` returns `{ admit: true }` again
   (`cluster-repo.ts:1007`) — so a test written against the harness would pass without exercising
   anything.

Existing coverage is real but stops at the member layer: `test/cluster-membership-admission.spec.ts`
has a `split-brain prevention` case that configures two members independently — one majority-side
confident, one minority-side low-confidence — and asserts the asymmetry of their *decisions*. Nothing
runs a mesh where routing, a key network returning genuinely shrunk cluster views, and confidence
that collapses under a simulated partition drive the outcome together.

## Design

### Harness options

```ts
export interface MeshOptions {
  // ...existing (see 3-mesh-harness-real-reconcile)
  /**
   * Per-node member-side cluster derivation for the membership admission gate — the harness
   * analogue of libp2p-node-base's deriveExpectedCluster (findCluster + FRET confidence).
   * Omitted → each member gets the production-shaped derivation over the mesh key network with
   * confidence 1 (see meshConfidence below).
   */
  deriveExpectedCluster?: (node: MeshNode, blockId: BlockId) => Promise<ExpectedClusterView>;
  /** Per-node network-size confidence (0..1), the FRET stand-in. Default 1. */
  meshConfidence?: (node: MeshNode) => number;
}
```

Default derivation, mirroring `libp2p-node-base.ts:791-805` — same source (`IKeyNetwork.findCluster`)
the coordinator selects the cohort from, plus a confidence number:

```ts
const deriveExpectedCluster: DeriveExpectedClusterCallback = async (blockId) => ({
  peers: await nodeKeyNetwork.findCluster(new TextEncoder().encode(blockId)) ?? {},
  confidence: options.meshConfidence?.(node) ?? 1
});
```

Note this uses the **per-node** `nodeKeyNetwork` (the self-including wrapper already built in phase
2), not the raw mesh key network, so a responsible member always sees at least itself — matching
production and avoiding the empty-view guard at `cluster-repo.ts:993`.

The derivation is needed by the member (phase 1) but the key network is built in phase 2. Resolve by
building the per-node key network before the members, or by giving each member a late-bound closure
that reads a `nodes[i].keyNetwork` slot filled in phase 2. Prefer moving key-network construction
earlier — a late-bound closure that fires before the slot is filled is a landmine for the next
author.

### The gate must default to armed

`allowUnvalidatedSmallCluster` flips from `?? true` to `?? false`, matching `resolveClusterPolicy`.
A mesh that wants it off must say so:

```ts
createMesh(1, { responsibilityK: 1, clusterPolicy: { allowUnvalidatedSmallCluster: true } })
```

That is the point of the ticket: a disarmed gate has to be visible at the call site so the next test
author cannot inherit one silently. Solo and two-node meshes in the existing specs are the expected
users of the opt-in — set it explicitly on each, with a one-line comment saying why that mesh runs
undersized. Do not add a blanket harness-wide default that re-hides it.

### Partition simulation

`MeshFailureConfig` gains a way to make the key network return shrunken cluster views:

```ts
/**
 * Simulated network partition: each entry is one side of the split, as a set of peer-id strings.
 * While set, findCluster answers a caller on side S with only the members of S that would otherwise
 * be in the cohort — an UNAUTHENTICATED shrunken view, exactly what the admission gate exists to
 * refuse. Callers not in any listed side see the unpartitioned cohort.
 */
partitionSides?: Set<string>[];
```

`MockMeshKeyNetwork.findCluster` needs to know **who is asking** to answer per-side. Today it does
not take a caller. Thread the asking peer id through the per-node wrapper (`nodeKeyNetwork`) rather
than changing the `IKeyNetwork` interface — the wrapper already exists per node and already mutates
the result to include self, so filtering it by the asking node's side is a natural extension and
keeps `IKeyNetwork` untouched.

The coordinator on the minority side then declares a shrunk peer set; minority-side members derive
the same shrunk view but with **low confidence**, so they take the fail-closed branch.

## Tests

New spec, `packages/db-p2p/test/mesh-partition-admission.spec.ts`:

- **Minority side refuses admission.** A 5-node mesh, `responsibilityK: 5`, declared
  `clusterPolicy: { assumedClusterSize: 5 }`. Partition into a 3-node majority and a 2-node minority.
  Minority-side `meshConfidence` returns `0.2` (below the gate's `MembershipConfidenceThreshold`);
  majority-side returns `1`. A minority-side node coordinates a write.
  Expected: minority-side members reject with a reason beginning
  `membership-not-admitted:low-confidence-downsize`, no super-majority is reached, and the write
  fails rather than committing. Assert on the `cluster-member:admission-reject` log via `captureLog`
  **and** on the write's outcome — a log-only assertion would pass if the gate rejected but the
  coordinator committed anyway.
- **Majority side behaves per the threshold.** Same mesh, write coordinated from the majority side.
  Expected: majority members admit (their derived view is confident and the declared set is within
  tolerance of it), and the write either commits or — if 3 of 5 does not clear the configured
  super-majority — fails for a *quorum* reason, never a `membership-not-admitted` one. Assert
  whichever the arithmetic gives at the threshold the spec configures, and state the arithmetic in a
  comment so a later threshold change does not silently invert the test.
- **Neither side commits at the default 75% threshold.** A 3/2 split of 5 cannot reach 0.75 on either
  side. Assert that too — it is the property Theorem 2 actually claims, and it is the case an
  operator would be surprised by.
- **`self-not-member` is enforced even with the hatch open.** Route a record to a node the declared
  peer set excludes, under `allowUnvalidatedSmallCluster: true`. Expected: still rejected with
  `membership-not-admitted:self-not-member`. This pins the one predicate the escape hatch does not
  disable (`cluster-repo.ts:981`).
- **Unpartitioned control.** The same mesh with no partition and confidence 1 admits and commits.
  Without this, a bug that made the gate reject everything would look like a passing partition test.

## Edge cases & interactions

- **The empty derived view.** `admitMembership` treats `kEst === 0` as not-confident on purpose
  (measured against an empty set, every non-empty declared set is "inconsistent"). Use the
  self-including per-node key network so this is not hit accidentally; a spec that *wants* to hit it
  should say so explicitly.
- **The tolerance predicate, not just the floor.** `|D △ E| ≤ ceil(clusterSizeTolerance · |E|)` at a
  default tolerance of 0.5 absorbs churn of a peer or two. A partition test whose split is small
  enough to sit inside tolerance proves nothing — pick a split that clears it, and say in a comment
  which predicate each case is aimed at (`below-floor` vs `inconsistent-with-derived-view` vs
  `low-confidence-downsize`).
- **Confidence exactly at the threshold.** The check is `confidence > MembershipConfidenceThreshold`,
  strictly greater. A spec using the threshold value itself lands on the fail-closed side; do not
  write a test that depends on which side of `==` the code falls without asserting it deliberately.
- **`assumedClusterSize` on the fallback path.** Without it, a low-confidence member admits
  everything (`cluster-repo.ts:1007`). Every partition spec must declare it, or the test is vacuous.
  Consider a harness-level assertion or a comment that makes the omission loud.
- **A derivation that throws.** `deriveExpectedClusterView` catches and returns `undefined` ⇒ not
  confident. Cover it: a node whose derivation throws must fall to the fail-closed branch, not admit.
- **Existing specs flipping to armed.** Every current `createMesh` caller inherits
  `allowUnvalidatedSmallCluster: false` after this change. Small meshes (1–2 nodes) are the likely
  movers, in the coordinator's small-cluster validation as well as the member's gate. Triage each per
  the rules in `3-mesh-harness-real-reconcile`: opt the mesh in explicitly with a reason, or accept
  the new outcome as correct. No skipping, no loosened assertions.
- **The plugin's `startMockMesh`.** `packages/quereus-plugin-optimystic/test/mesh-node-harness.ts`
  builds meshes of 2 with `clusterSize: size`. Arming the gate there may need
  `clusterPolicy: { assumedClusterSize: size }` or an explicit opt-in — decide once, in that helper,
  with a comment, so its several specs do not each answer it differently.
- **Interaction with repair (ticket 3).** A partitioned mesh also shrinks the cohort the repair path
  sees. A partition spec that reads a block may trip `cluster-fetch:no-quorum` as a side effect;
  assert on the admission signal specifically rather than on "the read failed".
- **Reason-string stability.** The reject reasons carry local numbers
  (`declared=…, floor=…, assumedClusterSize=…`). Assert on the `membership-not-admitted:<variant>`
  prefix, never on the whole string — `cluster-repo.ts` says so explicitly.

## TODO

- Move per-node key-network construction ahead of member construction so `deriveExpectedCluster` can
  be built in phase 1 without a late-bound slot.
- Add `deriveExpectedCluster` and `meshConfidence` to `MeshOptions`; default the derivation to the
  production shape (per-node `findCluster` + confidence 1).
- Wire `deriveExpectedCluster` into `clusterMember({ … })`.
- Flip `allowUnvalidatedSmallCluster` to default `false`; set it explicitly, with a per-mesh reason,
  on the existing specs that genuinely need it.
- Add `partitionSides` to `MeshFailureConfig` and honour it in the per-node key-network wrapper
  (caller-aware), leaving `IKeyNetwork` unchanged.
- Add `test/mesh-partition-admission.spec.ts` with the five cases above.
- Run `yarn workspace @optimystic/db-p2p test` in the foreground and triage fallout; run the Quereus
  plugin tests as well.
- Handoff: list which meshes now opt out of the gate and why, and whether any existing spec's meaning
  changed.
