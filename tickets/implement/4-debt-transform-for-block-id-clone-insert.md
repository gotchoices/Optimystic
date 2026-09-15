description: A shared helper that extracts one block's pending changes hands back part of the data by reference instead of copying it, so every caller has to remember to make its own copy before using it — three places already do this by hand, and the fourth that forgets will silently corrupt the original.
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/test/transform.spec.ts, docs/internals.md
difficulty: easy
----

# `transformForBlockId` should clone `insert`, not just `updates`

## Resolved design decision

`transformForBlockId(transforms, blockId)` (`packages/db-core/src/transform/helpers.ts:106`) deep-clones
`updates` but returns `insert` by reference, aliasing the caller's `Transforms.inserts[blockId]`. Downstream,
`applyTransform` (same file, `:138`) does `block = transform.insert` and then mutates `block` in place via
`applyOperations` when `updates` also ride along — so `block === transform.insert` gets mutated, which is
really the caller's original staged insert being mutated underneath it.

**Decision: extend the clone, don't rename the contract.** Make `transformForBlockId` deep-clone `insert`
exactly the way it already deep-clones `updates`, so the function's output is uniformly safe to hand to
`applyTransform` regardless of which fields are populated. The alternative considered — renaming the helper
(e.g. `transformForBlockIdUnsafe`) and pushing the clone-or-not decision onto every caller via type/name —
was rejected: it re-creates the exact hazard this ticket exists to retire (a convention a caller can forget),
just under a different name. The extra `structuredClone` cost lands only on `insert` (an object that already
gets deep-cloned at the three sites below every time it matters), and `pend`/`commit` are already doing
network and storage I/O on the same path, so one more clone is not the dominant cost. Nobody has profiled
this path; if it ever shows up in a profile, that is a `NOTE:` for a future ticket, not a reason to leave the
aliasing bug in place now.

## What to change

1. In `packages/db-core/src/transform/helpers.ts`, `transformForBlockId`: change
   `{ insert: transform.inserts[blockId] }` to `{ insert: structuredClone(transform.inserts[blockId]) }`,
   mirroring the existing `updates` clone. Update the function's doc comment (currently titled with the
   `@pitfall` about `updates` only) to say both `insert` and `updates` are cloned.

2. In `docs/internals.md`, section "Transform Ownership" (around line 667-670) and the "Common Pitfalls" →
   "1. Shallow Copy of Transforms" example (around line 1738): both currently describe only `updates` as the
   thing that must be deep-cloned. Extend both to say `transformForBlockId` deep-clones `insert` too, so the
   next reader doesn't re-derive the old half-true version.

## Which existing hand-written guards to touch, and which to leave alone

Three call sites independently guard against this today. **Do not remove all three uniformly** — only one of
them is actually rendered redundant by the fix above. The other two guard a *different*, still-live hazard:
`applyTransform` mutates its `transform.insert` argument in place, and both of those sites read a `Transform`
back out of a **map/storage that can be read again later** (a pending action can be `get()`'d more than once
before it commits, and the committed value is read again at commit time). Cloning once at extraction time
(inside `transformForBlockId`) does not protect a value that gets *stored* and then mutated on a later,
separate read — only a clone taken immediately before each `applyTransform` call does that. Conflating these
two hazards and deleting all three guards would silently reintroduce corruption on the second read of the
same pending action.

- **`packages/db-core/src/transform/tracker.ts`, `peekMaterialized`** (around line 145-158): the guard here
  — `transform.insert = structuredClone(transform.insert);` plus its 3-line comment — operates on the object
  `transformForBlockId` *just returned*, used once, never stored. This one **is** made fully redundant by the
  fix. Delete the reassignment line and its comment; `transformForBlockId`'s own clone now covers it.

