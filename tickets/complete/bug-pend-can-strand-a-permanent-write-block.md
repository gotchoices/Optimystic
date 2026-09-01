description: A storage node could be left holding a leftover "write in progress" marker for a write that had already finished, which made the node refuse every future write to that block forever. Fixed, reviewed, and closed with one extra correction found during review.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-latch.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/block-latch.spec.ts, packages/db-p2p/test/mid-ddl-crash.spec.ts, docs/repository.md
difficulty: medium
----

# Complete — a pend can no longer write a pending record that could never be promoted

## What was wrong

A storage node records a "this write is coming" marker (a **pending record**) for each block a write
touches, and later promotes it into a real committed revision. Promotion at commit is the only thing
that removes a marker on the success path.

`StorageRepo.pend` used to read each block's current revision **unlatched**, then write the markers
afterwards under per-block latches. A commit landing in that gap was invisible to the decision that
had already run, so a marker got written for a revision that was already taken. Nothing then removes
it: the follow-on commit routes the block to `alreadyDone` (or refuses it as stale) and never
promotes, and `cancel` only follows a *failed* write. From then on the node reports that marker as a
conflicting in-flight action to every later writer of the block — under the fail-on-pending policy it
refuses those writes outright, forever, while still serving reads and looking healthy.

## What shipped

**Part 1 — `pend` classifies and saves under one multi-block latch hold.** `checkPendValidation`
(which can call a caller-supplied hook) stays outside the hold. `acquireBlockWriteLatches(blockIds)`
then wraps two passes: pass 1 does all the classification reads (`getLatest` → satisfied / stale /
pendable, plus `listPendingTransactions`), pass 2 writes the records. Every early return sits inside
the `try`, having written zero records; `finally { release() }` covers every path.

Two passes rather than one interleaved loop is deliberate: a single loop refused partway through
would leave records written for the earlier blocks, and retracting those under the hold could delete
a record an *earlier* pend of the same action legitimately left.

