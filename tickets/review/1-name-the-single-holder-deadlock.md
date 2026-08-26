description: A machine that can never repair its copy of a piece of data now says which of two things is wrong — too few machines, or only one machine holding that data — instead of reporting the same unhelpful shortfall for both. The documentation half of the work was split out and is not done.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/coordinator-repo-single-holder.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts
difficulty: medium
----

# "Only one machine has this block" is now a thing the node can say

From `implement/1-name-the-single-holder-deadlock` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). Diagnosis only —
**no repair decision changed.** `corroboratorCapacity`, `quorumSize` and `selectQuorumRev` keep their
arithmetic exactly; the same declines happen, and one class of them is now named correctly.

## What shipped

### A second provable reason on `cluster-fetch:repair-deadlock`

`CoordinatorRepo.reportRepairDeadlock` previously fired only when the cohort was too small to reach
the quorum *even if every peer answered and agreed*. That test classified the reported field case as
**transient**, because a three-machine cohort does have the two peers a quorum needs.

The reasoning behind "transient" was: the peer that answered "I hold nothing" will hold it later. For
a peer that *answered*, that is false. The only two mechanisms that turn a non-holder into a holder —
`queryClusterForLatest` (read-repair) and `createReconcileBlock` (reconcile) — consume this very
decision, so they decline on that peer for exactly the same reason. Every peer answered, one holds
the block, the rest hold nothing, and no later pass changes any of it.

The line now carries `reason`, with two values and two entirely different messages:

| `reason` | condition | what the message tells the operator |
| --- | --- | --- |
| `cohort-too-small` | `cohortPeers < quorumSize(cohortPeers, …)` | machines, or an honest declared cohort size |
| `sole-holder` | every peer answered, exactly one claims the block | get a **second copy**; machines and settings are both irrelevant |

Both can hold at once (an undeclared two-machine deployment whose single peer holds the block).
`cohort-too-small` wins that tie deliberately: declaring the real size there makes the floor
reachable and the lone claim *is* then adopted, so calling it a copy-count problem would send the
operator hunting for a copy they do not need. The `sole-holder` message deliberately does **not**
repeat the `assumedClusterSize` advice — at two or more cohort peers, declaring a size changes
nothing.

Unchanged: the silence guard and the nobody-claimed guard still return early ahead of both tests, and
suppression is still once per block off the existing `unsettledAheadClaims` entry.

### The decline logs name the three populations

`cluster-fetch:no-quorum` reported `responders` and `required`. "1 of 2 responded" and "1 holder, 1
confirmed non-holder, 0 silent" are different problems with different operator actions, so
`responders` is replaced by `cohortPeers` / `holders` / `absent` / `silent`.

`reconcile:no-rev-quorum` got the same treatment, but **honestly rather than symmetrically** — worth
a reviewer's attention, because the implement ticket asserted all four counts were in scope at both
sites and that is not true. `ReconcileBlockDeps.fetchArchive` is contracted to return `undefined` for
*both* "holds nothing" and "unreachable", and the production wiring
(`libp2p-node-base.fetchArchiveFromPeer`) swallows every dial failure and timeout into that same
`undefined` — so reconcile cannot separate absent from silent the way the read path can. What it
*can* separate, it now does: `fetchCandidate` was replaced by `fetchAnswer`, returning a tagged
`PeerAnswer` (`claim` / `behind` / `no-archive` / `error`), and the payload reports `cohortPeers`,
`holders`, `behind`, `noArchive`, `fetchErrors`. The conflation is recorded as a `NOTE:` on
`PeerAnswer` rather than papered over.

### The startup advisory no longer overstates its own guarantee

`resolveClusterPolicy`'s `repair-fault-tolerance` message counted machines and stopped there, which
made it wrong in the operator's favour: a machine count is half the requirement, and the answering
peers must also *hold* the block. A closing paragraph now scopes every size claim in the message to a
block at least two peers hold, states that a singly-held block cannot be repaired at any deployment
size, names the stranded-founding-data case ("growing the deployment does not copy it"), and points
at `reason=sole-holder`.

