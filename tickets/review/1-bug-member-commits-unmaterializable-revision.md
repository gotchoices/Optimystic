----
description: A node could accept an update to a piece of data it had never received, leaving it holding a version it could not reconstruct — the data became unreadable there, unavailable to other nodes, and every later change to it was rejected. It now refuses the update and pulls the missing data from a peer instead.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/cluster-consensus-divergence.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/internals.md, docs/transactions.md
----

# Review: a member must never record a revision it cannot materialize

## What was wrong

`StorageRepo.internalCommit` computed `applyTransform(priorBlock, transform)` and then:

```ts
if (newBlock) { await storage.saveMaterializedBlock(actionId, newBlock); }
…
await storage.setLatest({ actionId, rev });   // ← ran unconditionally
```

`applyTransform` only applies `updates` `if (block && …)`. A member that held the *pend* for
revision N but had never seen the revision that **created** the block therefore materialized
nothing, yet still advanced `latest` to N. Three observed consequences, all from the Sereus
embedder's trace:

1. `materializeBlock` throws `Failed to find materialized block … for revision N` on every
   local read of that block — permanently.
2. `SyncService.buildArchive` returns undefined, so the node cannot serve the block; readers
   see `cluster-fetch:no-quorum { responders: 0 }` even though it answered in 5 ms.
3. The throw happens inside `ClusterMember.validatePendOperations`, so the node rejects every
   later pend for the block → `cluster-tx:supermajority-failed`.

No self-healing path existed. The commit-path reconcile (`reconcileBlock`) only fires when
`StorageRepo.commit` *throws* "Pending action … not found" — and this member **did** have the
pending, so that branch never ran.

## The design decision: refuse-and-heal, not fetch-then-commit

**Chosen: refuse-and-heal.** The commit is refused with a distinct, greppable reason; the
existing `ClusterMember` reconcile path then pulls the committed revision from a cohort peer.

The deciding argument is **re-entrancy**, which the source ticket flagged as the likeliest way
to break the suite — and it is worse than a test hazard, it is a design constraint:

- `StorageRepo.commit` holds `Latches.acquire(commitLatchKey(blockId))` for every block in the
  batch, for the whole critical section.
- The only proven base-fetch path is `reconcileBlock` → `fetchArchiveFromPeer` →
  `storageRepo.saveReplicatedBlock`, and `saveReplicatedBlock` acquires **that same latch**.
- So fetch-then-commit would self-deadlock on the first block it healed. Making it work would
  mean either a second, latch-free persist path (duplicating `saveReplica`'s monotonic guard and
  its serialization against concurrent commits — exactly the class of bug `50af693`'s
  predecessors kept producing), or restructuring `commit` to release and re-acquire mid-batch
  (which breaks the "all blocks commit atomically under held locks" property the batch relies
  on).

Refuse-and-heal needs neither: `applyConsensusOperation` calls `reconcileDivergentCommit`
**after** `commit()` has returned and released its latches, which is where the existing
missing-pend heal already runs. The ticket's requirement to "verify that something actually
triggers reconcile, rather than assuming it" is satisfied structurally — the refusal is routed
into that call site directly, and pinned by a spec that asserts the reconcile callback fired and
the block converged.

**Tradeoff accepted:** the write that triggered the refusal does **not** land on this member.
The transaction still succeeds cluster-wide (consensus was already reached; a member's local
divergence is tolerated, never thrown — that is pre-existing policy and load-bearing, since
throwing resets the cluster stream). The member converges via the reconcile pull, so it holds the
committed revision by the time that call returns — just by replication rather than by replay.

**Residual risk, stated plainly:**

- **If the reconcile pull fails, the member simply does not have the block.** No peer reachable,
  no rev quorum, no content quorum, or a 5 s `ReconcileTimeoutMs` — any of these leaves the block
  absent locally. That is strictly better than the wedge it replaces (absent is readable-as-empty,
  serviceable by other cohort members, and repairable by the next write or a churn/rebalance
  pass), but it is **not** guaranteed convergence. Pinned by
  `"leaves the block absent — never at an unmaterializable rev — when the heal cannot run"`.
