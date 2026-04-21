description: Add property-based tests for Tracker, copyTransforms, isTransformsEmpty, and the Transforms merge/apply semantics. Generalize beyond hand-picked example cases (including ticket 5-chain's insert+apply-on-same-block scenario) to cover the whole state-transition space as a fast, deterministic CI signal.
dependencies:
  - fast-check (new dev-dep in packages/db-core/package.json)
  - tickets/complete/5-chain-add-on-fresh-collection-throws-non-existent-chain.md (motivating case; fix already landed)
files:
  - packages/db-core/src/transform/helpers.ts (copyTransforms, mergeTransforms, concatTransform, isTransformsEmpty, applyTransformToStore, transformForBlockId)
  - packages/db-core/src/transform/tracker.ts (Tracker insert/update/delete coalescing; apply folds into inserts in place)
  - packages/db-core/src/transform/atomic.ts (Atomic wrapper: commit / reset-as-rollback)
  - packages/db-core/src/transform/cache-source.ts (source-cache interaction for stateful reads)
  - packages/db-core/src/transform/struct.ts (Transforms / Transform / BlockOperation types)
  - packages/db-core/src/blocks/helpers.ts (`apply(store, block, op)` — the in-place + staged-op pattern used by Chain.open)
  - packages/db-core/test/transform.spec.ts (existing example-based tests — AUGMENT, don't replace)
  - packages/db-core/test/test-block-store.ts (TestBlockStore — reuse as the "real store" for round-trip checks)
  - new: packages/db-core/test/transform.property.spec.ts
----

## Transforms contract (executable via properties)

`Transforms = { inserts: Record<BlockId, IBlock>, updates: Record<BlockId, BlockOperation[]>, deletes: BlockId[] }`

Tracker coalesces ops as they arrive:
- `insert(B)`: stores a structuredClone in `inserts[B.id]`, and removes one occurrence of `B.id` from `deletes` if present.
- `update(id, op)`: if `inserts[id]` exists, applies `op` in-place to the inserted block (no entry in `updates`). Otherwise appends a clone to `updates[id]`.
- `delete(id)`: removes `inserts[id]` and `updates[id]`, appends `id` to `deletes`.
- `tryGet(id)`: if source has it, applies `updates[id]` ops to the source copy, then honors `deletes`. If source lacks it, returns a clone of `inserts[id]` if present.

Snapshot + replay invariant: `new Tracker(source, copyTransforms(t.transforms))` must observe the same state on `tryGet` for every affected id as the original tracker.

## Property test coverage

Use `fast-check` with small bounded arbitraries (N blocks ≤ 5, string values from a small pool) so the suite stays under a few seconds. Seed via `fc.configureGlobal({ seed: ... })` so a failing case is reproducible from CI logs.

### Generators
- `arbBlockId`: from a small fixed pool (e.g. `b1`..`b5`) so collisions are common.
- `arbBlock`: `{ header: { id, type: 'T', collectionId: 'c' }, data: string, items: string[] }`.
- `arbOp`: either attribute-set `['data', 0, 0, value]` or array-splice `['items', idx, del, [...values]]` bounded to short arrays.
- `arbAction`: tagged union `{ kind: 'insert', block } | { kind: 'update', id, op } | { kind: 'delete', id } | { kind: 'applyIfPresent', id, op }` where `applyIfPresent` models the `blocks/helpers.ts:apply` pattern (mutate the block in hand AND call `tracker.update`).
- `arbActionSequence`: array of actions, length bounded (e.g. ≤ 12).

### Round-trip invariants (helpers.ts)
- `isTransformsEmpty(copyTransforms(t)) === isTransformsEmpty(t)` for any generated Transforms.
- `copyTransforms(t)` deep-equals `t` but shares no array/object references with `updates[*]` or `deletes` (mutating the copy must not mutate the original).
- Applying `t` to an empty `TestBlockStore` via `applyTransformToStore` and applying `copyTransforms(t)` to a second fresh store produces deep-equal final stores.

### Tracker-merge invariants (tracker.ts)
- Replaying the same generated action sequence into two fresh Trackers yields `deep.equal` `transforms`.
- `copyTransforms(tracker.transforms)` fed into a fresh Tracker (`new Tracker(source, snapshot)`) returns the same `tryGet(id)` result as the original tracker for every generated `id` (this subsumes the 5-chain regression: insert(B) + apply(B, f=v) via `blocks/helpers.ts:apply` must surface in the snapshot).
- `insert(B)` followed by any number of `update(B, op)` calls produces `transforms.updates[B.id] === undefined` and `transforms.inserts[B.id]` reflects all ops applied (in-place fold).
- After arbitrary sequence, for every affected id: exactly one of the following is true per the contract — `id` is in `inserts` only, in `updates` only, in `deletes` only, or in `inserts` + `deletes` (the known contradictory state from double-delete-then-insert; document and pin behavior, don't hide).

### Atomic-wrapper invariants (atomic.ts)
- Ops applied to an `Atomic(store)` and then `commit()`ed leave `store` in the state equal to the same ops applied directly to a twin store.
- Ops applied to an `Atomic(store)` and then `reset()`ed (rollback) leave `store` bit-identical to a pristine twin (no ops leaked through).
- Commit clears the Atomic's own transforms (`isTransformsEmpty(atomic.transforms)` after commit).

### Deletion-after-insert edge cases (explicit, not just via properties)
- `insert(B); delete(B)` → snapshot → fresh Tracker: `tryGet(B.id) === undefined`, no zombie insert reachable.
- On a Tracker whose source already has B: `update(B, op); delete(B)` → snapshot → fresh Tracker: `tryGet(B.id) === undefined`.
- Document and pin the "insert + apply → delete" sequence: delete wins.

### CacheSource interaction (cache-source.ts)
Lighter touch — a single property that `CacheSource(source).tryGet(id)` after `transformCache(t)` equals `applyTransform(source.get(id), transformForBlockId(t, id))` for any generated `t` and id. Keep bounded to a few cases; the heavy logic lives in Tracker.

## Implementation notes
- Add `fast-check` to `packages/db-core/package.json` devDependencies. Latest 3.x. Install via `npm install --save-dev fast-check` from the package directory.
- `mocha` picks up `test/**/*.spec.ts` automatically (see `package.json` scripts), so no runner config change is needed.
- Prefer `fc.assert(fc.property(...))` with `numRuns: 100` (mocha default timeout is fine). For the heavy store-round-trip property, drop to `numRuns: 50`.
- Reuse `TestBlockStore` from `test/test-block-store.ts` as the concrete `BlockStore`. Its `ITreeNode` typing is loose enough to accept `TestBlock`-shaped values via cast.
- For the mock source used by Tracker property tests, build an in-memory map-backed `BlockSource` so deletes against a source-backed block are observable.
- Do NOT edit `transform.spec.ts` — it is the example-based suite and stays as-is. New properties live in `transform.property.spec.ts`.
- Out of scope: Collection/Log/Chain property tests (covered by ticket 2 harness), performance fuzzing at scale.

## Expected outcomes
- New property suite runs green on current `main` in a few seconds.
- Suite documents the informal Transforms contract via executable properties.
- Seeded failures reproduce deterministically from CI logs.

## TODO
- Add `fast-check` to `packages/db-core/package.json` devDependencies; run `npm install` in the package to update the lockfile.
- Create `packages/db-core/test/transform.property.spec.ts` with the arbitraries and property groups described above.
- Run `npm run build` and `npm test` in `packages/db-core`; confirm both pass.
- If any property surfaces a genuine regression (not documented quirk), file a follow-up fix ticket rather than weakening the property.
