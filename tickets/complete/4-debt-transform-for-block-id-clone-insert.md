description: A shared helper that extracts one block's pending changes used to hand back part of the data by reference instead of copying it, silently risking corruption of the original staged data; it now copies consistently, and the workaround comments at the sites that previously worked around this were cleaned up.
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/test/transform.spec.ts, docs/internals.md
difficulty: easy
----

# `transformForBlockId` clones `insert` as well as `updates`

## Summary

`transformForBlockId(transforms, blockId)` (`packages/db-core/src/transform/helpers.ts`) used to deep-clone `updates` but return `insert` by reference. `applyTransform` adopts `transform.insert` as the block and then mutates it in place when `updates` ride along, so a caller could corrupt the original staged `Transforms.inserts[blockId]`. The helper now does `structuredClone` on `insert` too.

- `helpers.ts`: `insert` cloned; doc comment updated.
- `tracker.ts` `peekMaterialized`: removed the now-redundant local clone of `insert`.
- `test-transactor.ts` `applyTransformSafe`: kept its clone (it guards a different hazard: a `Transform` stored in `pendingActions` and read repeatedly); only the doc comment changed.
- `storage-repo.ts` `previewCommitDigest`: untouched. Its transform comes from `getPendingTransaction`, not this helper.
- `docs/internals.md`: "Transform Ownership" and "Shallow Copy of Transforms" pitfall now cover `insert`.
- `transform.spec.ts`: regression test with an insert plus updates for the same block, checking that `applyTransform` on the extracted transform leaves the original untouched.

## Review findings

**Checked (diff read first, then the handoff):**

- **Correctness of the fix.** The clone sits in the right spot. I checked every caller of `transformForBlockId`: `network-transactor.ts` pend batching, `storage-repo.ts` pend pass 1 (classify) and pass 2 (`savePendingTransaction`), `test-transactor.ts` pend conflict check and `pendingActions.set`, `tracker.ts` `peekMaterialized`, and the digest/property specs. None relies on the returned `insert` being the same object as the original, so the extra copy can only help. For example, pending transactions saved by `StorageRepo.pend` no longer share objects with the request payload.
- **Does the regression test actually catch the bug?** Yes, confirmed from the code. `applyOperation` with a non-array value does `block[entity] = structuredClone(inserted)`, so the `['data', 0, 0, 'mutated']` op assigns into the adopted block. With the old aliasing code, both the `not.equal` reference assertion and the `deep.equal` snapshot assertion would fail.
- **`test-transactor.ts` comment.** Accurate. `pend` stores the (now cloned) transform once in `pendingActions`. `get`, with either an action-id or a committed context, and `commit` each read it again. Without `applyTransformSafe`'s per-call clone, the first read would mutate the stored entry. The handoff notes that no new test covers this site directly. I declined to add one because the logic there didn't change, only the comment, and existing get/commit coverage passes. No ticket.
- **`storage-repo.ts` `previewCommitDigest`.** I agree it was out of scope; its guard is about cache-backed values from `getPendingTransaction`.
- **Docs.** `docs/internals.md` is the only doc that mentions `transformForBlockId`; I grepped every `.md`/`.ts` outside the touched source. No stale "clones updates but not insert" wording is left anywhere.
- **Type safety / error handling / resource cleanup.** Nothing applies: no signature changes, no new failure paths, nothing to release.

**Found and fixed inline (minor):**

- `docs/internals.md` "Shallow Copy of Transforms": the new **Bug** paragraph was hard-wrapped across three lines, which breaks the project's one-line-per-paragraph rule. Unwrapped.
- `tracker.ts` `peekMaterialized`: shortened the two-line leftover comment to one line. It still says why no clone is needed, so nobody re-adds one "defensively".

**Tripwire recorded:**

- The helper now clones `insert` even for callers that only read it, e.g. `StorageRepo.pend`'s classify pass, which only checks `transforms.insert` for truthiness. That means one extra copy per inserted block per pend. It isn't measured, and it's tiny next to the storage and network I/O on that path. Parked as a `NOTE:` on `transformForBlockId` in `helpers.ts`: if large inserts show up in a pend/commit profile, add a non-cloning variant for read-only callers.

**Major findings / new tickets:** none. The one class-level concern, callers depending on shared object references from transform helpers, is already handled for both copy helpers: `copyTransforms` and now `transformForBlockId` both deep-clone `inserts` and `updates`. The existing `transform.property.spec.ts` suite covers materialization equivalence.

**Validation (run in this review):**

- `yarn workspace @optimystic/db-core build`: clean.
- `npx eslint` on `helpers.ts`, `tracker.ts`, `test-transactor.ts`, `transform.spec.ts`: clean.
- `yarn workspace @optimystic/db-core test`: **1643 passing**, no failures.
- I did not re-run `db-p2p` tests. This review only changed a comment in `db-core` and the doc. The implement stage's `db-p2p` pend/commit/`previewCommitDigest` slice passed (599 passing, 2 pending, both already pending before this change).
