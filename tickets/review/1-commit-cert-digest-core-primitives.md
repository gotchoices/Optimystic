description: Review the first slice of the commit content-digest work — the core library can now hash a block's agreed content and compute, from staged local changes only, what each block will contain after commit.
files: packages/db-core/src/blocks/helpers.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/utility/lru-map.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/index.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-core/test/digest.spec.ts, packages/db-core/test/cache-source.spec.ts, packages/db-core/test/lru-map.spec.ts
----

# Commit content digest — part 1 of 3: core primitives (implemented, needs review)

Part 1 of the feature split from `commit-cert-bind-block-content-digest`. Parts 2 and 3
(`commit-cert-digest-threading`, `commit-cert-digest-member-check`) thread the digests through the
commit path and make members check them. This slice builds primitives only — **no behavior changes**
except that the canonical block-hash helper now lives in db-core instead of db-p2p.

## What was implemented

**Hash helper promoted to db-core.** `canonicalBlockHash` (and its private `canonicalJson`) moved
from `packages/db-p2p/src/cluster/quorum-restore.ts` to `packages/db-core/src/blocks/helpers.ts`,
exported via the existing blocks barrel → root index. No copy left behind: db-p2p's
`reconcile-block.ts` and `test/quorum-restore.spec.ts` now import it from `@optimystic/db-core`;
`quorum-restore.ts` itself never used it internally, so it just lost the export (doc comments
updated to plain-text references).

**Digest types** (`network/struct.ts`): `BlockContentDigest` (`digest` + optional `baseRev`, absent
for base-independent inserted blocks) and `BlockContentDigests` (per-id record, optional per id).
`blockDigests?: BlockContentDigests` added to `CommitRequest` (struct.ts) and `RepoCommitRequest`
(i-repo.ts). Nothing produces or consumes the field yet — that is part 2/3.

**Recency-neutral reads.** `LruMap.peek` (read without refreshing eviction order);
`CacheSource.peek` (cloned cached block, no source consult, no read-dependency record) and
`CacheSource.getCachedRevision` (the source-learned materialized revision from the `revisions` map —
deliberately NOT `state.latest.rev`).

**`Tracker.peekMaterialized(id)`**: what the block materializes to under staged transforms, computed
without loading from the source, plus the committed revision of the base used. Uses
`transformForBlockId` + the canonical `applyTransform` (same function the member side uses).
Insert → base-independent, no `baseRev`. Updates-only → probes the source for
`peek`/`getCachedRevision` (duck-typed, like the existing `getGeneration` probe); missing either →
`undefined`. Any staged delete → `undefined`. Clones before mutating (the staged insert is cloned
explicitly; `transformForBlockId` already clones updates; the base comes cloned from
`CacheSource.peek`).

**`computeBlockContentDigests(tracker, blockIds)`** (`transform/digest.ts`, new, in the transform
barrel): per id, `peekMaterialized` → skip on `undefined` → `canonicalBlockHash`, `baseRev` riding
along when present.

## Validation performed

`yarn build`, `yarn typecheck`, `yarn test` from the root — all green (full workspace suite,
including db-p2p with the moved helper; no pre-existing failures encountered). 16 new tests in
db-core (`test/digest.spec.ts` + additions to `cache-source.spec.ts`, `lru-map.spec.ts`):

- `LruMap.peek` / `CacheSource.peek` do not change eviction order (fill, peek oldest, insert, oldest
  still evicted); peek returns a clone.
- `computeBlockContentDigests`: insert → digest, no `baseRev`; update-only cached base → digest +
  `baseRev` = cached materialized revision; delete-only, update-then-delete, uncached base, and
  unstaged id → omitted; repeated passes deterministic.
- Client/member agreement (in-package half): digest equals
  `canonicalBlockHash(applyTransform(clonedBase, transformForBlockId(...)))` computed independently.
- Peek pass leaves tracker/cache state observably unchanged (`transforms` deep-equal,
  `getGeneration` stable, repeat `tryGet` identical); mutating a peeked block does not leak into the
  staged insert.

## Known gaps / notes for the reviewer

- **Dead field until parts 2–3 land**: `blockDigests` has no producer or consumer yet. The wire-path
  claim (generic cluster message hashing folds the field into every signature with no helper change)
  is from the investigation, restated in the field docs — it becomes testable in part 2.
- **`peekMaterialized` short-circuits on any staged delete** instead of calling `applyTransform` and
  observing `undefined`. Identical semantics (delete-last-wins) but it is a locally re-stated rule —
  check you agree it cannot drift.
- **The `peek` clone contract is duck-typed**: a source double exposing `peek` without cloning would
  let `applyTransform` mutate its cache. Documented at both ends; only CacheSource implements it
  today.
- **Cross-package agreement half untested**: equality against the member-side materialization in
  `StorageRepo.internalCommit` is part 3's test surface.
- Two `canonicalJson` implementations still exist in db-core (`cluster/membership.ts` private one,
  and the moved one in `blocks/helpers.ts`) — pre-existing duplication, unchanged in scope here; the
  block-hash one is now the single shared block hash, which is what the drift risk was about.