- **Reconcile inherits read-repair's trust model.** It requires a quorum-corroborated
  `(rev, actionId)` *and* a byte-identical content quorum (`selectQuorumBlock`, no
  single-responder relaxation). In a two-member cohort there is no second block-carrier, so
  reconcile declines and the block stays absent. Unchanged by this ticket, and the same limitation
  `1-bug-read-repair-unrepairable-small-cluster` already recorded.
- **Orphaned pendings on sibling blocks.** `commit()` breaks out of its per-block loop on the
  first failure. The refusing block's own pending is deleted (see below), but blocks *after* it in
  the batch keep theirs while reconcile advances their `latest` past them, so those pendings can
  never be promoted. This is a pre-existing property of every divergence path (the "ahead" path
  leaves the same orphan) and is not made worse here, but it is real cruft. See "What a reviewer
  should attack".

## What was built

### 1. The invariant, in `StorageRepo.internalCommit`

```ts
if (!newBlock && latest === undefined) {
    return await this.refuseMissingBase(blockId, actionId, rev, storage,
        'no committed revision to apply the transform to');
}
```

`latest === undefined` is the exact wedge condition, and the reasoning matters for review:
`materializeBlock` walks revisions **descending** from the target and needs *some* materialization
at or below it. With a prior `latest`, an absent `newBlock` is a legitimate **tombstone** — the
walk resolves to an earlier materialization and reads back as `undefined`, which is correct. Only
the block's *first* revision must carry a materialization.

**Deliberately NOT enforced: `latest.rev === rev - 1`.** The source ticket's phrasing ("absent, or
older than N−1") assumes per-block contiguous revisions. It is not how this system numbers them:
`Collection.getNextRev()` allocates per **collection**, and a block records a revision only when an
action touches it. Local rev 1 → commit rev 7 is routine, not a gap to heal. Enforcing N−1 would
reject virtually every legitimate commit. The arbitrary-gap case the ticket asked for is therefore
covered by asserting the *opposite*: a held base makes any forward rev committable
(`"commits across an arbitrary revision gap when a base IS held"`).

### 2. A distinct, greppable refusal

`MISSING_BASE_REVISION_REASON = 'missing-base-revision'` + `MissingBaseRevisionError` +
`isMissingBaseRevisionFailure(result)`, all exported from `storage/storage-repo.ts`.

The marker is a **string prefix on `StaleFailure.reason`**, not only a class, because
`StorageRepo.commit` converts a per-block throw into `reason: err.message` — the class identity is
gone by the time `ClusterMember` inspects the `CommitResult`, and `reason` also crosses the wire.
This mirrors the existing `isMissingPendingActionError` precedent rather than inventing a second
convention.

`refuseMissingBase` **deletes the block's pending** before throwing. It can never be promoted here:
promotion needs a base obtained out-of-band, and once reconcile lands rev N, `latest >= rev`, so a
commit retry partitions the block as already-done/stale and never revisits it. Leaving it would make
`pend` report a phantom conflicting action for every later write to that block (fatal under
`policy: 'f'`). Nothing durable is written before the throw, so the block is left exactly as it was
minus that pending record.

### 3. Wedged-`latest` recovery (beyond the ticket, same defect class)

`readCommitBase` wraps the `getBlock(latest.rev)` that fetches the base. A node **already** wedged
by the old code makes that call *throw*, which previously became a bare-reason `CommitResult` →
`ClusterMember` rethrew → executed-marker rollback → cluster stream reset. It is now translated
into the same `MissingBaseRevisionError`, so an already-wedged node self-heals on the next write
touching the block instead of poisoning the stream. Pinned by
`"refuses rather than throwing opaquely when latest itself is unmaterializable"`.

### 4. Routing the refusal into the existing heal (`cluster-repo.ts`)

`applyConsensusOperation`'s commit branch gains a third disposition between "ahead/stale → tolerate"
and "bare reason → propagate":

```ts
if (isMissingBaseRevisionFailure(result)) {
    log('cluster-member:consensus-commit-diverged', { …, divergence: 'behind', reason });
    await this.reconcileDivergentCommit(record, commit);
    return;
}
```

