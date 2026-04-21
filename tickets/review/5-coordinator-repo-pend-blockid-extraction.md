description: "CoordinatorRepo.pend was passing `Object.keys(request.transforms)` — i.e. the literal `['inserts','updates','deletes']` — to `verifyResponsibility` and into its success return payload, instead of the actual affected block ids. Now uses `blockIdsForTransforms(request.transforms)`. Split out from ticket `5-chain-add-on-fresh-collection-throws-non-existent-chain` Phase 4."
dependencies: none (self-contained fix)
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (pend — lines around 239-282)
  - packages/db-p2p/test/coordinator-repo-proximity.spec.ts (new regression + fixed mock payloads)
----

## What changed

`CoordinatorRepo.pend` used to call:

```ts
const allBlockIds = Object.keys(request.transforms);
await this.verifyResponsibility(allBlockIds);
// ... later ...
return { success: true, pending: [], blockIds: Object.keys(request.transforms) };
```

`request.transforms` is a `Transforms` record with shape `{ inserts, updates, deletes }` — so `Object.keys` returns those three literal container names, not the affected block ids. `verifyResponsibility` then queried `findCluster` against the literal strings `"inserts"`, `"updates"`, `"deletes"`, and the success response returned those three strings as `blockIds` to the caller.

Now uses `blockIdsForTransforms(request.transforms)` (exported from `@optimystic/db-core`), which deduplicates across `inserts`, `updates`, and `deletes`. The `allBlockIds` local is reused for the success payload so the two sites cannot drift again.

## Why it didn't surface in production crashes

On a **solo / clusterSize <= 1** node (which is how sereus-health ships), `CoordinatorRepo.pend` hits the `peerCount <= 1` fast path and delegates to `storageRepo.pend`, so the faulty block-id extraction never flowed into `verifyResponsibility` in a way that rejected real writes. It would have become much more visible as soon as a multi-node cluster started enforcing proximity — either failing legitimate writes ("Not responsible for block(s): inserts, updates, deletes") or allowing writes on non-responsible nodes because the literal strings hash elsewhere than the real blocks.

The bug was flagged during research for ticket `5-chain-add-on-fresh-collection-throws-non-existent-chain`.

## Tests

`packages/db-p2p/test/coordinator-repo-proximity.spec.ts`:

- **New regression test**: `pend block id extraction (regression for Object.keys(transforms) bug)` — issues a `pend` with inserts + updates + deletes across three distinct block ids, captures what `findCluster` is queried for, and asserts those three real block ids are passed while the literal strings `"inserts"` / `"updates"` / `"deletes"` are not.
- **Fixed existing tests**: Several existing proximity tests had been passing malformed `transforms: { [blockId]: [] }` payloads, which only worked because the old bug treated the top-level keys as block ids. These now use the proper `Transforms` shape `{ inserts, updates, deletes }`. The test **intent** (throw/not-throw, errors mention block ids, etc.) is unchanged.

## Validation

- `packages/db-core`: `npm test` → 287 passing.
- `packages/db-p2p`: `npm test` → 396 passing (including the new regression).
- `packages/db-p2p`: `npm run build` → clean.

## Usage notes

No public API change. Callers of `CoordinatorRepo.pend` that had been observing the bogus `blockIds: ['inserts','updates','deletes']` in the returned `PendSuccess` will now see the actual affected block ids — this is the behavior the type always claimed.
