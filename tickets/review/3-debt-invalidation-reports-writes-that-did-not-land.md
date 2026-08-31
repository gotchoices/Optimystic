description: The code that reverses a disputed transaction used to write the corrected block contents without checking whether the write took effect, so its permanent record could claim a reversal that never happened. The reversal is now all-or-nothing, and the record only describes writes that actually landed.
files:
  - packages/db-p2p/src/dispute/invalidation.ts (step 3 restructured into one sorted multi-block critical section; new `stale-revision` result reason; new `assertWriteLanded` helper; `ApplyInvalidationParams.rev` doc + NOTE)
  - packages/db-p2p/src/dispute/cascade.ts (a child whose compensating write was refused now goes to `unevaluable` instead of being silently dropped; `CascadeEscalation.unevaluable` doc widened)
  - packages/db-p2p/test/invalidation.spec.ts (three new tests at the end of the "per-block write latch" describe)
  - docs/right-is-right.md (§Durable Invalidation — new "All-or-nothing" paragraph)
difficulty: medium
----

# Review: an invalidation's record now describes only writes that actually landed

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

## What changed

**`applyInvalidation` step 3 is now one critical section over every affected block**
(`packages/db-p2p/src/dispute/invalidation.ts`), mirroring `StorageRepo.commit`:

