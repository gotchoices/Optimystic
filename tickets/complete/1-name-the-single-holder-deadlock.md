description: A machine that can never repair its copy of a piece of data now says which of two things is wrong — too few machines, or too few machines holding that particular piece — instead of reporting the same unhelpful shortfall for both. The documentation half of the work is tracked separately and is not done.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/coordinator-repo-single-holder.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts
----

# "Only one cohort peer has this block" is now a thing the node can say

From `implement/1-name-the-single-holder-deadlock` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). Diagnosis only —
**no repair decision changed.** `corroboratorCapacity`, `quorumSize` and `selectQuorumRev` keep their
arithmetic exactly; the same declines happen, and one class of them is now named correctly.

## What shipped

### A second provable reason on `cluster-fetch:repair-deadlock`

`CoordinatorRepo.reportRepairDeadlock` previously fired only when the cohort was too small to reach
the quorum *even if every peer answered and agreed*. That test classified the reported field case as
**transient**, on the reasoning that a peer answering "I hold nothing" will hold it later. For a peer
that *answered*, that is false: the only two mechanisms that turn a non-holder into a holder —
`queryClusterForLatest` (read-repair) and `createReconcileBlock` (reconcile) — consume this very
decision, so they decline on that peer for exactly the same reason.

The line now carries `reason`, with two values and two entirely different messages:

| `reason` | condition | what the message tells the operator |
| --- | --- | --- |
| `cohort-too-small` | `cohortPeers < quorumSize(cohortPeers, …)` | machines, or an honest declared cohort size |
| `sole-holder` | every peer answered, exactly one claims the block | get **another cohort peer holding it**; machines and settings are both irrelevant |

Both can hold at once (an undeclared two-machine deployment whose single peer holds the block).
`cohort-too-small` wins that tie deliberately: declaring the real size there makes the floor
reachable and the lone claim *is* then adopted. The `sole-holder` message deliberately does **not**
repeat the `assumedClusterSize` advice — at two or more cohort peers, declaring a size changes
nothing.

Two things the review changed here (details under *Review findings*): the message is scoped to
**cohort peers** rather than claiming a deployment-wide copy count, and the once-per-block
suppression is keyed on `reason` so a cohort that grows out of `cohort-too-small` into `sole-holder`
still gets told.

Unchanged: the silence guard and the nobody-claimed guard still return early ahead of both tests.

### The decline logs name the populations

`cluster-fetch:no-quorum` reported `responders` and `required`. "1 of 2 responded" and "1 holder, 1
confirmed non-holder, 0 silent" are different problems with different operator actions, so
`responders` is replaced by `cohortPeers` / `holders` / `absent` / `silent`.

`reconcile:no-rev-quorum` got the same treatment, but **honestly rather than symmetrically**.
`ReconcileBlockDeps.fetchArchive` is contracted to return `undefined` for *both* "holds nothing" and
"unreachable", and the production wiring (`libp2p-node-base.fetchArchiveFromPeer`) swallows every
dial failure and timeout into that same `undefined` — so reconcile cannot separate absent from silent
the way the read path can. What it *can* separate, it now does: `fetchCandidate` was replaced by
`fetchAnswer`, returning a tagged `PeerAnswer` (`claim` / `behind` / `no-archive` / `error`), and the
payload reports `cohortPeers`, `holders`, `behind`, `noArchive`, `fetchErrors`. The conflation is
recorded as a `NOTE:` on `PeerAnswer` rather than papered over.

### The startup advisory no longer overstates its own guarantee

`resolveClusterPolicy`'s `repair-fault-tolerance` message counted machines and stopped there, which
made it wrong in the operator's favour: a machine count is half the requirement, and the answering
peers must also *hold* the block. A closing paragraph now scopes every size claim in the message to a
block at least two peers hold, states that a singly-held block cannot be repaired at any deployment
size, names the stranded-founding-data case ("growing the deployment does not copy it"), and points
at `reason=sole-holder`.

## Validation

```
yarn lint                                  # from the repo root — clean
yarn build                                 # all workspaces — clean
yarn test                                  # all workspaces — 0 failing
cd packages/db-p2p && yarn build && yarn test   # 1907 passing, 44 pending, 0 failing
```

**By hand**, with `DEBUG=optimystic:db-p2p:*`: three nodes, write a block while only one is up, bring
the other two up, read the block from a node that does not hold it. Expect one
`cluster-fetch:repair-deadlock` naming `sole-holder`, and `cluster-fetch:no-quorum` on every read.

## Review findings

Read the implement diff (`daba6c2`) before the handoff summary. Lint, build and the **full**
workspace test suite were run — the two gaps the handoff was honest about leaving. All green:
`yarn lint` exit 0, `yarn build` exit 0, `yarn test` across every workspace 0 failing, `db-p2p` at
1907 passing / 44 pending / 0 failing (1904 before, +3 added below). No pre-existing failures
surfaced, so `tickets/.pre-existing-error.md` was not written; nothing was skipped or loosened.

### Fixed in this pass

