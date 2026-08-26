----
description: The fake multi-node network used by most tests repairs missing data with a hand-written shortcut that trusts the first machine to answer, instead of the real rule that needs several machines to agree — so no test can catch a break in that rule. Replace the shortcut with the real code.
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (makeReconcileBlock ~line 121; consensusConfig ~line 175; coordinatorRepo cfg ~line 268)
  - packages/db-p2p/src/cluster/reconcile-block.ts (createReconcileBlock — the real implementation)
  - packages/db-p2p/src/cluster/cluster-policy.ts (resolveClusterPolicy, DEFAULT_CLUSTER_SIZE, ClusterPolicyOptions)
  - packages/db-p2p/src/cluster/quorum-restore.ts (corroboratorCapacity, quorumSize, CORROBORATION_FLOOR)
  - packages/db-p2p/src/libp2p-node-base.ts:730-855, 899-910 (the production wiring this harness must mirror)
  - packages/db-p2p/src/sync/service.ts:145-190 (buildArchive — the archive shape fetchArchive must produce)
  - packages/db-p2p/src/repo/coordinator-repo.ts:995-1035, 1108-1190 (cluster-fetch:no-quorum, cluster-fetch:repair-deadlock)
  - packages/db-p2p/test/support/capture-log.ts (captureLog / hasTag / formatCaptured)
  - packages/db-p2p/test/two-node-convergence-invention-race.spec.ts (nearest existing two-node mesh spec)
  - packages/db-p2p/test/mesh-sanity.spec.ts, test/coordinator-repo-integration.spec.ts, test/byzantine-fault-injection.spec.ts, test/empty-state-contract.spec.ts, test/fresh-node-ddl.spec.ts, test/fresh-node-ddl-multi.spec.ts, test/mid-ddl-crash.spec.ts (the createMesh callers — fallout surface)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (startMockMesh — the other createMesh caller)
difficulty: hard
----

# Mesh harness: run the real block-repair path, and let a mesh declare nothing

## What is wrong

`packages/db-p2p/src/testing/mesh-harness.ts` is the only test tier that combines real storage, real
consensus, and several nodes. It is therefore the only tier that can catch a regression in the rules
deciding *whether to accept a block from another node*. It does not run those rules.

**Two defects, one code site — the mesh node assembly in `createMesh`.**

### 1. Repair uses a first-peer-wins stand-in

`makeReconcileBlock` (~line 121) walks the cohort peer list in order, takes the **first** peer whose
revision is at least the committed one, and saves its bytes. The production implementation
(`createReconcileBlock` in `src/cluster/reconcile-block.ts`) asks every cohort peer in parallel, then:

- requires a quorum of *distinct* peers to agree on the target `(rev, actionId)` (`selectQuorumRev`),
- requires a quorum to agree on the block **content** at that revision (`selectQuorumBlock`),
- declines (persisting nothing, retryable) if either vote fails,
- reports peers serving contradicting content to the reputation subsystem.

Both the commit path (`ClusterMember.reconcileBlock`) and the read path
(`CoordinatorRepo.acquireBlockFromCohort`) use the harness stand-in, so **every** mesh test involving
block repair runs first-peer-wins. A mesh test passing tells you nothing about the quorum rules, and
would keep passing if they regressed to permanently accepting *or* permanently declining.

### 2. A mesh cannot express "the operator declared no cluster size"

Phase 2 passes `clusterSize: options.clusterSize ?? nodeCount` to the coordinator factory. A caller
that omits `clusterSize` — every two-node mesh spec in the repo does — therefore gets an *honest*
declaration, and `CoordinatorRepo` resolves `repairCorroborationClusterSize` to `nodeCount`. For two
nodes that is `corroboratorCapacity(1, 2) = 1`, the corroboration floor relaxes to a single voter,
and repair always converges.

A real deployment that declares nothing resolves `repairCorroborationClusterSize` to
`DEFAULT_CLUSTER_SIZE` (10) — `corroboratorCapacity(1, 10) = 9`, floor 2, and a two-node cohort that
can **never** repair. That permanent-decline shape is documented in
`tickets/complete/1-repair-deadlock-is-never-named.md`, and the harness default silently excludes the
entire class from every mesh test.

Cost already paid: the 2026-08-13 investigation behind `secondary-index-update-never-reaches-the-sibling`
reported that "eight two-node/two-Database shapes on the mock mesh all converged" and concluded the
trigger "needs something the mock mesh lacks". All eight ran under a declared `clusterSize: 2`, so the
repair-deadlock class could not have appeared in any of them. The conclusion was sound; the coverage
claim behind it read stronger than it was.

