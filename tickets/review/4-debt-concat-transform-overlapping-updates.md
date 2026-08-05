description: A helper that stitches block changes together used to throw away one side's edits when both sides touched the same block — fixed to match its sibling helper's already-landed fix.
prereq:
files: packages/db-core/src/transform/helpers.ts, packages/db-core/test/transform.spec.ts
difficulty: easy
----

## What changed

`concatTransform(transforms, blockId, transform)` in `packages/db-core/src/transform/helpers.ts` appends a single block's `Transform` onto an existing `Transforms`. It had a clobber bug: if `transforms.updates[blockId]` already held operations and the incoming `transform.updates` also targeted `blockId`, the object-spread replaced the existing ops array instead of concatenating — silent data loss. `deletes` could also accrue duplicate block ids.

Fixed to mirror the sibling helper `mergeTransforms` (fixed earlier in ticket `transform-merge-and-atomic-concurrency`):

- `updates`: when `blockId` already has ops in `transforms.updates`, the new result is `[...existingOps, ...transform.updates]` (order-preserving concat) instead of overwrite. When `blockId` has no existing ops, behavior is unchanged (just assigns).
- `deletes`: deduped via `new Set(...)` instead of raw concatenation.
- `inserts`: unchanged — still last-wins (intentional, matches `mergeTransforms`).

## Test changes

`packages/db-core/test/transform.spec.ts`: the test previously titled `'should silently drop operations when concatTransform overlaps existing updates (BUG: data loss)'` (around line 447, inside the `describe` block that scopes `sharedId`) documented the buggy clobber behavior. Retitled to `'concatTransform concatenates operations when it overlaps existing updates'` and flipped its assertion from "new ops replace old" to `expect(result.updates![sharedId]).to.deep.equal([...existingOps, ...newOps])`.

## Why this was dormant, not an active bug

Every current caller of `concatTransform` passes disjoint block ids per accumulator (one call per unique block id), so the overlapping-block-id path was never actually exercised in production:

- `packages/db-core/src/transactor/network-transactor.ts` `pend` → `transformForBlock`: iterates a set of distinct `consolidatedBlocks`.
- `packages/db-core/src/testing/test-transactor.ts`: accumulates one blockId per action per block-iteration.
- `packages/db-p2p/src/storage/storage-repo.ts` `perBlockActionTransformsToPerAction`: separately broken, tracked under ticket `bug-storage-repo-missing-transforms-empty` — not touched by this change.

No caller behavior changes as a result of this fix (confirmed: none currently feed overlapping block ids), but the trap that would silently drop data the moment a future caller does is now closed.

## Validation

- `cd packages/db-core && yarn build` — clean, no errors.
- `cd packages/db-core && yarn test` — 1349 passing, 0 failing (full suite, not just `transform.spec.ts`).
- Manually traced all 5 call sites of `concatTransform` across `db-core` and `db-p2p` (via grep) to confirm no caller currently supplies a repeated block id within one accumulation — see "why dormant" above.

## Gaps / things the reviewer should double check

- No new *dedicated* test was added for the `deletes` dedupe path in `concatTransform` (only `mergeTransforms` has an explicit dedupe test, at the `sharedId` delete-delete case around line 222). The updates-concat path has direct coverage (the retitled test); deletes-dedupe in `concatTransform` specifically does not. Low risk — same one-line pattern (`new Set(...)`) as the already-tested `mergeTransforms` path — but flagging since it wasn't asked for explicitly and I didn't add it to keep the diff to what the ticket specified.
- Did not touch `db-p2p/storage-repo.ts` — its `concatTransform` caller has its own separately-tracked bug (`bug-storage-repo-missing-transforms-empty`) and is out of scope here.