Genuine faults still propagate — `"propagates a genuine commit failure returned as success:false +
reason (no missing)"` is unchanged and still green.

### 5. The read path does not throw the refusal (`StorageRepo.get`)

`get()`'s context-driven promotion loop calls the same `internalCommit`. It now catches
`MissingBaseRevisionError` (and **only** that — everything else rethrows), logs
`get:promote-skipped-missing-base`, and abandons promotion for that block: every later context
revision builds on the one that just failed, so none of them can land either.

### 6. Secondary defect 1 — `cluster-fetch:synced` told the truth

`CoordinatorRepo.fetchBlockFromCluster` now reads back the revision after the restore attempt and
logs `cluster-fetch:synced` only when `latest` actually advanced, otherwise
`cluster-fetch:not-restored` with both revs. This is the line that produced 222 false "synced"
entries in one trace and misdirected the investigation for two sessions.

`markBlocksSeen` is **deliberately left unconditional** — the cohort did answer, so the block's
freshness *was* checked, which is what the read-repair window tracks. Dropping it would make every
read of a stale block re-poll the cohort for as long as the content-transfer gap exists (a real
chattiness regression, for no convergence benefit). The judgement is recorded as a `NOTE:` at the
site and as a TODO on `read-repair-cannot-transfer-block-content`, which owns the transfer.

### 7. Secondary defect 2 — documented, not fixed (deliberate; the ticket permitted either)

