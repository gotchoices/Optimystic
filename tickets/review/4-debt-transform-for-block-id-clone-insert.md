description: A shared helper that extracts one block's pending changes used to hand back part of the data by reference instead of copying it, silently risking corruption of the original staged data; it now copies consistently, and the ticket also cleaned up the workaround comments at the sites that previously worked around this.
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/test/transform.spec.ts, docs/internals.md
difficulty: easy
----

# `transformForBlockId` now clones `insert`, not just `updates` — implementation done, ready for review

## What changed

`transformForBlockId(transforms, blockId)` (`packages/db-core/src/transform/helpers.ts:106`) used to
deep-clone `updates` but return `insert` by reference, aliasing the caller's `Transforms.inserts[blockId]`.
Downstream, `applyTransform` (same file, `:140`) does `block = transform.insert` and then mutates `block` in
place via `applyOperations` when `updates` also ride along — so `block === transform.insert` got mutated,
which was really the caller's original staged insert being mutated underneath it.

Per the ticket's resolved design decision, the fix extends the existing clone rather than renaming the
function or pushing a clone-or-not decision onto callers: `transformForBlockId` now does
`insert: structuredClone(transform.inserts[blockId])`, mirroring the `updates` clone. The function's doc
comment now says both `insert` and `updates` are cloned.

### Files touched

1. **`packages/db-core/src/transform/helpers.ts`** — `transformForBlockId` now clones `insert`; doc comment
   updated.
2. **`docs/internals.md`** — "Transform Ownership" bullets and the "Common Pitfalls" → "1. Shallow Copy of
   Transforms" example both now describe `insert` as needing the same deep-clone treatment as `updates`.
3. **`packages/db-core/src/transform/tracker.ts`, `peekMaterialized`** — the now-redundant
   `transform.insert = structuredClone(transform.insert);` line (and its 3-line comment) was removed; this
   call site used the object `transformForBlockId` had just returned, once, never stored, so the helper's own
   clone now covers it.
4. **`packages/db-core/src/testing/test-transactor.ts`, `applyTransformSafe`** — the insert-clone here was
   kept **functionally unchanged** (it protects a different, still-live hazard: `Transform` values pulled out
   of `blockState.pendingActions`, a map that can be read more than once before a pending action is
   superseded — cloning once at `transformForBlockId` extraction time does not protect a value that is
   *stored* and mutated on a later, separate read). Only the doc comment changed, to attribute the need to
   that repeated-read hazard instead of to `transformForBlockId` not cloning `insert` (which is no longer
   true).
5. **`packages/db-p2p/src/storage/storage-repo.ts`, `previewCommitDigest`** — deliberately left untouched
   (verified, not just assumed): `transform` here comes from `storage.getPendingTransaction(actionId)`, never
   from `transformForBlockId`, so this guard was never about the bug this ticket fixes — it protects against
   mutating a value that may be backed by a live cache object. Its existing comment already describes that
   real, independent reason correctly.
6. **`packages/db-core/test/transform.spec.ts`** — added a regression test,
   `'should not let applyTransform mutating the extracted insert corrupt the original Transforms'`, right
   after the existing `'should create transform for specific block id'` case. It stages a `Transforms` with
   both `inserts['id1']` and `updates['id1']` set for the same block id (the exact shape that triggers the
   original bug — `applyTransform` sets `block = transform.insert` then splices `updates` into it in place),
   calls `transformForBlockId`, asserts the extracted `insert` is not the same object reference as the
   original, feeds the result through `applyTransform`, and then asserts the original
   `Transforms.inserts['id1']` is still deep-equal to a `structuredClone` snapshot taken before the call.

## How to validate

- `yarn workspace @optimystic/db-core build` — passes cleanly (verified).
- `yarn workspace @optimystic/db-core test` — **1643 passing**, including the new regression test and the
  full existing `transform.spec.ts`, `transform.property.spec.ts`, and `digest.spec.ts` suites, all
  unmodified except for the one new test (verified, ran the full suite, not just the new test file).
- `yarn workspace @optimystic/db-p2p test --grep "previewCommitDigest|pend|commit"` — **599 passing, 2
  pending** (the 2 pending were already pending before this change, unrelated to this ticket) — confirms no
  behavior change in `storage-repo.ts`'s pend/commit/previewCommitDigest paths (verified).
- Existing tests in `digest.spec.ts` / `transform.property.spec.ts` that call `transformForBlockId` and then
  `applyTransform` all assert on `deep.equal` content, not reference identity, so the added clone doesn't
  change their outcomes — confirmed by the full suite passing.

## Known gaps / things the reviewer should double check

- **No new test exercises `test-transactor.ts`'s `applyTransformSafe` repeated-read scenario directly** (a
  pending action `get()`'d twice, or read then committed, verifying the second read isn't corrupted by the
  first's `applyTransform` call). The ticket said this site's behavior must not change and its existing
  coverage should continue to pass unmodified — that held (full `db-core` suite green) — but I did not add a
  *new* test proving the repeated-read protection at that site independently still works; I relied on
  the fact that its logic is untouched (only the comment changed) plus green existing tests. If the reviewer
  wants stronger direct evidence for that site specifically, that's the gap.
- **Performance**: nobody has profiled the pend/commit hot path for the extra unconditional `structuredClone`
  on `insert`. The ticket explicitly says this is a non-issue for now (the same clone already happens at three
  call sites when it matters, and `pend`/`commit` already do network and storage I/O on this path) and that a
  future profiling-driven concern should be a `NOTE:` tripwire rather than blocking this fix. I did not add
  such a `NOTE:` in code since there's no evidence of a problem yet and the ticket didn't ask for one to be
  pre-emptively planted — flagging this here per the tripwire process in case the reviewer disagrees.
- **Comment wording in `tracker.ts`**: the ticket said to "delete the reassignment line and its comment"; I
  removed the reassignment but left one short line explaining why the clone is no longer needed there (so a
  future reader doesn't wonder if it was an oversight, and doesn't try to re-add it "defensively"). If the
  reviewer prefers strictly zero comment there, it's a one-line trim.
- Did not run the full monorepo test suite (`yarn test` at the root) — only `@optimystic/db-core` and the
  relevant slice of `@optimystic/db-p2p`, matching what the ticket's TODO list asked for. No other package
  imports `transformForBlockId` outside `db-core`/`db-p2p`, per the earlier `Grep` across the repo done during
  implementation (13 hits total, all accounted for: source call sites in `network-transactor.ts`,
  `tracker.ts`, `test-transactor.ts`, `storage-repo.ts`, `helpers.ts` itself; test files
  `transform.spec.ts`/`digest.spec.ts`/`transform.property.spec.ts`; and doc/ticket references).

## TODO (all items from the implement ticket — status)

- [x] `transformForBlockId`: deep-clone `insert`; doc comment updated.
- [x] `docs/internals.md`: "Transform Ownership" and "Shallow Copy of Transforms" pitfall now cover `insert`.
- [x] `tracker.ts` `peekMaterialized`: removed the now-redundant clone line (kept a short explanatory
      comment — see gap above).
- [x] `test-transactor.ts` `applyTransformSafe`: kept the insert-clone, rewrote its doc comment.
- [x] `storage-repo.ts` `previewCommitDigest`: confirmed untouched, correctly left alone.
- [x] Added the regression test in `transform.spec.ts`.
- [x] `yarn workspace @optimystic/db-core test` — full suite green (1643 passing).
- [x] `db-p2p` storage-repo tests touching `previewCommitDigest`/pend/commit — green (599 passing, 2
      pre-existing pending).
