description: Deep-clone inserts in `copyTransforms` so per-sync Tracker snapshots can't mutate the parent Collection tracker's inserted blocks in place. Root cause of "Cannot add to non-existent chain" on first writes to fresh collections under long retry loops.
dependencies: prior ticket 5-get-block-throws-on-pending-only-metadata (complete) unmasked this
files:
  - packages/db-core/src/transform/helpers.ts (`copyTransforms` now deep-clones inserts; docstring extended)
  - packages/db-core/test/transform.spec.ts (new mutation-isolation test alongside the pre-existing apply-over-insert regression test at line 311)
----

## What changed

`copyTransforms` now deep-clones every insert value via `structuredClone`, mirroring how `Tracker.insert` clones on write and `Tracker.tryGet` clones on read. The docstring now explicitly warns that both `inserts` and `updates` require deep clones and references the in-place mutation contract of `Tracker.update`/`applyOperation`.

```ts
// Before: inserts: { ...transform.inserts }  // shared block object refs
// After:  Object.fromEntries(Object.entries(transform.inserts).map(([k, v]) => [k, structuredClone(v)]))
```

## Why

`Tracker.update` mutates inserted block objects in place (`tracker.ts:47-55` → `applyOperation` → `block[entity] = structuredClone(inserted)`). With shallow-cloned `inserts`, a per-sync `Tracker` built over a `copyTransforms` snapshot would reach into the **same block objects** held by the parent Collection's tracker. Under `Collection.syncInternal`'s 32+ iteration retry loop on a solo-node fresh write, `chain.add` would mutate the shared tail block until it overflowed, then mutate the shared header's `tailId` to a freshly inserted tail block id that only existed in the per-sync tracker. On retry, the parent tracker's header pointed at an orphaned tail → "Cannot add to non-existent chain".

## Validation

- `yarn workspace @optimystic/db-core test` → 302 passing.
- `yarn workspace @optimystic/db-core build` → exit 0 (typecheck clean).
- New unit test `copyTransforms isolates inserted block objects from snapshot mutations` asserts:
  - `snapshot.inserts[id] !== original.inserts[id]` (object identity changes).
  - A `Tracker.update` against the snapshot does not leak into `original.inserts[id]`.
- Pre-existing regression test `apply-over-insert survives copyTransforms (regression for fresh-collection chain.add)` at `transform.spec.ts:311` continues to pass.

## Reviewer focus

- Confirm the deep-clone change is the minimal surface — only `copyTransforms`, no callers needed adjustment.
- Confirm docstring covers both `inserts` and `updates` mutation pitfalls.
- Spot-check that no caller of `copyTransforms` was relying on the shallow-share semantics (none should — the contract is "snapshot copy").

## Out of scope (follow-ups noted in source ticket, not addressed here)

- `Collection.syncInternal` retry-loop amplification: a solo-node first write should not iterate 32+ times. Worth a bounded attempt count + clearer error reporting. Possibly tied to Phase 4 ticket `5-coordinator-repo-pend-blockid-extraction.md`.
- `CollectionFactory` per-process cache for non-transactional `Collection` instantiation in `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:28-64`. Repeated `SchemaManager.getSchemaTree` calls compound sync churn with fresh trackers.
