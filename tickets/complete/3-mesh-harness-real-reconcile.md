description: The fake multi-node network used by most tests now repairs missing data using the real "several machines must agree" rule instead of trusting the first machine that answers, so tests can no longer pass on evidence a real deployment would reject.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-p2p/test/mesh-reconcile-quorum.spec.ts
  - packages/db-p2p/src/storage/block-archive.ts (added during review)
  - packages/db-p2p/src/sync/service.ts (buildArchive delegates, review)
  - packages/db-p2p/test/reconcile-block.spec.ts (stand-in delegates, review)
  - packages/db-p2p/src/index.ts
difficulty: medium
---

# Mesh harness runs real reconcile — complete

## What shipped

`createMesh`, the in-process fake network almost every `db-p2p` test runs on, used to hand a node
missing a block a stand-in repair function that asked peers one at a time and believed the first one
that answered. Production does not do that: it asks the cohort and adopts a revision only when
enough *distinct* peers agree both on which revision is current and on the block's contents. Every
test that exercised repair was therefore passing on evidence a real deployment would reject.

The harness now builds the real `createReconcileBlock` and resolves its thresholds through the same
`resolveClusterPolicy` call a real node's startup uses, so a mesh's repair behaviour is decided by
production code and production defaults.

Three substantive shifts, all preserved through review:

- **Policy comes from the production resolver.** Two hand-written config literals are gone. An
  omitted `clusterSize` now resolves to `DEFAULT_CLUSTER_SIZE` (10) where it used to silently become
  `nodeCount`, and the coordinator's `minAbsoluteClusterSize` moves 3 → 2 (production's value). For
  any cohort giving the reader two or more peers this changes nothing; it changes exactly one shape,
  the undeclared two-node mesh, which now declines permanently — the honest outcome.
- **One reconcile instance per node, shared by the commit path and the read path,** as in production.
- **A real archive fetch** replaces the stand-in.

`MeshOptions` gained `clusterPolicy?:`; the legacy top-level `superMajorityThreshold` /
`allowClusterDownsize` shorthands still work, with an explicit `clusterPolicy` entry winning.

Four new cases in `mesh-reconcile-quorum.spec.ts` pin the arithmetic: a declared two-node mesh
converging, an undeclared one declining permanently with `cohort-too-small`, a lone inflated-revision
outlier failing to steer repair, and a cohort split on content declining rather than picking a side.

## Review findings

### Checked

The implement diff (`8822ab8`, `7e7e0ba`) read before the handoff summary. Verified against the
production composition root (`libp2p-node-base.ts`) line by line; re-derived every quorum number the
new spec asserts from `quorum-restore.ts` (`corroboratorCapacity`, `quorumSize`, `CORROBORATION_FLOOR`)
rather than trusting the spec comments — all four cases' arithmetic is correct. Traced the widened
config through both consumers (`ClusterCoordinator`, `ClusterMember.admitMembership`) to confirm the
`clusterSize` 10-vs-`nodeCount` and `minAbsoluteClusterSize` 3-vs-2 changes are inert on the write
path: `allowClusterDownsize` defaults true, so the two sites that read `clusterSize` are a log line
and an unreachable branch. Confirmed the claim that undeclared three-node meshes are unaffected —
capacity caps the *floor* only, so a two-responder cohort demands two votes at both the old and new
yardstick. Checked the block-aliasing risk between mesh nodes and found none: `MemoryRawStorage`
crosses a byte boundary on every read, so the spec's `deep.equal` between two nodes' copies is a real
assertion. Read every doc mentioning reconcile, read-repair, or a mesh harness; none describes
`src/testing/mesh-harness.ts`, so nothing was stale.

Lint clean. `tsc --noEmit` clean for db-p2p. Suites: db-p2p **1931 passing, 44 pending, 0 failing**
(baseline before review edits, and identical after); `@optimystic/quereus-plugin-optimystic`
**656 passing, 13 pending, 0 failing** after rebuilding db-p2p (the plugin resolves
`@optimystic/db-p2p/testing` through `dist/`, so the rebuild is required — as the handoff warned);
plugin smoke `smoke ok quereus@4.17.1`. Integration specs self-skip without `OPTIMYSTIC_INTEGRATION=1`
and were not run; they are part of the 44 pending. No pre-existing failure surfaced, so no
`.pre-existing-error.md` was written.

### Found and fixed in this pass