`BlockStorage.getBlock` returns `undefined` for a block with no local metadata *before*
`ensureRevision` can reach `restoreCallback`, so the read path can never acquire a never-seen block.
The early return now says this is deliberate and why: **the ticket's own edge-case list forbids the
alternative** ("a node asked for a block that genuinely does not exist anywhere must still return
absent cheaply. Do not turn every miss into a network fetch") — and an insert probing for an id
collision is exactly that common case.

`read-repair-cannot-transfer-block-content` was **kept, not deleted** — this work does not supersede
it. That ticket still owns the stale-node transfer, the `meta.latest` advance, the content-trust
gate, the mesh-harness fake, and the `KNOWN GAP` spec inversion. It was updated to absorb secondary
defect 2 (the never-seen-block edge case is now a *decided* constraint on its solution, not an open
question), to record that its acceptance test can now trust `cluster-fetch:synced`, and to add one
newly-found edge case (below).

## Newly discovered, not fixed here

**A pending-only block asked for an explicit rev throws instead of reading as absent.** When
metadata exists solely because `savePendingTransaction` seeded it (`latest === undefined`,
`ranges: []`), `getBlock(rev)` reaches `ensureRevision`, which throws
`revision N not found during restore attempt` if the restore yields nothing.
`fetchBlockFromCluster` swallows it as `cluster-fetch:error`, so it is noise today rather than a
wedge — but any other `StorageRepo.get`-with-context caller sees a read *fail* where "absent" is the
honest answer. It is entangled with the `meta.ranges` semantics that
`read-repair-cannot-transfer-block-content` explicitly owns and flags as high blast radius, so it
was filed there rather than fixed opportunistically. It is visible in
`"read-driven promotion does not advance latest without a base"`, which asserts the invariant holds
and that the missing-base refusal does not escape, while tolerating that error.

## Validation

Baseline for `packages/db-p2p`, on the tree before these edits:

```
$ cd packages/db-p2p && yarn test
  1333 passing (45s)
  41 pending
```

After:

```
$ cd packages/db-p2p && yarn test
  1345 passing (52s)
  41 pending
```

+12 specs, 0 failing, nothing skipped, disabled or loosened.

```
$ cd packages/db-p2p && yarn test:verbose --grep "missing base revision"
  StorageRepo
    commit — missing base revision (latest never outruns materialization)
      ✔ refuses a forward transform when the block has no committed revision
      ✔ leaves latest unset and the block readable-as-absent after the refusal
      ✔ refuses a delete with no base (it would leave nothing to reverse-apply from)
      ✔ drops the unusable pending so it cannot block later writes to the block
      ✔ does NOT refuse an insert with no prior revision (the normal create path)
      ✔ commits across an arbitrary revision gap when a base IS held
      ✔ refuses rather than throwing opaquely when latest itself is unmaterializable
      ✔ read-driven promotion does not advance latest without a base
      ✔ converges once the block arrives out-of-band, and then accepts later writes
  9 passing (42ms)

$ yarn test:verbose --grep "ClusterMember consensus-execution divergence"
  ✔ does NOT throw when committing an action it never pended (member behind / cohort drift)
  ✔ does NOT throw when committing a revision it is already ahead of (stale / prior-spec state)
  ✔ still commits normally when the pending action IS present (no false tolerance)
  ✔ still propagates genuinely unexpected storage faults (not a blanket swallow)
  ✔ pend-phase consensus tolerates a stale pend without throwing (member ahead)
  ✔ reconciles the committed rev from a cohort peer when behind (under-replication restored)
  ✔ refuses and heals when it saw the pend but never the creating revision
  ✔ leaves the block absent — never at an unmaterializable rev — when the heal cannot run
  ✔ tolerates a reconcile callback that throws (best-effort: never resets the stream)
  ✔ does NOT reconcile downward when the member is already ahead of the committed rev
  ✔ propagates a genuine commit failure returned as success:false + reason (no missing)
  11 passing (76ms)

$ yarn test:verbose --grep "CONTENT convergence"
  ✔ sanity: the two nodes really are diverged before the read
  ✔ selects the peer's newer revision (the fix in this ticket)
  ✔ logs cluster-fetch:synced only when the block actually advanced
  ✔ KNOWN GAP: does NOT converge the block content or the latest pointer
  4 passing (60ms)

$ cd packages/db-p2p && yarn test:integration
  27 passing (11s)
  2 pending

$ cd ../.. && yarn test        # root fan-out, every package → 0 failing
$ yarn lint                    → exit 0
$ yarn build                   → exit 0
```

## Test changes, itemised

Added (12):

- `storage-repo.spec.ts` → new `commit — missing base revision` suite, 9 specs. Covers the
  invariant directly, the delete-with-no-base variant, pending cleanup, the no-false-refusal
  control, the arbitrary-gap control, wedged-`latest` translation, the read path, and the full
  refuse → heal → accept-later-writes cycle.
- `cluster-consensus-divergence.spec.ts` → 2 specs: the two-node scenario from the trace (member
  saw the pend, missed the creating revision) asserting the reconcile fired, the block converged
  with real content, and a subsequent pend is accepted; plus the no-callback case asserting the
  block stays absent rather than wedged.
- `coordinator-repo-read-repair-content.spec.ts` → 1 spec: `cluster-fetch:synced` fires when the
  restore genuinely advances the node (positive control for the outcome logging).

Changed (2 — both because they asserted the log line this ticket was asked to correct, **not**
loosened):

- `coordinator-repo-read-repair-content.spec.ts` → `"selects the peer's newer revision"` asserted
  `cluster-fetch:synced` at rev 2 while the very next spec (`KNOWN GAP`) asserts nothing converged.
  It now asserts `synced` is **absent** and `not-restored` is present — this is precisely the
  ticket's testing bullet "assert `cluster-fetch:synced` is absent when nothing was restored".
- `coordinator-repo-read-repair.spec.ts` → `makePresentStorageRepo`'s held revision is now mutable
  and advances when a restoration context names a newer committed rev, modelling a repo whose
  restore lands. A stub frozen at its initial rev would report every restoration as a failure and
  would have made the positive `synced` assertion in `"adopts the newer rev the only other peer
  reports"` unfalsifiable. The other three `cluster-fetch:synced` assertions in that file are
  negative cases where no restore call happens at all; unaffected.

## Edge cases from the source ticket — dispositions

| Case | Where covered |
|---|---|
| Legitimately absent blocks stay cheap (no fetch on every miss) | `block-storage.ts` early return, now documented as deliberate; no new network call added on any read path |
| Base fetch fails / no peer has it | `"leaves the block absent — never at an unmaterializable rev — when the heal cannot run"` + `"tolerates a reconcile callback that throws"` (pre-existing, still green). Nothing partial is written: the refusal throws before any durable write |
| Concurrent commits of N and N+1 out of order | Unchanged and already serialized: every `meta.latest` writer takes `commitLatchKey(blockId)`; the refusal runs *inside* that latch and writes nothing but the pending delete. `"keeps meta.latest monotonic … when a read-driven promotion races a commit"` (pre-existing) still green |
| Gap larger than one revision | `"commits across an arbitrary revision gap when a base IS held"` — and see the design note above: per-collection revision allocation makes gaps normal, so the N−1 rule the ticket suggested would be wrong |
| Self / solo cohort keeps working | `"does NOT refuse an insert with no prior revision"`: a solo node creates every block it holds, so `newBlock` is always defined at rev 1 and the refusal is unreachable. Whole suite + `coordinator-repo-solo-self-bypass.spec.ts` green |
| Re-entrancy / deadlock inside the commit path | Structurally avoided, not merely tested: no network call was added inside the commit latch. This is the reason refuse-and-heal was chosen — see the design section |

## What a reviewer should attack

- **Is `latest === undefined` the right predicate, or should it be `!newBlock && !priorBlock`?**
  The looser form would also refuse an update applied to a *deleted* block (prior `latest` present,
  `getBlock` → tombstone → `undefined`). I judged that case non-wedging (the descending walk still
  finds a materialization; the read returns `undefined` rather than throwing) and semantically
  nonsense that the cluster should not produce anyway — so it stays allowed. If a reviewer disagrees,
  the change is one clause, but it needs a spec for what "update a deleted block" should mean first.
- **Deleting the pending inside `refuseMissingBase`.** It fires on the read path too
  (`get()` → `internalCommit`), which is more aggressive than it looks: a context read arriving
  *before* the consensus commit would drop a pending that the commit then cannot find. That
  converges (the commit hits the missing-pend branch → the same reconcile), but it is a
  behaviour a reviewer should confirm they are happy with, not an obviously-forced choice.
- **Orphaned pendings on sibling blocks of a broken batch** (see residual risk). Worth deciding
  whether divergence paths should cancel the whole action's pendings on this member; that would be
  a new, broader behaviour and was deliberately not attempted here.
- **The string-prefix reason marker.** `isMissingBaseRevisionFailure` does
  `reason.startsWith('missing-base-revision')`. It matches the existing `isMissingPendingActionError`
  regex convention, but a structured discriminator on `StaleFailure` would be sturdier if this ever
  needs to survive re-wording or a non-JS peer.
- **The mutated read-repair stub.** `makePresentStorageRepo` now converges on a restore context.
  Confirm no spec in that file was relying on the frozen-rev behaviour for a *negative* assertion —
  I audited all four `cluster-fetch:synced` assertions and the outer
  `cluster-tx:read-repair-applied`/`-noop` logs (unasserted anywhere), but a second pass is cheap.
- **Reconcile's content quorum in a two-member cohort.** The heal this ticket depends on cannot
  complete when only one peer can carry the block (`selectQuorumBlock` has no single-responder
  relaxation). For the trace's exact two-node scenario, that means the refusal protects the node but
  the pull may still decline. Pre-existing, called out in
  `1-bug-read-repair-unrepairable-small-cluster`'s review, and arguably the next thing the embedder
  will hit.

## Docs

- `docs/internals.md` § cluster-consensus pitfalls — new bullet stating the
  `latest`-never-outruns-materialization invariant and the refusal contract; the divergence-split
  bullet now lists `missing-base-revision` as a third tolerated disposition; the reconcile bullet
  now records *why* reconciliation runs after `commit()` releases its latches (the deadlock that
  rules out fetch-then-commit).
- `docs/transactions.md` § "What a repair pass will and will not accept" — records that the read
  path never acquires a never-seen block and why, and that `cluster-fetch:synced` now means an
  actual advance while `cluster-fetch:not-restored` is the expected line for a node that never saw
  the action.