- **The `sole-holder` message asserted a deployment-wide fact from a cohort-relative observation.**
  It read `ONLY ONE MACHINE HOLDS THIS BLOCK`, but this node's own copy is deliberately excluded from
  the claim set (it cannot corroborate the revision it is repairing), so `claimants === 1` means "one
  *cohort peer* holds it". Read-repair's normal shape is a present-but-possibly-stale block —
  `fetchBlockFromCluster` is called with the reader's own `localRev`, and every unit test in
  `coordinator-repo-read-repair.spec.ts` runs against `makePresentStorageRepo`, i.e. a reader that
  holds the block. In paranoid mode, a reader holding the block at the same revision as its one
  holding peer got an all-caps claim it could disprove by looking at its own disk, plus a remedy ("the
  block needs a SECOND COPY") that is off by one in that case. Reworded to `ONLY ONE COHORT PEER HOLDS
  THIS BLOCK` / "what is missing is ANOTHER COHORT PEER HOLDING THE BLOCK", with the reader's own copy
  named and excused rather than ignored. The equivalent phrase in `resolveClusterPolicy`'s advisory
  was aligned. Pinned by a new test that puts the reader and its lone claimant on the *same* revision
  and asserts the message contains no deployment-wide claim.
- **Once-per-block suppression ignored `reason`, so the second diagnosis could never be said.**
  `AheadClaimState.deadlockReported` was a single boolean and the entry is only cleared when the block
  converges — which, by definition, a deadlocked block does not. `cohort-too-small` tells the operator
  to add machines; adding them changes the cohort view at runtime with no restart and can leave the
  block stuck as `sole-holder`, whose line was then swallowed. That is precisely the failure this tag
  exists to end: the operator acts on the advice, it does not work, and the log goes quiet about why.
  The field is now `deadlocksReported?: readonly DeadlockReason[]` (bounded at two by the union) and
  suppression is per reason. New test drives cohort-too-small → grow the cohort → sole-holder → silence
  on the third pass.
- **Two doc comments still described the deadlock as purely "a property of the deployment's size"** —
  on `AheadClaimState` and in `recordAheadClaim`. True of one reason, not of the other. Corrected.
- **Source hygiene:** `reportRepairDeadlock` had grown to ~90 lines dominated by two ~15-line inline
  template literals, which buried the classification logic that is the actual subject of the method.
  Both messages extracted to named module-level builders (`cohortTooSmallMessage`,
  `soleHolderMessage`); the method is back to reading as decide-then-log.

### Test gaps closed

- **The reconcile population counts were only ever asserted as zero.** `reconcile-block.spec.ts`
  pinned `behind`, `noArchive` and `fetchErrors` at 0 in the single case that exercised them — a
  constant `0` would have satisfied the suite, which defeats the point of splitting `responders` apart
  at all. Added a case driving a four-peer cohort with one of each population (holder, behind,
  no-archive, throwing fetch) that pins each bucket at 1 and asserts they partition `cohortPeers`.
- The two coordinator-repo tests above.

### Considered and accepted, not changed

- **The startup advisory's trigger was not widened**, which the handoff explicitly asked a reviewer to
  rule on. Agreed with leaving it: a correctly-declared large deployment never sees the holders caveat
  at startup and learns it from the per-block line instead, but an advisory that fires on every
  correctly-configured node forever is one operators filter, which costs more than it buys. Recorded
  as an accepted-tradeoff `NOTE:` at the site in `cluster-policy.ts` with its revisit condition, so the
  next reviewer does not re-file it.
- **`answered === cohortPeers` in the `soleHolder` test is redundant** with the silence guard above
  it, and the handoff invited its removal. Kept: the two counts arrive as independent parameters, the
  redundancy is one comparison, and the existing comment already says why it is stated. Removing it
  would make the condition's provability depend on a guard fifteen lines away.

### Tripwires recorded (not tickets)

- **A commit that has landed on one cohort member but not yet been pushed to the rest presents exactly
  the `sole-holder` shape**, so the PERMANENT wording can be true of the instant and not of the
  deployment. Defensible as-is — repair genuinely cannot converge until the push lands, and the
  once-per-episode flag clears the moment the block converges — and how wide that window gets is what
  `blocked/repair-floor-defends-a-door-the-push-path-leaves-open` decides. Parked as a `NOTE:` beside
  the `soleHolder` test in `coordinator-repo.ts`, naming the condition (operators seeing `sole-holder`
  on blocks that heal moments later) and the fix if it trips (gate on block quiet-time, do not soften
  the wording).

### Checked, nothing found

- **Field-name migration.** Grepped every `responders` reference in source, tests and docs; the
  remaining hits are `quorum-restore.ts`'s own local variable and unrelated prose. Nothing reads the
  renamed log fields programmatically.
- **`toCandidate`'s narrowed signature** (`BlockArchive` instead of `BlockArchive | undefined`) has one
  caller, `fetchAnswer`, which now does the `undefined` check itself. No other call sites.
- **Population arithmetic.** `absent = answered - claims.length` and `nonHolders = cohortPeers -
  claims.length` are consistent with the `silent`/`answered`/`nonSelfCount` derivation above them,
  including under the documented unset-`localPeerId` tolerance.
- **Reconcile/read-path naming.** Both sites use `cohortPeers` to mean "peers besides this node"
  (`targets.length` and `nonSelfCount` respectively); the term is not overloaded across the two logs.

### Not fixed — tracked elsewhere

- **The docs sweep is undone**, split into `implement/1.5-single-holder-docs-sweep`. Four documents
  (`docs/internals.md`, `docs/transactions.md`, `packages/db-p2p/docs/cluster.md`,
  `packages/reference-peer/README.md`) plus the summary table in
  `complete/1-repair-deadlock-is-never-named.md` still tell operators that four or more machines is
  the first size with any margin, unconditionally, and the shipped strings disagree. That ticket also
  carries the `quorum-restore.spec.ts` size-table rescoping, which is what would stop the
  unconditional claim drifting back in. It was updated this pass to carry the cohort-peer scoping
  above, so the docs copy the corrected wording rather than the original.
- **Behaviour is unchanged**: a reader still cannot obtain a singly-held block. The fix is the sibling
  `implement/2-replicate-owned-blocks-when-the-cohort-grows`, which is independent of this.
