description: A node could accept an update to a piece of data it had never received, leaving it holding a version it could not reconstruct — the data became unreadable there, unavailable to other nodes, and every later change to it was rejected. It now refuses the update and pulls the missing data from a peer instead.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/cluster-consensus-divergence.spec.ts, packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts, docs/internals.md, docs/transactions.md
----

# A member must never record a revision it cannot materialize — implemented and reviewed

## What shipped

`StorageRepo.internalCommit` refuses a commit that would advance `latest` to a revision this node
materialized nothing for. That happened when a member held the *pend* for revision N of a block but
never saw the revision that created it: `applyTransform(undefined, <updates>)` silently returns
nothing, yet `setLatest` advanced anyway. The block was then unreadable locally, unservable to peers,
and rejected every later write to it, with no self-healing path.

The refusal carries a distinct, greppable `missing-base-revision` reason. `ClusterMember` treats it
as a third commit disposition — between "ahead, tolerate" and "genuine fault, propagate" — and pulls
the committed revision from a cohort peer *after* `commit()` has released its per-block latches.
Healing inside the commit path was not available: the only proven base-fetch route re-acquires the
same latch and would self-deadlock.

Also in the implement pass: `cluster-fetch:synced` is logged only on an actual advance
(`cluster-fetch:not-restored` otherwise) — the old unconditional line produced 222 phantom
convergences in one trace and misdirected two debugging sessions.

Implement commit: `d6a22d2`. Two later commits (`07cb230`, `559df6a`) landed on the same files
before this review and are accounted for below.

## Review findings

Reviewed against the diff at `d6a22d2` **and** the current tree, since `07cb230` (two-node reconcile)
and `559df6a` (read-driven block acquisition) both modified files this ticket touched.

### Major — fixed in this pass

**The commit refusal was not tolerated on the coordinator path, so a landed transaction was reported
to the client as a failure.** `CoordinatorRepo.commit` falls back to a local commit when its own
member did not execute during consensus, and it tolerated local divergence *only when the local
commit threw*. The new refusal is a returned `success:false`, so it bypassed that tolerance entirely
and was handed back to the caller. db-core's `commitPhase` treats any returned `success:false` as a
permanent stale loss, so a client would have retried an action the cluster had already committed
until its retry budget was exhausted, then thrown `SyncRetryExhaustedError`.

Reachable in exactly the scenario this ticket exists for: a coordinator that saw the pend but not the
revision that created the block. Note the direction of the regression — before this ticket that path
returned `success: true` (silently wedged); after it, it hard-failed the client.

Fixed by routing both divergence shapes — the pre-existing throw and the new returned refusal —
through one tolerance decision gated on `clusterReachedCommitConsensus`. A `success:false` with any
other reason is still returned to the caller, so a genuine lost race is not reported as a win.
Documented in `docs/internals.md`; covered by a new spec file (the branch had **no** test coverage
before, including for the pre-existing throw tolerance).

### Major — filed as a ticket

**Divergent commits leave pending records that can never be promoted** →
`backlog/bug-orphaned-pending-after-divergent-commit`.

`commit()` breaks out of its per-block loop on the first failure, so blocks it had not reached keep
their pending records; reconcile then advances those blocks past the action, making the records
unpromotable forever. Every later write to such a block sees a phantom conflicting action.

The implement handoff flagged this as speculative cruft ("fatal under `policy: 'f'`"). Two things
turned out differently on investigation, and the ticket reflects both:

- **It is real, not speculative** — reproduced and pinned by two passing `KNOWN GAP` specs.
- **It is less severe than the handoff implies.** Production pends use `policy: 'r'`, not `'f'`, and
  consensus *tolerates* a member's failed pend (`consensus-pend-diverged` is logged, not thrown). So
  it does not block cluster writes or corrupt data — it silently demotes one member to
  replication-only convergence for that block, permanently.
- **It is pre-existing, not introduced here.** The older missing-pend divergence path produces the
  identical orphan, and `commit()` throws there *before* the per-block loop runs, so it orphans
  *every* block in the batch. A second spec proves this without any missing-base refusal involved.
  This ticket only added one more route into an existing gap.

### Minor — fixed in this pass

**`readCommitBase`'s catch was broader than its docstring claimed.** The docstring described it as
covering "a block already wedged by a pre-fix commit, or by truncated history", which reads as
exhaustive. It is not: the catch also absorbs transient faults — a raw-storage read error, or a
`restoreCallback` timeout on a block whose `ranges` do not cover its own `latest`. Those are then
treated as divergence, which *also drops the pending*, so a transient fault costs the node its
ability to recover by replay rather than by replication.

Kept the behaviour (BlockStorage reports all of these as a bare `Error`, so they cannot be told
apart here, and healing beats throwing out of consensus) and corrected the docstring to state the
real scope, the price, and what narrowing it would require.

