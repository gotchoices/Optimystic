description: When a disputed transaction is reversed, the code writes the corrected block contents but never checks whether the write actually took effect — if a newer update landed first the write is silently skipped, yet the permanent record still claims the reversal happened. Make the reversal all-or-nothing so the record can only describe writes that really landed.
files:
  - packages/db-p2p/src/dispute/invalidation.ts:539-605 (applyInvalidation — steps 3 and 4: the per-block apply loop, the discarded return values, the `reverted` array, the log append)
  - packages/db-p2p/src/dispute/invalidation.ts:413-461 (computeRevertedBlock — the read-only compute that currently runs outside the write lock)
  - packages/db-p2p/src/dispute/invalidation.ts:518-523 (ApplyInvalidationResult — the `reason` union gains a new member)
  - packages/db-p2p/src/storage/i-block-storage.ts:118-156 (saveReplica / saveDeletion — both return the effective latest and are documented no-ops at or past that revision)
  - packages/db-p2p/src/storage/block-storage.ts:290-370 (saveForwardRevision — the monotonic guard that refuses the write)
  - packages/db-p2p/src/storage/block-latch.ts (acquireBlockWriteLatch / withBlockWriteLatch — the non-scoped form is what a multi-block hold needs)
  - packages/db-p2p/src/storage/storage-repo.ts:610-640 (StorageRepo.commit — the existing sorted multi-latch acquisition to copy)
  - packages/db-p2p/src/dispute/cascade.ts:349-380 (the cascade's applyInvalidation call and its handling of a non-applied result)
  - packages/db-p2p/test/invalidation.spec.ts (applyInvalidation suite + the "per-block write latch" describe — where the new tests belong)
  - docs/right-is-right.md:169-180 (§Durable Invalidation — the `reverted[]` claim this makes true)
difficulty: medium
repro: verified
----

# Make an invalidation's record describe only writes that actually landed

## The defect, in one paragraph

Reversing a disputed transaction ("invalidation") does two things per affected block: work out what
the block's contents *should* be with the disputed transaction removed, then write that content back
as a new revision. The first step reads storage with no lock held; only the second step takes the
block's write lock. Another writer can therefore commit a newer revision of the same block in the
gap. When that happens the compensating write is correctly refused — both write paths advance a
block's revision only forwards and do nothing when the block already sits at or past the revision
being written — and each returns the revision actually in effect so the caller can tell a real write
from a refused one. `applyInvalidation` discards that return value, then unconditionally records the
block, with the content hash it *computed*, into the append-only invalidation log. The log ends up
asserting a restore that never happened.

## Reproduced

Verified against `packages/db-p2p` at HEAD with a temporary spec (written, run, then removed — the
recipe is below so it can be recreated as a real regression test).

Seed block `B` through the real `StorageRepo` commit path: rev 1 = `original`, rev 2 = `tinv` (the
transaction to be reversed). Pend a competing action `c3` at rev 3. Take the block's write lock
directly (`Latches.acquire(blockWriteLatchKey(blockId))`) so acquisition order is controllable, start
`repo.commit` for `c3` (it queues first), then start `applyInvalidation` with no explicit `rev` — it
runs its whole read-only prefix, computes slot 3 from the tip it sees (2), and queues behind the
commit. Release. The commit lands rev 3; the invalidation's write is refused.

Observed:

```
applied= true rev= 3
latest after apply= {"rev":3,"actionId":"c3"}
content after apply= concurrent
reverted[0]= {"blockId":"repro-b","fromRev":2,"restoredContentHash":"bx_9LNaj2clRWxq6eIhrGhe5U164RnQ1YUGhkhfA6c4"}
actual content hash= 40gonMniECtAk3s4M3UlQFBzm6PIu4rettYVciJ4vGY
```

`applied: true`, a durable log entry appended, and a `restoredContentHash` for content that is not in
effect and never was. The revision named in the entry (`rev: 3`) belongs to `c3`, not to the
invalidation.

A second variant — passing an explicit `rev` that the block has already passed — refuses the write
the same way. Note that in that variant the recorded hash happened to *match* the actual content:
`computeRevertedBlock` replays surviving later actions onto the rolled-back base, so with a single
later action the recomputed content coincides with the current content. The hash mismatch is
therefore not universal; what is always wrong is the revision identity — `latest.actionId` stayed the
competing action's id, never the deterministic compensating-revision id the entry implies.

## Why it matters downstream

`reverted[]` is not bookkeeping. The cascade re-evaluator (`cascade.ts`) decides whether some *other*
transaction still holds by comparing the content that transaction observed against the
`restoredContentHash` an invalidation recorded. A hash describing content that is not in effect
propagates the error outward: dependents get reversed on the strength of a restore that did not
happen, or spared one that did. `docs/right-is-right.md` states the entry records "the compensating
revision each block received" — today that sentence can be false.

## The invariant to establish

> An invalidation log entry names a block only when that block's compensating write actually landed,
> and the content hash it records is the content that is actually in effect.

## The decision, settled

The source ticket left three candidate outcomes for a refused write open (skip the block, retry at a
higher revision, fail the whole invalidation). Research settles it as **fail the whole invalidation,
having written nothing** — reached by a precheck under the locks rather than by reacting to a
refusal. Reasoning, so it is not re-litigated:

- **Skipping the refused block is not viable.** `applyInvalidation` is the deterministic apply
  primitive every cluster member runs identically; whether a local write races is node-local, so a
  skip would make one member's durable log entry differ from another's for the same invalidation.
- **Retrying at a higher revision is not viable either.** The revision slot would then differ per
  member, and when a slot is supplied by the caller a retry silently disagrees with it.
- **Failing writes nothing and is retryable.** Step 1 of `applyInvalidation` deduplicates on
  `(invalidatedActionId, disputeId)` against the log, so an invalidation that appended nothing can
  simply be re-delivered. Under-reporting is recoverable; a false durable record is not.

But a refusal should not arise in the first place. Today's revision slot, when the caller supplies
none, is `max(tip over all affected blocks) + 1` — computed from tips read *outside* the locks. Read
those tips *inside* the locks and the slot is strictly greater than every tip by construction, so the
monotonic guard can never refuse. That makes the failure path reachable only when a caller supplies
an explicit `rev` at or below a current tip.

## Shape of the fix

Restructure step 3 of `applyInvalidation` into a single critical section over all affected blocks,
mirroring `StorageRepo.commit`:

```
acquire every affected block's write latch, in sorted block-id order, up front
  ── critical section ──────────────────────────────────────────────
  for each block: computeRevertedBlock (read-only; takes no latch)
  rev = params.rev ?? max(fromRev over all blocks, invalidatedRev) + 1
  PRECHECK: every block's latest.rev < rev
     └─ violated ⇒ write nothing, return { applied: false, reason: 'stale-revision', reverted: [] }
  for each block: saveReplica / saveDeletion, and ASSERT the returned
     effective ActionRev equals the intended { rev, revertActionId }
  ──────────────────────────────────────────────────────────────────
release every latch
append the invalidation log entry
```

Two layers on purpose: the precheck is what makes the good outcome the only reachable one, and the
returned-value assertion is the boundary invariant that catches any future write path that refuses
for a reason the precheck does not model. A failed assertion is an internal contradiction (a write
refused while its latch was held and its tip was checked), so it should throw rather than degrade —
`ClusterMember.applyConsensusInvalidation` already tolerates a sink throw, logs it, and rolls back
its dedup marker so a re-broadcast retries.

### Constraints the restructure must respect

- **Deadlock.** `StorageRepo.commit` acquires N block latches in sorted id order; `pend` and
  `saveReplicatedBlock` hold at most one at a time. Acquiring sorted here joins that discipline and
  introduces no cycle. The existing comment at `invalidation.ts:576-580` asserts the opposite
  ("invalidation never holds two block latches") and must be rewritten, not left to rot.
- **The log append stays outside the latches.** `ctx.log` writes through a `BlockStore` that may
  itself be repo-backed; `Latches` is a plain FIFO mutex with no re-entrancy, so appending under a
  block latch risks self-deadlock. It is outside today — keep it there.
- **Compute must stay latch-free internally.** `computeRevertedBlock` uses only `getLatest`,
  `listRevisions`, `getBlock`, `getTransaction`, none of which acquire a latch. Do not let it start
  calling a healing/restoring path (`StorageRepo.get` heals under the block latch) from inside the
  critical section.
- **Determinism is unchanged.** The compensating `actionId` derivation and the content computation
  stay byte-identical; only *when* the tips are read moves.

### Cascade handling of the new outcome

`cascade.ts:366` treats any non-applied, non-`already-applied` result as `continue` — the child is
dropped from the frontier and the cascade proceeds as if that dependent were fine. That is
under-invalidation reported as success. Route a `'stale-revision'` child into the existing
`unevaluable` list instead (`cascade.ts:330-334`), which already produces an `escalation` with reason
`'unevaluable'` and tells the caller the affected collections need a full re-sync. That is the
correct meaning: the cascade could not decide this dependent's fate.

## Scope note

The dispute subsystem is dormant — `onInvalidate` is never wired at the live composition root, so
nothing originates an invalidation on a running node today. This is still a real defect the moment
that changes, and the fix is small and self-contained. Related but distinct:
`invalidation-live-wiring-requires-arbitrator-set-anchoring` (verifying *who* authorized a reversal)
and `feat-dispute-subsystem-live-activation` (the activation itself). Neither touches the apply loop.

Also observed while researching, and worth a `NOTE:` comment rather than a ticket: `InvalidateRequest`
(`packages/db-core/src/network/struct.ts:153-164`) carries **no** revision field, so the
network-facing apply path never supplies one and every member computes its own slot locally — yet
`ApplyInvalidationParams.rev` is documented as "the consensus path passes the agreed slot". After
this change the explicit-`rev` failure path is reachable only from that as-yet-unwired caller and
from tests. Record the discrepancy at the `rev` doc comment; do not try to add the wire field here.

## TODO

- Restructure `applyInvalidation` step 3 into one sorted, multi-block critical section: acquire all
  affected blocks' write latches up front via `acquireBlockWriteLatch` in sorted id order, release
  them all in a `finally`.
- Move `computeRevertedBlock` for every block, and the `rev` computation, inside that section.
- Add the all-or-nothing precheck (`latest.rev < rev` for every block) before any write; on violation
  write nothing, append nothing, return `applied: false` with the new reason.
- Add `'stale-revision'` to `ApplyInvalidationResult.reason`, documented on the type.
- Capture the `ActionRev` returned by `saveReplica` / `saveDeletion` and assert it equals the intended
  `{ rev, revertActionId }`; throw on mismatch with a message naming block, intended and effective.
- Rewrite the stale comment at `invalidation.ts:576-580` to state the new sorted multi-latch
  discipline and why it cannot deadlock against `StorageRepo.commit`.
- Route a `'stale-revision'` child result in `cascade.ts` into the `unevaluable` list rather than the
  silent `continue`.
- Add a `NOTE:` at `ApplyInvalidationParams.rev` recording that `InvalidateRequest` carries no
  revision field today, so no live caller supplies one.
- Add the race regression test (recipe under "Reproduced" above) to the "per-block write latch"
  describe in `packages/db-p2p/test/invalidation.spec.ts`: assert the invalidation does **not** report
  a reversal it did not perform, that no invalidation entry was appended, and that the competing
  commit's revision stands untouched.
- Add a test for an explicit `rev` at or below the current tip: `applied: false`, reason
  `'stale-revision'`, no new revision on any block, no log entry.
- Add a multi-block test that a commit and an invalidation over the *same two* blocks interleave
  without deadlock and leave `latest` monotonic — the sorted-acquisition guarantee.
- Confirm the existing `applyInvalidation` tests still pass unchanged, especially the two convergence
  tests and the latch-contention test at `invalidation.spec.ts:723`.
- Update `docs/right-is-right.md` §Durable Invalidation to state the all-or-nothing rule: an entry is
  appended only when every affected block's compensating write landed.
- Run `yarn workspace @optimystic/db-p2p run test` and `yarn workspace @optimystic/db-p2p run typecheck`.
  Note: `packages/reference-peer/test/distributed-diary.spec.ts` > "should handle concurrent writes
  from multiple nodes" is a known pre-existing failure tracked by
  `bug-concurrent-create-commits-two-actions-at-one-revision` — do not chase or skip it.
