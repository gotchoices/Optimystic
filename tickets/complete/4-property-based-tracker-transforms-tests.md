description: Property-based tests covering Tracker / Transforms contract (helpers, tracker merge semantics, deletion-after-insert edges, Atomic wrapper, CacheSource), generalising the 5-chain insert+apply regression into executable fast-check properties.
dependencies:
  - fast-check@^4.7.0 (packages/db-core/package.json devDependencies)
files:
  - packages/db-core/test/transform.property.spec.ts
  - packages/db-core/package.json
----

## What was built

`packages/db-core/test/transform.property.spec.ts` — fast-check property suite with 15 properties across five describe-blocks. Bounded alphabet: 5 block ids, 3 values, action sequences ≤ 12.

Describe-blocks:

- **helpers.ts round-trip invariants**
  - `isTransformsEmpty` preserved under `copyTransforms`.
  - `copyTransforms` produces a deep-equal, fully-independent clone — mutations on deletes array, updates arrays, and inserted blocks' nested fields leave the original deep-equal to a pre-mutation baseline.
  - `applyTransformToStore(t, store1)` and `applyTransformToStore(copyTransforms(t), store2)` produce deep-equal snapshots.

- **tracker.ts merge invariants**
  - Replay determinism: same action sequence → deep-equal `transforms`.
  - Snapshot-and-replay: `new Tracker(source, copyTransforms(t.transforms))` observes identical `tryGet` for every id in the pool.
  - `insert(B)` + any `update` folds into inserts in place — `transforms.updates[B.id]` stays undefined; the inserted block reflects all ops.
  - Same fold holds under the `blocks/helpers.ts:apply` pattern used by `Chain.open` (the motivating 5-chain case).

- **tracker.ts deletion-after-insert edges** (pinned examples)
  - `insert(B); delete(B)` → snapshot → fresh tracker tryGet is `undefined`.
  - Source-backed `update(B); delete(B)` → snapshot → fresh tracker tryGet is `undefined`.
  - `insert + apply + delete` → delete wins.

- **atomic.ts wrapper invariants**
  - `commit` leaves the underlying store equal to applying the equivalent replay-produced transforms directly to a twin store.
  - `reset` (rollback) leaves the underlying store pristine AND clears atomic transforms.
  - `commit` clears atomic transforms.

- **cache-source.ts**
  - After pre-populating the cache and calling `transformCache(t)`, `cache.tryGet(id)` equals `applyTransform(source.get(id), transformForBlockId(t, id))` for insert/update-only transforms. Deletes excluded by construction — cache-fallback-to-source diverges from applyTransform's tombstone semantics (documented in-file as an intentional asymmetry).

Arbitraries: `arbBlockId`, `arbValue`, `arbBlock`, `arbAttrOp`, `arbArrayOp`, `arbOp`, `arbAction` (insert / update / delete / applyIfPresent), `arbActionSequence` (≤ 12), `arbInitialSubset`.

Helpers in-file: `makeMapSource` (clone-on-read in-memory `BlockSource`), `makeLenientStore` (silently ignores update/delete of missing blocks so tracker-generated transforms with `delete(b); update(b)` don't throw; both sides of equality checks see identical no-ops). `runActions` is the single action-dispatch loop; `replay` delegates to it.

## Testing / validation notes

- Build: `yarn build` in `packages/db-core` — clean.
- Tests: `yarn test` — 301 passing (1s). The 15 new property tests run 30–100 fast-check iterations each.
- Review notes:
  - The CacheSource "deletes excluded" comment documents an intentional semantic (cache is not a source of truth for tombstones), not an unreported bug.
  - The original ticket's "allowed per-id shapes" enumeration was not pinned: during implementation, additional reachable `(inserts, updates, deletes)` combos (e.g. `delete → update`, `update → insert`, three-way interleavings) were found reachable via legal Tracker API calls. The suite instead pins the observable `tryGet` / snapshot-replay contract — what consumers actually depend on. If a stricter per-id-shape invariant is desired, it's a follow-up fix against `tracker.ts` (`insert` and `update` would need to clear conflicting prior entries, matching `delete`'s behavior).
  - `fast-check@^4.7.0` is in `packages/db-core/package.json` devDependencies.

## Usage

- `yarn test` from `packages/db-core` runs everything; `yarn test:verbose` shows property labels.
- On failure, fast-check prints a reproducible seed; replay via `fc.configureGlobal({ seed })` in a scratch file.
- Default run counts: 100 for cheap sync properties, 30–50 for async / store-round-trip properties; tune `numRuns` in-file if churn appears.

## Out of scope

- Collection / Log / Chain property tests (ticket 2 harness).
- Performance fuzzing at large N.
- Tightening the Tracker contract to forbid currently-reachable exotic states.
