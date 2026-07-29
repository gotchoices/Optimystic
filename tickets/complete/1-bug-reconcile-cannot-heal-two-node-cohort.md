----
description: When a node was missing a piece of data, its repair step insisted that two different peers hand over the same copy before it would trust it — so in a two-machine setup, where only one other machine exists, the repair always refused and the node stayed empty. It now asks for only as many copies as the group can actually supply.
files: packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/quorum-restore.spec.ts, docs/internals.md, docs/transactions.md
----

# Complete: reconcile can heal a two-node cohort

Implemented in `07cb230`; reviewed here. Third in the chain
`bug-member-commits-unmaterializable-revision` (`d6a22d2`) → this → `bug-read-repair-unrepairable-small-cluster`
(`d31be12`, which landed between implement and review and further edited two of the same files).

## What shipped

**The defect.** The commit-path repair (`reconcileBlock`) had *two* sequential gates, both stuck on
an absolute floor of two corroborating peers:

1. the revision vote — `selectQuorumRev` was called with no `corroboratorCapacity` at all, an
   oversight when `50af693` added that parameter and threaded it into the read-repair caller only;
2. the content vote — `selectQuorumBlock`, which `50af693` deliberately left strict.

A two-node cohort has exactly one other peer and can never satisfy either, so a node that refused an
unapplicable commit could never fetch what it was missing. Both gates now take the same
`corroboratorCapacity = max(cohort peers excluding self, clusterSize − 1)`.

**Why relaxing the content gate is sound, and why the original ticket's reasoning was not.** The
ticket assumed blocks are content-addressed, so that a peer could not substitute different bytes
under the same id. They are not: `BlockId` is 256 random bits (`db-core/src/blocks/structs.ts`), and
nothing between the socket and `saveReplicatedBlock` compares anything to the requested id. The real
justification is different — at capacity one, the sole peer's *revision claim* is already believed on
its word by deliberate design, so the content gate bought nothing there while making the cohort
permanently unhealable. The `max(observed, clusterSize − 1)` form confines the relaxation to cohorts
an operator has explicitly declared two-node; a shrunken view of a larger cohort still faces the
floor of two.

**Also in the diff.** The ~60-line reconcile closure moved out of `createLibp2pNode` into
`cluster/reconcile-block.ts` (which is why it had no unit coverage and why the missing parameter went
unnoticed); `selectQuorumBlock` now counts one vote per *distinct peer* per hash group rather than per
raw candidate; decline logging added; a literal NUL byte in `quorum-restore.ts` — which had made git
classify the file as binary and hide its diff and blame across two prior fixes — replaced with a `\0`
escape.

## Review findings

Read the implement diff (`07cb230`) before the handoff summary, then re-read every touched file at
HEAD, since `d31be12` had since edited `reconcile-block.ts`, `quorum-restore.ts` and both docs.

### Fixed in this pass (minor)

- **One unreachable peer could abort a heal the rest of the cohort could complete.**
  `createReconcileBlock` ran `Promise.all` over raw `fetchArchive` calls. The production
  `fetchArchiveFromPeer` catches internally, but the injected dependency is not contractually
  non-throwing, and a single rejection discarded every other peer's answer — degrading a satisfiable
  quorum into a decline. Each peer's fetch is now isolated (`fetchCandidate`, logs
  `reconcile:fetch-error`) and costs only that peer its vote. New spec.
- **A single non-numeric key in a peer's archive silently discarded that peer entirely.**
  `Object.keys(revisions).map(Number)` yields `NaN` for a junk key; `Math.max` then returns `NaN`,
  `NaN < committedRev` is false, and the lookup misses — so an archive carrying one bad key lost its
  good revisions too. Keys arrive as strings from an untrusted peer. Replaced with `maxRevision`,
  which folds over finite keys only (and, incidentally, keeps a wide archive off the spread-argument
  limit). New spec. Not exploitable to steer a vote — a peer could only suppress itself — but it is
  wrong, and it made a malformed peer look like an absent one.
- **`cluster-member:consensus-commit-reconciled` claimed success on every non-throwing pass**,
  including every quorum decline — the same false-positive shape `d6a22d2` removed from
  `cluster-fetch:synced`. Flagged by the implementer as a known gap. Renamed to
  `...reconcile-attempted`, with a comment and a `docs/internals.md` line stating that
  `reconcile:restored` is the only line meaning bytes landed. Renaming rather than plumbing a return
  value through `ReconcileBlockCallback`: that type is shared with the read path's
  `AcquireBlockCallback` and six test call sites, and neither caller has a use for the result beyond
  the log.