**Part 2 — the storage seam refuses an unpromotable record.** `savePendingTransaction` gained a
`rev: number | undefined` parameter on `IBlockStorage`/`BlockStorage` and throws the new
`PendRevisionTakenError` when `rev !== undefined && meta?.latest !== undefined && meta.latest.rev >= rev`.
It reuses the metadata read that method already performed, so it costs one comparison and no I/O.
The `>=` collapses both unpromotable cases (the writer's own already-committed revision, and a
rival's win), which is why it is not an `isOwnRevision` check.

**Part 3 (added in review) — a stale block is refused on staleness, not on what can be enumerated.**
See finding 1 below.

## Review findings

Reviewed the implement diff (`d0db0a6b`) directly before reading its handoff. Correctness of the
two-pass hold, latch re-entrancy and deadlock freedom, resource cleanup, error paths, docs accuracy,
test quality, source hygiene, exports, and the `mid-ddl-crash` behaviour change were all examined.

### Fixed inline (minor)

1. **`pend` could throw `PendRevisionTakenError` at its caller instead of returning a stale
   conflict.** Pass 1 decides staleness from `latest`, but its refusal was gated on `missing.length`
   — the *catch-up list* built by a separate walk of the revision index. Those can disagree: a block
   whose index is sparse over `[request.rev, latest.rev]` enumerates nothing while still having lost
   the race. Such a block passed classification and reached pass 2, where the new Part-2 seam
   refused it — so the loser got an unhandled `PendRevisionTakenError` rather than a
   `{ conflict: true, staleAt }` result, on every pend of that block. `commit` already takes the
   other position at the identical fork ("Push, even if transforms is empty, because we want to
   reject the older version"), so `pend` and `commit` had drifted apart on the same question.
   Fixed by counting stale blocks explicitly (`staleCount`) and gating the refusal on that.
   **Repro verified both ways**: the new test throws against the pre-fix gate and passes after.
   This also makes the implement ticket's own claim true — the seam error is now genuinely
   unreachable from `pend` by construction, which it was not before. Regression test:
   `storage-repo.spec.ts`, describe *"a stale block is refused even when nothing can be enumerated
   for it"*.
2. **Shadowed identifier.** Inside pass 1, `const transforms = await asyncIteratorToArray(...)`
   shadowed the enclosing `const transforms = transformForBlockId(...)`. Renamed to
   `missedRevisions`.
3. **Tripwire wording.** The latch-hold `NOTE:` named only the policy-`'r'` arm as the width-scaling
   cost inside the hold. Pass 2 now awaits its saves one block at a time where the pre-latch code
   fanned out with `Promise.all`, which scales the same way. Extended the NOTE at the acquisition
   site to name both, and to record *why* sequential is the deliberate choice (a throw mid-pass
   strands records for fewer blocks, not more) so a future optimizer does not undo it blind.

### Added — test at the seam that owns the property (architecture rung: boundary invariant)

`acquireBlockWriteLatches` is the single module that keeps all three multi-latch holders
(`pend`, `commit`, `applyInvalidation`) free of deadlock, and this ticket made `pend` the third one
— yet the module had **no direct test**; its three documented obligations were only exercised
incidentally through `StorageRepo`. Rather than testing the pend-vs-`applyInvalidation` pair the
implement handoff flagged as reasoning-only, added `packages/db-p2p/test/block-latch.spec.ts`
(7 tests) at the seam itself, which covers that pair and any fourth caller at once: dedup of
repeated ids, one global acquisition order (two concurrent opposite-order holds), whole-set mutual
exclusion against a single-block acquirer, interleaving with `withBlockWriteLatch`, release freeing
every latch and expiring every token, the empty set, and release idempotence. Two of them were
confirmed to fail when the `sort()` / `new Set()` is removed, so they are not vacuous. The
release-what-was-taken-on-partial-failure arm stays untested — there is no seam to inject a failing
`Latches.acquire`.

### Major findings — none

No finding warranted a new `fix/`, `plan/`, or `backlog/` ticket. The implement handoff's honest-gaps
list was worked through item by item and each was either verified adequate, covered by the new
latch spec, or already tracked:

- *Deadlock with `applyInvalidation` had reasoning only* — now covered generically by the new
  `block-latch.spec.ts`, which tests the property where it lives.
- *Duplicate block ids untested* — confirmed unrepresentable: `blockIdsForTransforms` builds through
  a `Set` (`packages/db-core/src/transform/helpers.ts:46`).
- *`mid-ddl-crash` Crash-B assertions rewritten for the sequential save* — reviewed and correct; no
  other test or production caller depends on the old concurrent fan-out (searched all
  `savePendingTransaction` call sites). Recorded as a tripwire instead (finding 3 above).
- *`PendRevisionTakenError` unreachable from `pend` by construction* — true only after finding 1 was
  fixed; now holds for every path into pass 2.
- *No mesh- or cluster-tier test* — `ClusterMember.validatePendOperations` is unchanged and the fix
  sits entirely below it; all existing cluster tests pass. Not a defect.
- *Residual stranding (client dies between a stale pend and its `cancel`)* — pre-existing and
  already tracked by `backlog/debt-unpromotable-pending-records-need-a-sweep`; not re-filed.
- *Partially-overlapping pends see an approximate rival-pending picture* — pre-existing conservative
  behaviour, documented at the site, unchanged by this work.

### Tripwires — one, extended in place

The latch-hold-width `NOTE:` in `storage-repo.ts` at the `acquireBlockWriteLatches` call (see finding
3). No new tripwires; no accepted-tradeoff `NOTE:` at any finding's site had to be respected or
revisited.

### Docs

Read every file the change touched. `docs/repository.md` Invariant P, the
`IBlockStorage.savePendingTransaction` / `promotePendingTransaction` doc blocks, and the
`block-latch.ts` header all describe the shipped behaviour accurately — including the "unreachable
from `pend`" claim, which finding 1's fix makes true rather than aspirational. `storage-repo.ts` is
1448 lines; large, but unchanged in character by this work and not a finding of this ticket.

## Validation

Run after the review edits, from the repo root:

- `yarn lint` — clean.
- `yarn build` then `yarn typecheck` — both clean.
- `yarn workspace @optimystic/db-p2p test` — **2434 passing, 0 failing** (2426 at handoff, plus the
  8 tests added in review).
- `@optimystic/db-core` 1459 passing; `@optimystic/quereus-plugin-optimystic` 690 passing + smoke;
  `-storage-fs` 76; `-storage-ns` 58; `-storage-rn` 53 — all clean.

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not written.