- **`packages/db-core/src/testing/test-transactor.ts`, `applyTransformSafe`** (around line 793-807): this
  wrapper is called on `Transform` values pulled out of `blockState.pendingActions` (a `Map<ActionId,
  Transform>`), which is written once by `pend()` and can be read by `get()` multiple times and again by
  `commit()`. The insert-clone here is NOT redundant — keep it functionally as-is. Update its doc comment: it
  currently attributes the need to clone `insert` to `transformForBlockId` not cloning it; that's no longer
  true, so rewrite the comment to say the clone protects the *stored* `pendingActions` entry from the mutation
  `applyTransform` performs on `transform.insert`, since that entry can be read (and thus risk mutation) more
  than once before it is superseded.

- **`packages/db-p2p/src/storage/storage-repo.ts`, `previewCommitDigest`** (around line 1150-1189): `transform`
  comes from `storage.getPendingTransaction(actionId)`, not from `transformForBlockId` at all — this guard was
  never about the bug this ticket fixes, it's defense against mutating a value that may be backed by a cache
  returning a live object. Leave the `structuredClone(base)` / `structuredClone(transform)` calls exactly as
  they are; no comment change needed since the comment there already describes the real (independent) reason
  correctly (`applyTransform assigns transform.insert into the result by reference and applyOperations mutates
  the block in place, so materializing on live storage/pending objects would corrupt them for the real commit
  that follows`).

## Edge cases & interactions

- **Both `insert` and `updates` staged for the same block id.** This is the exact shape that triggers the bug:
  `applyTransform` sets `block = transform.insert`, then splices `updates` into `block` in place. Write the
  core regression test around this shape (see TODO below) — it's the one existing tests don't already cover
  directly for `transformForBlockId`'s return value.
- **`insert`-only and `updates`-only transforms.** Confirm the fix doesn't change behavior when only one of
  the two fields is present (`structuredClone(undefined)` is `undefined`, so the existing conditional spread
  `...(transform.inserts && blockId in transform.inserts ? { insert: ... } : {})` still omits the field
  correctly when there's no insert for that id).
- **Large/deeply-nested block content.** `structuredClone` on `insert` is the same cost already paid at the
  three hand-written sites for the sub-case they cover; this just makes it unconditional. No new failure mode,
  just a cost already paid elsewhere becoming uniform.
- **`tracker.ts` other callers of `transformForBlockId`.** Grep confirms `peekMaterialized` is the only
  `transformForBlockId` call in `tracker.ts` — verify no other spot in the file re-derives the same guard.
- **Test-transactor and storage-repo behavior must NOT change.** Since those two sites' guards stay
  functionally intact, their existing test coverage (if any exercises multi-read-of-pending-action paths)
  should continue to pass unmodified — this ticket only changes their comments, not their logic.

## TODO

- [ ] `transformForBlockId`: deep-clone `insert` (mirror the `updates` clone); update the function's doc
      comment.
- [ ] `docs/internals.md`: update "Transform Ownership" bullets and the "Shallow Copy of Transforms" pitfall
      example to cover `insert`, not just `updates`.
- [ ] `tracker.ts` `peekMaterialized`: remove the now-redundant `transform.insert = structuredClone(...)` line
      and its explanatory comment.
- [ ] `test-transactor.ts` `applyTransformSafe`: keep the insert-clone, rewrite its doc comment to attribute
      the need to "value may be read again from `pendingActions` before it's superseded," not to
      `transformForBlockId`.
- [ ] `storage-repo.ts` `previewCommitDigest`: no functional or comment change — confirm during review that it
      was correctly left alone.
- [ ] Add a regression test in `packages/db-core/test/transform.spec.ts` (near the existing "should create
      transform for specific block id" case at line 176): stage a `Transforms` with both `inserts[id]` and
      `updates[id]` set for the same block id, call `transformForBlockId`, feed the result to `applyTransform`,
      then assert the original `Transforms.inserts[id]` object is unchanged (e.g. compare against a
      `structuredClone` taken before the call, or assert referential/deep inequality with the mutated result).
- [ ] Run `yarn workspace @optimystic/db-core test` (or the project's equivalent) and confirm existing
      `transform.spec.ts`, `transform.property.spec.ts`, and `digest.spec.ts` suites still pass unmodified.
- [ ] Run any `db-p2p` storage-repo tests touching `previewCommitDigest` / pend / commit to confirm no
      behavior change there.