### Filed as tickets (major)

- `backlog/debt-mesh-harness-reconcile-double-bypasses-quorum` — the mesh harness supplies its own
  first-peer-wins stand-in for block repair, shared by both the commit and read paths, so no
  mesh-level test exercises either quorum gate. It would keep passing if the gates regressed to
  permanently declining. Flagged by the implementer; not fixed inline because wiring the real
  implementation requires the harness to declare a cluster size and will change the outcome of
  existing mesh tests, each of which needs its own judgement call.
- `backlog/bug-key-network-cluster-size-default-diverges` — found while checking the doc claim that
  `clusterSize` defaults to 10. It does for consensus and the network manager, but
  `Libp2pKeyPeerNetwork` is handed the raw option and falls back to its own default of 16. Cohorts
  are therefore assembled wider than the membership admission gate measures against, which weakens
  that gate by exactly the gap. Pre-existing, unrelated to this diff, and adjacent to
  `plan/3-clustersize-conflates-replication-factor-and-admission-yardstick`.
- `blocked/two-node-convergence-acceptance-cross-repo-build` — see *Not verified* below.

### Tripwires (recorded, not ticketed)

- `hashCarriers` canonical-JSON-serializes and sha256s every carrier's whole block on every
  reconcile. Negligible at present cohort widths and block sizes. `NOTE:` at the function in
  `reconcile-block.ts` saying to hash at receive time instead if it ever shows on a commit-path
  profile.

### Checked and found sound (no action)

- **Both gates verified independently.** Relaxing only one still declines at two nodes; the implement
  ticket's claim that both had to move is correct.
- **Anti-shrinking property.** `max(observed, clusterSize − 1)` is the safe direction under an
  inflated peer set (capacity rises, floor stays 2) and pinned under a shrunken one. Covered by the
  `clusterSize: 10` spec and by `d31be12`'s `corroboratorCapacity` unit specs, including the
  degenerate `clusterSize` 0/1 cases.
- **Content split declines rather than picking a side** — `selectQuorumBlock` requires exactly one
  hash group to meet quorum, so two groups at quorum 1 decline. Spec'd.
- **Contradicting-content peers are penalized only when a quorum was actually reached.** Correct as
  written: on a genuine split there is no agreed hash and therefore no basis for saying who lied.
- **Declines persist and mark nothing**, so a retry re-queries rather than short-circuiting, and does
  not spin. Spec'd with a two-attempt assertion.
- **Docs.** `docs/internals.md` (behind-member reconcile bullet) and `docs/transactions.md`
  (§ *What a repair pass will and will not accept*) were re-read at HEAD after `d31be12`'s edits.
  Both correctly state the two-gate cap, the `clusterSize: 2` operator requirement, and — importantly
  — that the content check compares peers to each other and never to the requested id. Extended with
  the log-line correction above. No other file in the repo documents this path.

## Testing

`packages/db-p2p`: **1416 passing, 41 pending, 0 failing** (1414 before this review's two new specs).
Full monorepo `yarn test`: all workspaces green, 0 failing. Root `yarn lint` clean, `yarn build`
clean. No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

The 11 implement-stage specs in `reconcile-block.spec.ts` drive the real callback and cover the
two-node heal (the reproduction — it failed before the fix), adopting a peer ahead of the committed
rev, the shrunken-view guard, empty and self-only cohorts, no peer holding the block, a peer behind
the commit, a corroborating peer carrying no bytes, an outvoted content liar with its penalty, an
even content split, an inflated revision, and a throwing reputation sink. This review added the two
listed above.

## Not verified

**Two-node convergence is demonstrated at the unit level only.** The end-to-end acceptance scenario
is `control-db-two-node-convergence` in the sibling `sereus` repository, and it still aborts before
running:

```
Stale build detected: these tests run real compiled output.
  - @serfab/cadre-core: dist is stale — src was edited after the last build.
  - @quereus/quereus: dist is stale — src was edited after the last build.
```

Rebuilding two repositories this project does not own is out of bounds for a ticket agent, so this is
handed to a human as `blocked/two-node-convergence-acceptance-cross-repo-build`, which carries the
exact command sequence and what each outcome means. The same run is outstanding for the sibling
review ticket `read-repair-cannot-transfer-block-content`. Three consecutive fixes to this path have
each been assumed sufficient and each been followed by another; treat a pass as the first actual
confirmation, not a formality.