```
dedup → certificate verification            (unchanged, outside any latch)
acquire EVERY affected block's write latch, sequentially, in sorted block-id order
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

Two layers, on purpose:

- The **precheck** is what makes the good outcome the only reachable one. Because the tips are now
  read *inside* the latches, a locally-computed slot is strictly greater than every tip by
  construction, so the monotonic write guard can never refuse it. `stale-revision` is therefore
  reachable only when a caller supplies an explicit `rev` at or below a tip.
- **`assertWriteLanded`** is the boundary invariant: it compares the `ActionRev` each write returns
  against the intended `{ rev, revertActionId }` and **throws** on mismatch. A mismatch means a write
  path refused for a reason the precheck does not model — an internal contradiction, not something to
  degrade around. `ClusterRepo.applyConsensusInvalidation` already tolerates a sink throw, logs it,
  and rolls back its dedup marker so a re-broadcast retries.

**Why failing wholesale rather than skipping or retrying at a higher slot:** `applyInvalidation` is
the deterministic primitive every cluster member runs identically. Whether a local write races is
node-local, so a skip or a per-node retry would make one member's durable entry differ from another's
for the same invalidation. Failing writes nothing, and step 1 dedups on
`(invalidatedActionId, disputeId)`, so an invalidation that appended nothing is simply re-deliverable.

**Cascade** (`cascade.ts`): a child result that is neither applied nor `already-applied` used to
`continue`, dropping that dependent from the frontier as if it were fine — under-invalidation
reported as success. It now goes into the existing `unevaluable` list, which produces an `unevaluable`
escalation telling the caller the affected collections need a full re-sync. (Note the scope choice
under "Deliberate deviations" below.)

**Docs**: `docs/right-is-right.md` §Durable Invalidation gained an "All-or-nothing" paragraph stating
the invariant and why skip/retry were rejected.

## The invariant this establishes

> An invalidation log entry names a block only when that block's compensating write actually landed,
> and the content hash it records is the content that is actually in effect.

## Validation

```
yarn workspace @optimystic/db-p2p run typecheck     # clean
yarn workspace @optimystic/db-p2p run build         # clean
yarn workspace @optimystic/db-p2p run test          # 2337 passing, 49 pending, 0 failing
```

Nothing pre-existing failed; `tickets/.pre-existing-error.md` was not written. The known
`reference-peer` diary failure (`bug-concurrent-create-commits-two-actions-at-one-revision`) is in a
different package and was not run or touched.

### New tests (end of the `per-block write latch (lost-update guard)` describe)

- **`reads tips under the latch: a commit that lands first shifts the slot, and the entry describes
  the write that landed`** — the ticket's reproduction, as a regression test. Seeds `B` at rev 1
  (`original`) and rev 2 (`tinv`), pends a competing `c3` at rev 3, holds the block's write key
  externally so acquisition order is fixed, starts `repo.commit(c3)` (queues first) then
  `applyInvalidation` with no explicit slot (queues behind it), releases. Asserts the commit lands,
  the invalidation lands at rev **4** (not the stale 3), `latest.actionId !== 'c3'`, the recorded
  `fromRev` is **3** (the tip read under the latch, not the stale 2), the recorded
  `restoredContentHash` equals `hashBlockContent` of the content actually stored, and the durable log
  entry carries the same blocks.
- **`refuses wholesale when an explicit slot is at or below a tip`** — two blocks, `X` at tip 2 and
  `Y` at tip 3, explicit `rev: 3`. Slot 3 is past `X`'s tip but not `Y`'s, so a per-block loop would
  have written `X` and had `Y` refused. Asserts `applied: false`, reason `stale-revision`, empty
  `reverted`, **neither** block advanced, no log entry — then that a retry at `rev: 4` applies and
  records both blocks.
- **`acquires multi-block latches in sorted order: … do not deadlock`** — a two-block commit and a
  two-block invalidation over the same pair, started concurrently with `Promise.all`, request orders
  deliberately differing (`['mb-a','mb-z']` vs `['mb-z','mb-a']`). Asserts both settle (a deadlock
  would hit the 10s mocha timeout), `latest` is monotonic on both blocks, and every reported
  `restoredContentHash` matches the content actually stored at the reported revision.

All pre-existing `applyInvalidation` tests pass unchanged, including both convergence tests and the
latch-contention test.

## Known gaps — please probe these

- **The race regression test asserts the post-fix shape, not a refusal.** The source ticket's TODO
  expected it to assert "no reversal reported, no entry appended" — but the fix makes refusal
  *unreachable* for a computed slot: reading the tip under the latch shifts the slot forward instead,
  and the write lands correctly. The test asserts that landed outcome. Its assertions do discriminate
  against the pre-fix behaviour — the ticket's own recorded pre-fix repro was `applied=true rev=3`,
  `latest={"rev":3,"actionId":"c3"}`, hash mismatch, every one of which fails these assertions — but I
  did **not** re-run the test against reverted source in this session to watch it go red. Worth doing
  if you want that confirmed.
- **`assertWriteLanded`'s throw path has no test.** It is unreachable through the public API by
  construction (the precheck covers every refusal the current write paths can produce), so exercising
  it needs a stub `IBlockStorage` whose `saveReplica` returns something other than the intended
  `ActionRev`. `BlockStorage` is the only implementation of `IBlockStorage` in the repo, so a stub
  would be test-only. I judged that not worth a fake; disagree freely.
- **Duplicate block ids are now collapsed, and that is a behaviour change with no test.** The latch
  loop dedups `blockIds` before acquiring, because `Latches` is a plain FIFO mutex with no
  re-entrancy and acquiring the same key twice in one loop would self-deadlock. Consequence: a caller
  passing the same block id twice now gets **one** `reverted` entry instead of two. The certificate
  target still uses the caller's `blockIds` verbatim (the arbitrators signed over that list, and
  `computeTargetHash` sorts but does not dedup), so certificate verification is unaffected. Whether
  duplicate ids can reach here from a real commit's `blockIds` is unverified — `StorageRepo.commit`
  dedups its own, which suggests the possibility is at least contemplated upstream.
- **Cascade routing is broader than the ticket asked.** The ticket said route `stale-revision` into
  `unevaluable`; I routed *any* non-applied, non-`already-applied` reason, which also captures
  `invalid-certificate`. That reason is documented as impossible on the child path (the child verifies
  the root proof against the root's target), and treating an undecided dependent as unevaluable is the
  safe direction — but it is a wider change than specified, and no cascade test exercises either
  rejection path today. If you would rather it be narrowed to `result.reason === 'stale-revision'`,
  that is a one-line change at `cascade.ts`.
- **Compute now runs while holding the latches.** `computeRevertedBlock` and the added `getLatest`
  reach storage only through `getLatest` / `listRevisions` / `getBlock` / `getTransaction`, none of
  which acquire a latch — verified against `BlockStorage`, the sole implementation. This is now a
  standing constraint: routing that compute through a healing read path (`StorageRepo.get` heals under
  the block latch) would self-deadlock. It is stated in the code comment; it is not enforced by a
  type or a test.
- **The stale comment the ticket flagged is rewritten, not merely deleted** — the old text claimed
  "invalidation never holds two block latches", which is now false. Check the replacement's deadlock
  argument reads correctly: every multi-latch holder in the package (`StorageRepo.commit` and now
  this) takes its keys in the one global sorted order, so there is no acquisition cycle.
- **The log append is still outside the latches**, deliberately — `ctx.log` writes through a
  `BlockStore` that may itself be repo-backed and `Latches` has no re-entrancy. The consequence is a
  window between the writes landing and the entry being appended; a crash there leaves compensating
  revisions with no entry. That window existed before this change and is unchanged by it, but it is
  worth a reviewer's eye given the ticket's subject is exactly "the record must match reality" — the
  asymmetry is now "the entry never over-claims, but it can still under-claim after a crash", which is
  the recoverable direction (dedup keys on the entry, so re-delivery re-applies).

## Tripwire recorded, not filed

`InvalidateRequest` (`packages/db-core/src/network/struct.ts`) carries **no** compensating-revision
field, so the network-facing apply path never supplies `ApplyInvalidationParams.rev` and every member
computes its own slot locally — yet that parameter's doc previously said "the consensus path passes
the agreed slot". Recorded as a `NOTE:` at the `rev` doc comment in `invalidation.ts`. Consequence
worth knowing: after this change the `stale-revision` path is reachable only from tests and from a
future caller that does pass an agreed slot. Adding the wire field was explicitly out of scope.

## Scope note carried forward

The dispute subsystem is still dormant — `onInvalidate` is not wired at the live composition root, so
nothing originates an invalidation on a running node. Related but untouched:
`invalidation-live-wiring-requires-arbitrator-set-anchoring` and
`feat-dispute-subsystem-live-activation`.