### Checked and found correct — no change

- **The decision not to enforce `latest.rev === rev - 1`.** Correct, and it matches a prior
  human-escalated decision: `blocked/st-commit-contiguity-guard-premise` records that this exact
  guard was implemented verbatim, broke three `cascade.spec.ts` tests, and was reverted, because
  revisions are allocated per *collection* so a block's revisions are legitimately sparse.
  That blocked ticket was updated with what this work settles: the "no base at all" sub-case is now
  guarded, while the "stale base" sub-case remains undetectable locally and is *not* covered by the
  reconcile path (a stale-base node never reports divergence, so nothing triggers a heal). That
  narrows the human's remaining decision rather than answering it.
- **Re-entrancy / deadlock.** No network call was added inside the commit latch. Verified by
  reading, not just by test: `reconcileDivergentCommit` is called from `applyConsensusOperation`
  after `commit()` returns and its `finally` has released every latch.
- **`latest === undefined` as the predicate** (the implementer's own top question). Correct as
  written. An absent `newBlock` with a prior `latest` is a legitimate tombstone — `materializeBlock`
  walks descending and resolves to an earlier materialization, so it reads back as absent rather
  than throwing. Only a block's *first* revision must carry a materialization.
- **Deleting the pending inside `refuseMissingBase`, including on the read path** (the implementer's
  second question). Traced the sequence: a read-path deletion makes the later consensus commit take
  the missing-pend branch, which reconciles — so it converges, just by replication instead of replay.
  Consistent with the design decision the ticket already made.
- **The string-prefix reason marker.** Correct as designed — `StorageRepo.commit` flattens a per-block
  throw into `reason: err.message`, so class identity is genuinely gone by the time `ClusterMember`
  inspects the result, and `reason` also crosses the wire. It follows the existing
  `isMissingPendingActionError` precedent rather than inventing a second convention.
- **The mutated `makePresentStorageRepo` stub** in `coordinator-repo-read-repair.spec.ts` (the
  implementer asked for a second pass). Re-audited; `559df6a` subsequently reworked that file
  further. All specs green.
- **Import direction.** `coordinator-repo → storage-repo` is a new edge but not a cycle:
  `storage-repo` imports only `it-utility`, `i-block-storage`, `logger`, and a type from
  `block-transfer-service`.
- **Docs.** Read every touched file rather than trusting the handoff. `docs/internals.md` and
  `docs/transactions.md` were accurate *and* had already been corrected by the two later commits —
  notably, the implement ticket's claim that "the read path never acquires a never-seen block" was
  reversed by `559df6a`, and the docs reflect the new reality with no stale text left. Added the one
  thing genuinely missing: the coordinator-side tolerance.
- **Block-storage secondary defect.** The implement pass documented the never-seen-block early return
  as deliberate; `559df6a` then made read-driven acquisition work a layer up, and rewrote that comment
  accordingly. No stale comment remains.

### Tripwires

None recorded. The two conditional concerns in this area — read-repair window damping on a failed
convergence, and the two-node content-quorum limit — already carry `NOTE:` comments at their sites
from the preceding commits, and remain accurate.

## Test changes in the review pass

New file `test/coordinator-repo-commit-divergence.spec.ts` (4 specs): the missing-base refusal is
tolerated when the cluster committed; the pre-existing missing-pend throw is too; a genuine stale
loss still reaches the caller; and nothing is tolerated when the cluster did *not* reach consensus.

`test/storage-repo.spec.ts` — new `mixed batch` suite (4 specs): the refusal surfaces even when a
sibling block committed first; a not-yet-reached sibling is left uncommitted rather than
half-applied; plus the two `KNOWN GAP` specs pinning the orphaned-pending behaviour by both routes.

## Validation

```
$ yarn lint                                  → exit 0
$ yarn build                                 → exit 0
$ yarn test              (root fan-out)      → 0 failing, every package
$ cd packages/db-p2p && yarn test            → 1409 passing, 41 pending, 0 failing
$ cd packages/db-p2p && yarn test:integration → 27 passing, 2 pending, 0 failing
```

db-p2p went 1401 → 1409 passing (+8 review specs). Nothing skipped, disabled, or loosened; no
pre-existing failures encountered.

## Follow-on work

- `backlog/bug-orphaned-pending-after-divergent-commit` — filed by this review.
- `blocked/st-commit-contiguity-guard-premise` — updated, still awaiting a human decision on the
  stale-base case.
- `review/1-read-repair-cannot-transfer-block-content`, `review/1-bug-reconcile-cannot-heal-two-node-cohort`,
  `review/1-bug-read-repair-unrepairable-small-cluster` — pre-existing, own the reconcile/read-repair
  limits this work depends on.