**The trigger was deliberately not widened**, and a reviewer should decide whether that is right. The
advisory still fires only when the cohort size is undeclared *or* the resolved
`repairCorroborationClusterSize` is three or fewer. A correctly-declared large deployment — precisely
the operator most likely to believe they are covered — therefore never sees this paragraph at
startup, and learns about it only from the per-block line. Widening it would mean a startup advisory
on every correctly-configured node forever, which is how advisories get filtered.

## Use cases to test, validate, and exercise

**The reported shape, end-to-end.** `test/coordinator-repo-single-holder.spec.ts` (new) wires real
`StorageRepo`/`BlockStorage` instances and the real `createReconcileBlock` acquisition path — the
harness from `coordinator-repo-read-repair-content.spec.ts`, extended to three peers. Node A holds the
block, reader B holds nothing, node C holds nothing and answers so.

- *control* — two machines, honest `clusterSize: 2`: B **does** acquire the block, nothing declines.
  This is what makes every non-acquisition below the copy count rather than a broken fixture.
- *three machines* — five consecutive reads: `cluster-fetch:no-quorum` five times reporting
  `{cohortPeers: 2, holders: 1, absent: 1, silent: 0}`, `cluster-fetch:repair-deadlock` **once** with
  `reason: 'sole-holder'`, and B still holds nothing afterwards.
- *four and six machines* — identical diagnosis. Adding machines adds non-holders.

**Classification boundaries** (`test/coordinator-repo-read-repair.spec.ts`, unit-level, stubbed
`IRepo`): fires for a declared three-machine cohort and for an unconfigured one; stays quiet while any
peer is silent; stays quiet when nobody claimed; stays quiet when a **second** peer holds the block
and the two merely disagree (two copies exist — what is missing is agreement, and agreement can still
arrive). The two-machine `cohort-too-small` case keeps its old assertions plus `reason`.

**By hand**, with `DEBUG=optimystic:db-p2p:*`: three nodes, write a block while only one is up, bring
the other two up, read the block from a node that does not hold it. Expect one
`cluster-fetch:repair-deadlock` naming `sole-holder`, and `cluster-fetch:no-quorum` on every read.

```
cd packages/db-p2p && yarn build && yarn test
```

## Known gaps — do not treat this as finished work

- **The whole docs sweep is undone**, split into `implement/1.5-single-holder-docs-sweep`. Four
  documents (`docs/internals.md`, `docs/transactions.md`, `packages/db-p2p/docs/cluster.md`,
  `packages/reference-peer/README.md`) plus the summary table in
  `complete/1-repair-deadlock-is-never-named.md` still tell operators that four or more machines is
  the first size with any margin, unconditionally. The shipped strings and the docs currently
  disagree. That ticket also carries the `quorum-restore.spec.ts` size-table rescoping, which is what
  would stop the unconditional claim drifting back in.
- **`yarn lint` was not run**, and neither was the suite outside `db-p2p`. `packages/db-p2p`'s own
  suite is green end to end: **1904 passing, 44 pending, 0 failing**, plus a clean `yarn build`. No
  pre-existing failures surfaced; nothing was skipped or loosened, and
  `tickets/.pre-existing-error.md` was not written because there was no failure to report.
- **A transient window can produce a false `sole-holder`.** Immediately after a commit lands on one
  cohort member, before the commit path has pushed the block to the others, a read sees exactly the
  reported shape. The line is once per block and the classification is about repair (which genuinely
  cannot converge in that instant), but a reviewer should judge whether the message's confident
  "PERMANENT" wording is right for that window. Related, and explicitly out of scope:
  `blocked/repair-floor-defends-a-door-the-push-path-leaves-open`.
- **`answered === cohortPeers` in the `sole-holder` test is redundant** — the silence guard above it
  already implies it, since `answered = cohortPeers - silentCount`. Kept explicit with a comment
  because the two arrive as independent parameters; a reviewer may prefer it gone.
- **Behaviour is unchanged**: B still cannot obtain a singly-held block. The fix is the sibling
  `implement/2-replicate-owned-blocks-when-the-cohort-grows`, which is independent of this.
