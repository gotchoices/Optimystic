description: Review the new property-based tests for Tracker / copyTransforms / isTransformsEmpty / Transforms apply+merge semantics. New suite generalises the 5-chain insert+apply regression and several hand-picked cases into executable contract properties.
dependencies:
  - fast-check@^4.7.0 (added to packages/db-core/package.json devDependencies)
files:
  - packages/db-core/test/transform.property.spec.ts (new — all 15 property groups live here)
  - packages/db-core/package.json (fast-check devDependency added)
  - packages/db-core/test/transform.spec.ts (untouched; existing example-based suite)
  - packages/db-core/src/transform/helpers.ts
  - packages/db-core/src/transform/tracker.ts
  - packages/db-core/src/transform/atomic.ts
  - packages/db-core/src/transform/cache-source.ts
  - packages/db-core/src/blocks/helpers.ts
----

## What was built

New file `packages/db-core/test/transform.property.spec.ts` — a fast-check property suite exercising the Tracker / Transforms contract with a small bounded alphabet (5 block ids, 3 values, action sequences of length ≤ 12).

The suite is split into five describe-blocks:

- **helpers.ts round-trip invariants**
  - `isTransformsEmpty` is preserved under `copyTransforms`.
  - `copyTransforms` is deep-equal to the original AND independent — mutating every reachable corner of the copy (deletes array, updates arrays, inserts blocks' nested fields) leaves the original deep-equal to a pre-mutation baseline.
  - `applyTransformToStore(t, store1)` and `applyTransformToStore(copyTransforms(t), store2)` produce deep-equal store snapshots.

- **tracker.ts merge invariants**
  - Replay determinism: same action sequence → deep-equal `transforms`.
  - Snapshot-and-replay: `new Tracker(source, copyTransforms(t.transforms))` observes the same `tryGet` result for every id in the pool as the original tracker.
  - `insert(B)` + any updates → `transforms.updates[B.id]` stays undefined; the inserted block reflects all ops (in-place fold).
  - Same invariant under the `blocks/helpers.ts:apply` pattern used by `Chain.open` (the motivating 5-chain case).

- **tracker.ts deletion-after-insert edges** (pinned examples)
  - `insert(B); delete(B)` → snapshot → fresh tracker tryGet is undefined.
  - Source-backed `update(B); delete(B)` → snapshot → fresh tracker tryGet is undefined.
  - `insert + apply + delete` → delete wins (documents the contract).

- **atomic.ts wrapper invariants**
  - `commit` leaves the underlying store equal to applying the equivalent replay-produced transforms directly to a twin store.
  - `reset` (rollback) leaves the underlying store pristine AND clears the atomic's own transforms.
  - `commit` clears the atomic's transforms.

- **cache-source.ts**
  - After pre-populating the cache and calling `transformCache(t)`, `cache.tryGet(id)` equals `applyTransform(source.get(id), transformForBlockId(t, id))` for inserts+updates transforms. Deletes are excluded by construction (cache-fallback-to-source diverges from applyTransform's tombstone semantics — that asymmetry is documented in a comment, not hidden).

Arbitraries: `arbBlockId` (pool of 5), `arbValue` (pool of 3), `arbBlock`, `arbAttrOp` / `arbArrayOp` / `arbOp`, `arbAction` (insert / update / delete / applyIfPresent), `arbActionSequence` (≤ 12), `arbInitialSubset` (subarray of the block pool).

Helpers live in the spec file:
- `makeMapSource` — in-memory map-backed `BlockSource` that clones on read.
- `makeLenientStore` — `BlockStore` that silently ignores update/delete of missing blocks (needed because tracker-generated transforms may include `delete(b); update(b)` sequences that reach `applyTransformToStore` with no live target; both the original and the copy experience the same no-ops, so the equality invariant still pins correct behavior).

## Testing / validation notes

- Build: `yarn build` in `packages/db-core` — clean.
- Tests: `yarn test` — 301 passing total; 15 property tests in the new suite, each running 30–100 fast-check iterations. Full suite completes in under 1s.
- Reviewer should confirm:
  - The CacheSource property's deletes-exclusion comment accurately documents an intentional semantic (cache is not a source of truth for tombstones), not an unreported bug.
  - The "allowed per-id shapes" enumeration from the source ticket was NOT pinned — during implementation, additional reachable `(inserts, updates, deletes)` combos (e.g. `delete → update`, `update → insert`, and three-way interleavings) were found reachable via legal Tracker API calls. Rather than pin a narrower invariant that fails on current `main`, the suite pins the observable `tryGet` / snapshot-replay contract, which is what actually matters for consumers. This discovery is worth flagging: if a stricter per-id-shape invariant is desired, that is a follow-up fix ticket against `tracker.ts` (specifically `insert` and `update` would need to clear conflicting pre-existing entries, matching `delete`'s behavior).
  - `fast-check` landed in `packages/db-core/package.json` devDependencies (v ^4.7.0) and in the yarn workspace install.

## Usage

- Run all db-core tests: `yarn test` (from `packages/db-core`).
- Verbose output: `yarn test:verbose` — shows each property's describe/it labels.
- Fast-check prints a reproducible seed to stderr when a property fails; paste it back via `fc.configureGlobal({ seed })` in a scratch file to replay.
- Default run count: 100 for cheap sync properties, 30–50 for async / store-round-trip properties. Adjust `numRuns` in-file if churn shows up.

## Out of scope

- Collection / Log / Chain property tests (owned by ticket 2 harness).
- Performance fuzzing at large N.
- Tightening the Tracker contract to forbid currently-reachable exotic states.