## The invariant to land

**The mesh harness exercises the production acceptance paths, and its configuration resolves through
the same function a real node's does.** Expect existing specs to start failing. Each failure is
signal: it means that scenario was passing on a rule the production code does not have.

## Design

### Configuration: resolve through `resolveClusterPolicy`

`createMesh` currently hand-builds two config objects — a `ClusterConsensusConfig` literal for the
member and a `CoordinatorRepoConfig` literal for the coordinator — with defaults that are separate
literals from production's. Replace both with one call to `resolveClusterPolicy`
(`src/cluster/cluster-policy.ts`), exactly as `libp2p-node-base.ts` does, and hand the resolved
object to both consumers (production spreads `...consensusConfig` into the coordinator factory at
`libp2p-node-base.ts:848`; mirror that).

```ts
export interface MeshOptions {
  responsibilityK: number;
  /** Replication factor. OMITTED now means what it means in production: the operator declared
   *  nothing, so it resolves to DEFAULT_CLUSTER_SIZE (10) — NOT to nodeCount. */
  clusterSize?: number;
  /** Passed through to resolveClusterPolicy verbatim; this is how a mesh declares its real cohort
   *  size (assumedClusterSize), downsize policy, or small-cluster opt-in. */
  clusterPolicy?: ClusterPolicyOptions['clusterPolicy'];
  superMajorityThreshold?: number;   // kept: maps to clusterPolicy.superMajorityThreshold
  allowClusterDownsize?: boolean;    // kept: maps to clusterPolicy.allowDownsize
  rawStorageFactory?: (index: number) => IRawStorage;
}
```

Precedence when both the legacy top-level field and the `clusterPolicy` field are given: the explicit
`clusterPolicy` entry wins, since it is the production-shaped one. Keep the top-level fields — six
existing specs use them and churning those call sites is unrelated noise.

`allowUnvalidatedSmallCluster` keeps its current harness default of `true` in **this** ticket, but
must now be passed explicitly and visibly:
`allowUnvalidatedSmallCluster: options.clusterPolicy?.allowUnvalidatedSmallCluster ?? true`, with a
comment naming it as a gate the harness disarms and pointing at
`4-mesh-harness-admission-gate`, which flips the default to `false`. Do not silently inherit it.

Two consequences of resolving through production's function, both intended:

- `minAbsoluteClusterSize` reaches the coordinator as **2** (production's value) instead of the
  coordinator's own default of 3, which the harness currently never overrides.
- `resolveClusterPolicy` emits its one-line `repair-fault-tolerance` advisory per node under the
  `optimystic:db-p2p:cluster-policy` debug namespace. Harmless (it is off unless `DEBUG` selects it),
  but a spec using `captureLog` on that namespace will now see it.

### Repair: drive `createReconcileBlock`

Delete `makeReconcileBlock`. Build **one** `createReconcileBlock` instance per node and share it
between the member's `reconcileBlock` and the coordinator's `acquireBlockFromCohort` — production
shares one instance (`libp2p-node-base.ts:777` and `:909`) and the harness comment already claims it
does.

Ordering: the member is built in phase 1 and the coordinator in phase 2, so build the callback in
phase 1 and stash it (either on `MeshNode` or in a local `Map<string, ReconcileBlockCallback>` keyed
by peer id; a local map is enough — do not widen the public `MeshNode` type unless a spec needs it).
`nodes` is captured by reference and fully populated before either caller fires, as today.

`ReconcileBlockDeps` wiring:

| dep | harness value |
|---|---|
| `selfPeerId` | this node's `peerId.toString()` |
| `fetchArchive` | read the sibling's `StorageRepo`, build a minimal `BlockArchive` (below) |
| `saveReplicatedBlock` | `storageRepo.saveReplicatedBlock(blockId, block, source)` |
| `simpleMajorityThreshold` | resolved policy's value |
| `repairCorroborationClusterSize` | resolved policy's value |
| `reputation` | omit (no reputation subsystem in the harness) |

`fetchArchive` mirrors `SyncService.buildArchive` (`src/sync/service.ts:145-190`) — the thing the
production `fetchArchiveFromPeer` actually receives over the wire:

```ts
const fetchArchive = async (peerIdStr: string, blockId: BlockId): Promise<BlockArchive | undefined> => {
  if (peerIdStr === selfPeerId) return undefined;
  // A silent peer serves no bytes either. `undefined` is the right answer: reconcile's
  // `no-archive` outcome deliberately conflates unreachable with holds-nothing, and the
  // production fetchArchiveFromPeer swallows every dial failure into the same undefined.
  if (failures.silentPeers?.has(peerIdStr)) return undefined;
  const target = nodes.find(n => n.peerId.toString() === peerIdStr);
  if (!target) return undefined;
  const result = await target.storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as any);
  const entry = result[blockId];
  const latest = entry?.state?.latest;
  if (!latest || !entry?.block) return undefined;
  return {
    blockId,
    revisions: { [latest.rev]: { action: { actionId: latest.actionId, transform: { insert: entry.block } }, block: entry.block } },
    range: [latest.rev, latest.rev + 1]
  };
};
```

`createReconcileBlock` reads only `revisions[rev].action.actionId` and `revisions[rev].block`, so the
`transform` field is filler for the type — but produce it the way the sync service does rather than
inventing a shape, so the two cannot drift.

`failures.failingPeers` stays a write-path (cluster update) concept; do not consult it here.

## Fallout: triage, do not paper over

Both changes make repair strictly harder. The two shapes to expect:

1. **A repair that used to converge on one sibling now declines.** With a declared `clusterSize: N`,
   `corroboratorCapacity(cohortPeers, N)` is `max(cohortPeers, N-1)`; the quorum floor is
   `min(2, capacity)`. A three-node full-replication mesh where only ONE sibling holds the block now
   needs a second holder.
2. **A mesh that declared no `clusterSize` now resolves 10** and can no longer repair at small
   cohorts at all.

For each failing spec, decide — and write the decision into the spec as a comment:

- The scenario was always supposed to succeed and the mesh genuinely is that size → declare it
  (`clusterSize: <nodeCount>` or `clusterPolicy: { assumedClusterSize: <nodeCount> }`).
- The scenario was passing only because a lone peer's word was enough → the new decline is correct;
  change the assertion to the honest outcome and say why.

**Do not `skip`, `only`, comment out, or loosen an assertion to get a green run.** If a failure is
plainly unrelated to this diff, follow the pre-existing-failure procedure in the stage rules.

`packages/quereus-plugin-optimystic/test/mesh-node-harness.ts` (`startMockMesh`) already passes
`clusterSize: size` explicitly, so its specs should be unaffected — confirm rather than assume, and
run that package's tests too.

## Tests

New spec, `packages/db-p2p/test/mesh-reconcile-quorum.spec.ts` (name it for the behaviour, not for
this ticket):

- **Two nodes converge end-to-end under a declared size.** `createMesh(2, { responsibilityK: 2,
  clusterSize: 2 })`. Node A commits a block; node B reads it and ends up holding the same content at
  the same revision. Expected: converges — `repairCorroborationClusterSize` is 2, capacity is
  `max(1, 1) = 1`, floor relaxes to one voter, so a single sibling is enough. This is currently
  covered only by unit tests of `createReconcileBlock` and by an integration scenario in a sibling
  repository that cannot be run from here.
- **Undeclared two-node mesh can never repair (the Arm D shape).** `createMesh(2, {
  responsibilityK: 2 })` — nothing declared. Node A holds a newer revision; node B reads. Expected,
  under `captureLog('coordinator-repo', …)`: `cluster-fetch:no-quorum` on **every** read pass, and
  exactly **one** `cluster-fetch:repair-deadlock` carrying `reason: 'cohort-too-small'`. The
  arithmetic that makes this exact: `repairCorroborationClusterSize = 10`,
  `corroboratorCapacity(1, 10) = 9`, `quorumSize(1, 0.51, 9) = 2`, and `cohortPeers (1) < 2` is the
  `cohortTooSmall` test in `CoordinatorRepo.reportRepairDeadlock`. Assert the deadlock line appears
  once across repeated reads, not once per read.
- **A lone peer's inflated revision does not steer repair.** Three nodes, all cohort members, one
  claiming a higher `(rev, actionId)` than the other two agree on. Expected: repair adopts the
  corroborated pair, never the outlier's.
- **A cohort split on content declines rather than picking a side.** Two carriers at the same
  `(rev, actionId)` serving different block bytes, with a capacity that demands agreement. Expected:
  `reconcile:no-content-quorum`, nothing persisted, and a later pass can still succeed.

## Edge cases & interactions

- **Self exclusion.** `createReconcileBlock` filters `selfPeerId` out of `cohortPeerIds` and returns
  immediately when nothing remains. Confirm a solo mesh (`createMesh(1, …)`) still commits and reads
  — `test/mesh-sanity.spec.ts` and `test/empty-state-contract.spec.ts` both build one.
- **The block the cohort genuinely does not have.** Every peer answers `undefined`. Reconcile must
  decline quietly with no throw; the read path must still return `{ state: {} }` rather than hanging
  (`test/empty-state-contract.spec.ts` asserts exactly that today).
- **Silent peers.** `failures.silentPeers` must suppress the archive fetch as well as the
  latest-revision consult, or a test that silences a peer can converge *through* it. Note the
  asymmetry the code already documents: on the read path a silence REJECTS (the coordinator must
  count "did not answer" separately from "holds nothing"), while `fetchArchive` returns `undefined`
  — the same conflation `libp2p-node-base.fetchArchiveFromPeer` makes.
- **Shared callback identity.** The member and the coordinator must get the *same* instance. A spec
  should not be able to tell them apart; if one path repairs and the other does not, the wiring
  regressed.
- **Concurrent repair on one block.** Two reads of the same missing block can drive two reconcile
  passes at once, both landing in `saveReplicatedBlock`. That funnel is monotonic, so the outcome must
  be one revision, not a torn state — assert the final revision rather than a call count.
- **Repair of a revision the node already has, or has newer.** `toCandidate` drops archives whose
  highest revision is below the committed one; a peer that is *behind* must count as `behind`, not as
  a holder, so it cannot pad the responder count into a quorum.
- **`rawStorageFactory` meshes.** `test/mid-ddl-crash.spec.ts` wraps storage with a crashing proxy. A
  `fetchArchive` that throws is caught by `fetchAnswer` and costs only that peer's vote — verify a
  crashing sibling degrades one vote rather than failing the whole pass.
- **Coordinator `minAbsoluteClusterSize` moving 3 → 2.** This changes what the coordinator's
  small-cluster validation admits. It is the production value and therefore correct, but it is a
  behaviour change to a path `allowUnvalidatedSmallCluster: true` partly masks — call it out in the
  handoff if any spec moves because of it.
- **`resolveClusterPolicy` runs per node, not per mesh.** Calling it once per `createMesh` and
  sharing the result is fine and cheaper; if you call it per node, its advisory log fires N times.
- **Interaction with `4-mesh-harness-admission-gate` and `5-mesh-harness-signature-enforcement`.**
  Both build on this ticket's node-assembly refactor. Leave the assembly readable: one resolved
  policy object, one place per node where the member's components are built, one place where the
  coordinator's are.

## TODO

### Phase 1 — configuration

- Add `clusterPolicy` to `MeshOptions`; keep `clusterSize`, `superMajorityThreshold`,
  `allowClusterDownsize` and map them onto the policy input, explicit entry winning.
- Replace both hand-built config literals in `createMesh` with one `resolveClusterPolicy` call;
  spread the resolved object into `coordinatorRepo(...)` the way `libp2p-node-base.ts:848` does.
- Change the coordinator's `clusterSize` from `options.clusterSize ?? nodeCount` to whatever the
  resolved policy says (i.e. `DEFAULT_CLUSTER_SIZE` when undeclared). Document the change in the
  `MeshOptions.clusterSize` doc comment — an omitted value is now a statement, not a convenience.
- Pass `allowUnvalidatedSmallCluster` explicitly with a comment naming it as a disarmed gate and
  pointing at the follow-up ticket.

### Phase 2 — real reconcile

- Add the `fetchArchive` helper mirroring `SyncService.buildArchive`, honouring `silentPeers`.
- Build one `createReconcileBlock` per node in phase 1; reuse the same instance for the member's
  `reconcileBlock` and the coordinator's `acquireBlockFromCohort`.
- Delete `makeReconcileBlock` and its doc comment.

### Phase 3 — fallout and coverage

- Run `yarn workspace @optimystic/db-p2p test` in the foreground (no redirection) and triage every
  failure per the rules above; record each decision as a comment in the spec that moved.
- Run the Quereus plugin's tests too — `startMockMesh` is a `createMesh` caller.
- Add `test/mesh-reconcile-quorum.spec.ts` with the four cases above.
- Typecheck the workspace; `MeshOptions` is exported through `src/testing/index.ts`, so a signature
  change is public to the plugin package.
- Write the `review/` handoff: which specs moved and why, which gate is still disarmed
  (`allowUnvalidatedSmallCluster`) and which ticket arms it.
