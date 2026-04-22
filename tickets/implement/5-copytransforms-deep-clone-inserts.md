description: Fix `copyTransforms` to deep-clone insert values so per-sync Tracker snapshots don't mutate the parent Collection tracker's inserted blocks in place. This is the root cause of the "Cannot add to non-existent chain" throw on the first write to a fresh Collection when `Collection.syncInternal`'s retry loop runs long enough to overflow a chain tail (32+ iterations).
dependencies: prior ticket 5-get-block-throws-on-pending-only-metadata (complete) unmasked this
files:
  - packages/db-core/src/transform/helpers.ts (`copyTransforms`, line 61-67 — the fix)
  - packages/db-core/src/transform/tracker.ts (in-place `update` on inserts, line 47-55 — counterpart contract)
  - packages/db-core/src/chain/chain.ts (`Chain.open` + `add` + `getTail`, lines 76-136, 303-311 — working-tree diff reverts TRACE-5 logs)
  - packages/db-core/src/collection/collection.ts (`createOrOpen` fresh path line 50-60, `syncInternal` line 153-190 — working-tree diff reverts TRACE-5 logs)
  - packages/db-core/test/transform.spec.ts (regression test at line 311 already lands the failing case)
----

## Problem (summary)

`copyTransforms` shallow-copies the `inserts` map: `{ ...transform.inserts }`. Each block object is shared by reference between the original `Transforms` and the "copy". Since `Tracker.update` mutates inserted block objects in place (`applyOperation(inserted, op)` at `tracker.ts:50`), any op applied through a per-sync Tracker built from a snapshot also mutates the parent Collection's `this.tracker.transforms.inserts`.

Under `Collection.syncInternal`'s retry loop, each iteration re-applies chain.add → tail block mutation. After ~32 iterations the shared tail fills; `chain.add` then rolls over to a new tail, mutating the shared header's `tailId` to a new block id that was only inserted into the per-sync tracker. If that iteration fails, the header's `tailId` now points at an orphan, and the next retry throws "Cannot add to non-existent chain".

Full trace-backed analysis lives at the top of this ticket's original fix file (see `tickets/.in-progress` history if needed) and in the already-landed regression test `apply-over-insert survives copyTransforms (regression for fresh-collection chain.add)` in `packages/db-core/test/transform.spec.ts:311`.

## Fix

`packages/db-core/src/transform/helpers.ts:61-67` — deep-clone every insert value the same way `Tracker.insert` already clones on write and `Tracker.tryGet` already clones on read. The docstring already warns about the analogous `updates` pitfall; extend it to `inserts`.

```ts
export function copyTransforms(transform: Transforms): Transforms {
    const inserts = transform.inserts
        ? Object.fromEntries(Object.entries(transform.inserts).map(([k, v]) => [k, structuredClone(v)]))
        : {};
    const updates = transform.updates
        ? Object.fromEntries(Object.entries(transform.updates).map(([k, v]) => [k, structuredClone(v)]))
        : undefined;
    return { inserts, updates, deletes: transform.deletes ? [...transform.deletes] : undefined };
}
```

Update the docstring to note that both `inserts` and `updates` require deep clones and that `Tracker.update` mutates inserted blocks in place.

## Tests

The regression test is already present at `packages/db-core/test/transform.spec.ts:311` and models the exact fresh-collection / `Chain.open` pattern. It currently passes structurally but the new-tail mutation path it exercises will fail without the fix in sufficiently long retry loops. Before-and-after:

- Before fix: the snapshot `tracker.tryGet(headerId)` still sees headId/tailId because the shared insert was mutated in place. That actually masks the direct assertion — but the broader Collection-level failure mode is the tail-overflow rollover mutating the parent tracker's header.
- After fix: snapshot is independent; mutations on the snapshot tracker cannot leak back to the parent.

Augment `transform.spec.ts` with an explicit mutation-isolation assertion on `copyTransforms` output:

- `copyTransforms` produces a snapshot whose inserted block objects are `!==` the originals.
- A `Tracker.update(id, op)` on the snapshot does not mutate `original.inserts[id]`.

## Working-tree state to preserve

`git status` at ticket pickup shows modifications to `packages/db-core/src/chain/chain.ts` and `packages/db-core/src/collection/collection.ts` that **remove** the author's `[TRACE-5]` diagnostic console.log lines and restore a plain `"Cannot add to non-existent chain"` throw. Those reverts are intentional cleanup — keep them. Do not restore the trace logs.

## Out of scope (noted by original author, not addressed here)

- **Retry-loop amplification** in `Collection.syncInternal` (`collection.ts:153-190`): on a solo-node first write, the loop should not iterate 32+ times. The underlying repeated `staleFailure` from `NetworkTransactor.transact` / `CoordinatorRepo` is a separate symptom worth investigating. Possibly related to the maintainer's Phase 4 ticket `5-coordinator-repo-pend-blockid-extraction.md`. A bounded attempt count with clearer error reporting is also worth considering.
- **CollectionFactory caching across non-transactional calls** in `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:28-64`: only caches inside an active txn; repeated `SchemaManager.getSchemaTree` calls during `OptimysticVirtualTable.doInitialize` create fresh `Collection` instances with fresh trackers, compounding the sync chaos. A per-process cache keyed by `collectionKey` is the obvious pattern but unrelated to the throw's root cause.

Both should be tracked as their own follow-up tickets if not already.

## TODO

- Apply the `copyTransforms` deep-clone fix in `packages/db-core/src/transform/helpers.ts`.
- Update the `copyTransforms` docstring to cover `inserts` (matching the `updates` warning).
- Add a `copyTransforms` mutation-isolation unit test in `packages/db-core/test/transform.spec.ts` (two assertions: object identity changes; `update` on snapshot leaves original insert untouched).
- Run `pnpm --filter @optimystic/db-core test` and ensure all transform / chain / collection specs pass.
- Run `pnpm --filter @optimystic/db-core build` (or workspace-wide build) to confirm typecheck.
- Output to `review/` with a summary.
