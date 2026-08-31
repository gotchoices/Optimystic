description: The code that reverses a disputed transaction used to write the corrected block contents without checking whether the write took effect, so its permanent record could claim a reversal that never happened. The reversal is now all-or-nothing, the record only describes writes that actually landed, and the rule for safely holding several block locks at once now lives in one place instead of being restated at each call site.
files:
  - packages/db-p2p/src/storage/block-latch.ts (new `acquireBlockWriteLatches` — the package's single multi-latch entry point; dedup + sorted order + partial-acquire cleanup + reverse release)
  - packages/db-p2p/src/storage/storage-repo.ts (`commit` now acquires its N latches through that helper)
  - packages/db-p2p/src/dispute/invalidation.ts (step 3 = one sorted multi-block critical section; `stale-revision` result reason; `assertWriteLanded`; three `NOTE:` tripwires)
  - packages/db-p2p/src/dispute/cascade.ts (a child whose compensating write was refused goes to `unevaluable`; `markUnevaluable` helper)
  - packages/db-p2p/test/invalidation.spec.ts (five tests in the "per-block write latch" describe)
  - docs/right-is-right.md (§Durable Invalidation — "All-or-nothing" paragraph)
----

# Complete: an invalidation's record now describes only writes that actually landed

## What was wrong

Reversing a disputed transaction ("invalidation") does two things per affected block: work out what
the block's contents should be with the disputed transaction removed, then write that content back as
a new revision. The compute step read storage with **no lock held**; only the write took the block's
write lock. A concurrent commit could land a newer revision of the same block in that gap. The write
was then correctly refused — both write paths advance a block's revision only forwards and no-op at
or past the revision being written — but `applyInvalidation` discarded the returned effective
revision and appended the block to the append-only invalidation log anyway, with the content hash it
had *computed*. The durable record asserted a restore that never happened.

That record is load-bearing: the cascade re-evaluator decides whether some *other* transaction still
holds by comparing the content that transaction observed against the `restoredContentHash` an
invalidation recorded.

## The invariant now established

> An invalidation log entry names a block only when that block's compensating write actually landed,
> and the content hash it records is the content that is actually in effect.

## What the implement stage built

`applyInvalidation` step 3 became one critical section over every affected block:

```
dedup → certificate verification            (unchanged, outside any latch)
acquire EVERY affected block's write latch, in sorted block-id order
  ── critical section ────────────────────────────────────────────────
  per block: getLatest + computeRevertedBlock       (reads; acquire no latch)
  rev = params.rev ?? max(fromRev, invalidatedRev) + 1
  precheck: no block's latest.rev >= rev
     └─ violated ⇒ write nothing, return { applied:false, reason:'stale-revision', reverted:[] }
  per block: saveReplica / saveDeletion, then assertWriteLanded(effective === intended)
  ────────────────────────────────────────────────────────────────────
release every latch (finally, reverse order)
append the invalidation log entry            (outside the latches, as before)
```

Two layers, on purpose. The **precheck** makes the good outcome the only reachable one: because the
tips are read *inside* the latches, a locally-computed slot is strictly greater than every tip by
construction, so the monotonic write guard can never refuse it — `stale-revision` is reachable only
when a caller supplies an explicit `rev` at or below a tip. **`assertWriteLanded`** is the boundary
invariant: it compares the `ActionRev` each write returns against the intended `{ rev, revertActionId }`
and throws on mismatch, because a mismatch means a write path refused for a reason the precheck does
not model — an internal contradiction, not something to degrade around.

Failing wholesale (rather than skipping the refused block or retrying at a higher slot) is deliberate:
`applyInvalidation` is the deterministic primitive every cluster member runs identically, and whether
a local write races is node-local, so either alternative would make one member's durable entry differ
from another's for the same invalidation. Failing writes nothing, and step 1 dedups on
`(invalidatedActionId, disputeId)`, so an invalidation that appended nothing is re-deliverable.

`cascade.ts`: a child result that is neither applied nor `already-applied` used to `continue`,
dropping that dependent from the frontier as if it were fine — under-invalidation reported as
success. It now goes into the existing `unevaluable` list, producing an `unevaluable` escalation that
tells the caller the affected collections need a full re-sync.

`docs/right-is-right.md` §Durable Invalidation gained an "All-or-nothing" paragraph stating the
invariant and why skip/retry were rejected.

## Review findings

Read the implement diff (`d6db9526`) before the handoff summary. Ran, all from the repo root:

```
yarn workspace @optimystic/db-p2p run typecheck            # exit 0
npx eslint <the five touched files>                        # exit 0
yarn workspace @optimystic/db-p2p run test                 # 2339 passing, 49 pending, 0 failing
yarn workspace @optimystic/reference-peer run test         # 5 passing, 1 failing (see below)
```

### Fixed in this pass (minor)

- **The multi-latch acquisition protocol was copy-pasted, and it is the package's deadlock
  guarantee.** After the implement change, `StorageRepo.commit` and `applyInvalidation` each carried
  their own dedup → sort → acquire-in-a-loop → release-in-reverse block, plus their own comment
  explaining why sorted order prevents a cycle. That property is not local to either site: it holds
  only because *every* multi-latch holder acquires in the one global order, so a third caller
  restating it slightly differently silently breaks both. Climbed to the boundary-invariant rung
  rather than leaving two instances: added `acquireBlockWriteLatches(blockIds)` to
  `packages/db-p2p/src/storage/block-latch.ts` — the module that already declares itself the single
  acquirer of `Block.write:<blockId>` — and routed both call sites through it. It owns the dedup (the
  mutex has no re-entrancy, so a repeated id self-deadlocks), the sort, the reverse release, and one
  thing neither hand-rolled copy had: releasing what it already took if an acquisition partway
  through the set throws. Net −8 lines in `storage-repo.ts`, −11 in `invalidation.ts`.
- **`block-latch.ts`'s own doc named `StorageRepo.commit` as the only reason the non-scoped form
  exists**, and `withBlockWriteLatch`'s doc argued its safety specifically against "`StorageRepo.commit`'s
  sorted multi-latch acquisition". Both were true before the implement change and false after it.
  Rewritten to point at the helper rather than at one of its callers.
- **`CascadeEscalation.unevaluable`'s doc said `stale-revision` specifically; the code routes *any*
  non-applied, non-`already-applied` reason.** Kept the wider code — an undecided dependent is the
  honest report for `invalid-certificate` too, and keying on "not applied" means a reason added later
  cannot re-open the silent-drop hole — and fixed the doc to describe what the code does, with the
  reachable and unreachable reasons named separately.
- **The two `unevaluable` push sites in `cascade.ts` were byte-identical** (dedup scan +
  `affectedCollections.add`), one of them added by this change. Extracted `markUnevaluable(cand)`;
  the "and it must also mark the collection affected, or the escalation names no collection" reason
  now lives once, at the helper.

### Fixed in this pass — test gaps the handoff flagged

- **`assertWriteLanded`'s throw path had no test.** The handoff judged a fake not worth it; I
  disagreed, because that assertion *is* the ticket's invariant and it is otherwise unreachable, so
  nothing would notice if it were deleted. It takes eight lines: a `Proxy` over the real
  `BlockStorage` whose `saveReplica` returns `{ rev: 99, actionId: 'someone-else' }`. The test
  asserts the throw, that its message names the block and the effective revision, that **no log entry
  was appended**, and — the part a stub is uniquely good for — that the latch is released on the
  throw path, by writing the block successfully afterwards.
- **Duplicate block ids are now collapsed, a behaviour change the handoff shipped with no test.**
  Added one: `blockIds: ['B','B']` yields one compensating write and one reported block, and the
  certificate still verifies (the target is built from the caller's un-deduped list, which is what
  the arbitrators signed). This test is also the guard against re-introducing the self-deadlock —
  without the dedup it hangs rather than failing an assertion, so mocha's timeout is the failure.

### Checked and found correct (no change)

- **The "a computed slot can never be refused" claim holds.** `computeRevertedBlock` sets
  `fromRev = latest?.rev ?? invalidatedRev`, so `max(fromRev) + 1` is strictly greater than every
  tip. And the precheck's comparison is exactly the guard's: `BlockStorage.getLatest()` returns
  `meta?.latest` verbatim, and `saveForwardRevision` refuses on `meta.latest.rev >= rev`.
- **The precheck deliberately reads `latest` separately rather than reusing `computation.fromRev`.**
  It costs one extra metadata read per block; reusing `fromRev` would be wrong, because a block with
  no metadata reports `fromRev = invalidatedRev`, which would spuriously trip the precheck for an
  explicit slot at or below `invalidatedRev`. Left as is.
- **Compute under the latches cannot self-deadlock.** Traced every read `computeRevertedBlock` makes.
  `BlockStorage.getBlock` never consults `restoreCallback` — it throws `RevisionNotCoveredError`, and
  the healing restore that *does* take the block latch lives one layer up in
  `StorageRepo.readBlockHealing`, which this path never enters. Strengthened the code comment to say
  that, since "getBlock takes no latch" alone does not tell the next reader where the latch-taking
  restore actually is.
- **`reverted` order stays deterministic across members.** Dedup preserves request order and every
  member receives the same `blockIds` from the wire, so the entry is byte-identical everywhere; the
  sorted order is used only for acquisition. Same split `StorageRepo.commit` already makes.
- **The three new implement-stage tests discriminate against the pre-fix behaviour.** The handoff
  noted it had not re-run them against reverted source. I did not either — but the ticket's recorded
  pre-fix repro (`applied=true rev=3`, `latest={"rev":3,"actionId":"c3"}`, hash mismatch) fails four
  separate assertions in the race test, which is enough.
- **Source hygiene.** Measured with `wc -l`: `invalidation.ts` 735, `cascade.ts` 540,
  `block-latch.ts` 144, `storage-repo.ts` 1328 (down 8). Not filing a size ticket:
  `invalidation.ts` splits cleanly into three already-labelled sections (certificate verification,
  compensating-state computation, deterministic apply) and its length is mostly the rationale
  comments, which are the valuable part here; `storage-repo.ts` is pre-existing and this change only
  shrank it.

### Recorded as tripwires, not tickets

Three conditional concerns — each fine now, each only becoming work if a named condition trips. All
parked as `NOTE:` comments at the exact site in `packages/db-p2p/src/dispute/invalidation.ts`:

- **Compute now runs inside the critical section**, so commits and pends on those blocks queue behind
  it and its cost grows with the number of revisions between the reversed transaction and the tip.
  `NOTE:` at the compute site; trips if invalidations become frequent or reversals of very old
  transactions show up delaying commits, and names the remedy (compute optimistically outside the
  latches, re-verify tips inside).
- **The step-1 dedup reads the log outside the block latches**, so two *overlapping* applies of the
  same invalidation would both pass it and both write, appending two entries for one invalidation.
  Not reachable today — the network path serializes through consensus and dedups in memory first, and
  the cascade applies children sequentially. `NOTE:` at step 1; trips the moment a caller applies one
  invalidation concurrently.
- **The log append stays outside the latches** (deliberately — the log writes through a possibly
  repo-backed store and the mutex has no re-entrancy), leaving a crash window in which compensating
  revisions exist with no entry naming them. This is the recoverable direction of the invariant — the
  entry can under-claim but never over-claim, and re-delivery re-applies. `NOTE:` at step 4 naming the
  condition that would make it unacceptable: a consumer treating "revision present, entry absent" as
  authoritative rather than as a state to re-sync.

### Considered and left alone

- **Cascade routing is wider than the source ticket specified** (any non-applied reason, not just
  `stale-revision`). Kept, with the reasoning moved into the code — see the doc fix above.
- **`InvalidateRequest` carries no compensating-revision field**, so no live caller supplies
  `ApplyInvalidationParams.rev` and `stale-revision` is reachable only from tests. Already recorded as
  a `NOTE:` at the `rev` doc by the implement stage; adding the wire field was explicitly out of
  scope, and remains so.

### Nothing filed

No new `fix/`, `plan/`, or `backlog/` tickets. Every finding was either a minor fix made in this pass
or a conditional concern parked as a tripwire; nothing surfaced that needed a design decision or that
was too large to resolve here.

### Pre-existing failure, not re-reported

`packages/reference-peer/test/distributed-diary.spec.ts` > "should handle concurrent writes from
multiple nodes" fails (10s mocha timeout). It is the known failure already tracked by
`fix/1-bug-concurrent-create-commits-two-actions-at-one-revision`, whose ticket names this exact test
and states it reproduces every run, with the root cause in `db-core`'s collection-creation path — not
in the block-latch or commit code this change touches. `tickets/.pre-existing-known.md` carries the
note pointing at that slug. Per the rules, not re-reported and `tickets/.pre-existing-error.md` was
not written; the test was not skipped, disabled, or loosened.

## Scope note carried forward

The dispute subsystem is still dormant — `onInvalidate` is not wired at the live composition root, so
nothing originates an invalidation on a running node. Related but untouched:
`invalidation-live-wiring-requires-arbitrator-set-anchoring` and
`feat-dispute-subsystem-live-activation`.