**The harness diverged from production on the case it claimed to mirror, and two other copies of the
same shape had already drifted.** The new `makeFetchArchive` was a hand-copy of
`SyncService.buildArchive` with a comment asserting "the two cannot drift" — a claim nothing enforced,
and already false. Production serves an archive whose `block` is absent when the repo holds a revision
it cannot materialize (a deleted block — `GetBlockResult.block` is documented as undefined for one);
the harness bailed out and served **no archive at all** for that same repo state. Downstream that is
not a cosmetic difference: `createReconcileBlock` counts an archive-with-no-block as a peer *voting*
on `(rev, actionId)` and abstaining from the content quorum, but no-archive as a peer that holds
nothing. So the harness turned a legitimate corroborating voter into a phantom non-holder, and a
decline production would report as `no-content-quorum` came out as `no-rev-quorum`. A third copy in
`reconcile-block.spec.ts` carried a third shape again (an extra `rev` field), also captioned "mirrors
`SyncService.buildArchive`".

Rather than patch the instance, the shape is now one function. New
`packages/db-p2p/src/storage/block-archive.ts` holds `singleRevisionArchive` (the shape) and
`serveBlockArchive` (the repo read that produces it), and all three sites delegate:
`SyncService.buildArchive`, the mesh harness's `makeFetchArchive`, and the reconcile spec's stand-in.
Three copies became one, the divergence is gone, and a fourth copy is no longer a thing anyone can
write by accident. Behaviour over the wire is unchanged (`block: undefined` does not survive JSON
either way), which the full suites confirm.

**`createMesh` had grown to roughly 165 lines with the new policy block inline.** The
option-folding is now `resolveMeshPolicy(options)` — exported, named, and callable without building a
mesh, which is what makes the documented shorthand-precedence rule assertable at all. No behaviour
change; the comment that used to explain the fold is now mostly the function's name.

### Found and filed

`tickets/backlog/debt-mesh-harness-policy-and-commit-path-untested.md` — the new `clusterPolicy`
option, its documented precedence rule, and the `assumedClusterSize` escape hatch the cluster-policy
docs actually recommend all have zero coverage; and all four new cases enter repair from the read
side, leaving the commit side driven only by unit tests with a fake peer-fetcher — the exact kind of
stand-in this ticket existed to stop relying on. Filed as one ticket with two arms because both
resolve by adding cases in the same place. Checked the board first: `4-mesh-harness-admission-gate`
and `5-mesh-harness-signature-enforcement` both claim `mesh-harness.ts` but for unrelated concerns
(the admission gate, the signature validator), so this is a fresh ticket rather than an arm on either.

### Parked as a tripwire, not a ticket

A mesh is never shut down: `Mesh` exposes no disposal seam, so each node's `ClusterMember.dispose()`
is never called and its two cleanup intervals tick for the rest of the process. Harmless today —
both handles are `.unref()`ed, so the process still exits, and the callbacks are no-ops on an idle
member — across roughly 40 `createMesh` sites. Recorded as a `NOTE:` at the top of `createMesh` with
the condition that would make it real work (a mesh holding something a timer keeps alive: a socket, a
file handle, a fake clock a spec advances). Pre-existing, not introduced here.

### Considered and declined

**Comment density.** The diff is heavily prose-commented — roughly a line of comment per line of code
in places. Left alone: this is the house style throughout `db-p2p` (`cluster-policy.ts` is 285 lines
of which most is exposition), and matching the surrounding code beats imposing a different taste.

**Harness file size.** Measured at 410 lines before this pass (`wc -l`), 409 after — the extraction gave back what the new function cost. Cohesive — mock
transport, mock routing, the archive fetch, mesh assembly, transactor builders — and no split
suggests itself. Not size-debt.

### Not found

No correctness defect in the quorum wiring itself, no type-safety hole, no error-handling gap, and no
resource leak beyond the disposal tripwire above. The three known gaps the handoff asked to be probed
— the disarmed membership admission gate, the inert `assumedClusterSize`, and the unwired signature
validator — are all accurately described and all already owned by tickets 4 and 5; the handoff's
deviation from the ticket's three-node sketch to a four-node mesh in case 3 is correct reasoning
(three nodes give one honest vote per group, which pins the decline but not the adoption).

## Follow-on

`mesh-harness-admission-gate` (seq 4) and `mesh-harness-signature-enforcement` (seq 5) gate on this
slug via `prereq:` and are unblocked. The admission-gate ticket's implementer should note that
members already receive `assumedClusterSize` from this commit — it goes live the moment that ticket
flips `allowUnvalidatedSmallCluster` to `false`, so behaviour changes from *this* commit, not from
theirs.
