description: When a peer decides whether to forward an incoming write to another group, the "pend" write type routes by a structural field name instead of a real block id, so on a large multi-group network those writes can be sent to a group that can't handle them. Fix the routing key and rework the test fixtures to the real shape.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey pend branch — line 157-159, currently Object.keys(transforms)[0])
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — the correct derivation, line 41)
  - packages/db-core/src/transform/struct.ts (Transforms = { inserts?, updates?, deletes? })
  - packages/db-core/src/network/struct.ts (PendRequest = ActionTransforms & {...}; ActionTransforms.transforms: Transforms)
  - packages/db-core/src/blocks/structs.ts (IBlock = { header: { id, type, collectionId } })
  - packages/db-p2p/src/cluster/cluster-repo.ts (getAffectedBlockIds / validatePendOperations already use blockIdsForTransforms correctly — line 4, 1079)
  - packages/db-p2p/test/redirect.spec.ts (pend tests at lines 216-220, 252-257 pass wrong-shaped transforms; rework + add large-mesh regression)
difficulty: medium
----

# `pend` redirect key derives a structural field name, not a block id

## Root cause (confirmed)

`RepoService.deriveBlockKey` (`packages/db-p2p/src/repo/service.ts:157-159`) derives the redirect
routing key for a `pend` op as:

```ts
if ('pend' in operation) {
    return { blockKey: Object.keys(operation.pend.transforms)[0], opName: 'pend' }
}
```

`PendRequest.transforms` is typed `Transforms` (`packages/db-core/src/network/struct.ts:14` via
`ActionTransforms`, defined in `packages/db-core/src/transform/struct.ts`):

```ts
export type Transforms = {
    inserts?: Record<BlockId, IBlock>;
    updates?: Record<BlockId, BlockOperations>;
    deletes?: BlockId[];
};
```

So `Object.keys(operation.pend.transforms)[0]` yields a **structural field name** —
`'inserts'` / `'updates'` / `'deletes'` — **not a block id**. `checkRedirect` then hashes
`H('inserts')` (a constant) and routes pend redirects to a fixed, wrong cluster regardless of which
blocks the pend actually touches.

This is the **same class of bug** fixed for `commit` in `commit-redirect-key-anchors-on-wrong-block`
(redirect routing key inconsistent with where the op is coordinated/verified). The canonical correct
derivation is `blockIdsForTransforms(transforms)` (`packages/db-core/src/transform/helpers.ts:41`),
which every other consumer already uses — e.g. `cluster-repo.ts` `getAffectedBlockIds` (line 1079) and
`validatePendOperations` (line 638).

### Why latent

Every current test runs in a "small mesh" (`cluster.length < responsibilityK`), where `checkRedirect`
returns `null` regardless of the key (`service.ts:187-196`). It only misroutes on a large multi-cluster
mesh whose pend touches blocks outside the structural-key cluster.

### Test gap

The existing pend redirect tests pass a **flat, block-id-keyed** transforms object that does NOT match
the real `Transforms` shape:

- `redirect.spec.ts:217` — `{ pend: { transforms: { 'block-1': {} }, actionId: 'a1' } as any }`
- `redirect.spec.ts:253` — `{ pend: { transforms: { 'block-A': {} }, actionId: 'a1' } } as any`

With the real shape, `{ 'block-A': {} }` has no `inserts`/`updates`/`deletes`, so
`blockIdsForTransforms(...)` returns `[]` and the derived key would be `undefined`. Fixing the
derivation therefore **requires reworking these fixtures** to a real `Transforms` shape.

## Fix

In `service.ts`, replace the pend branch:

```ts
if ('pend' in operation) {
    return { blockKey: blockIdsForTransforms(operation.pend.transforms)[0], opName: 'pend' }
}
```

Add the import at the top of `service.ts` (alongside the existing `@optimystic/db-core` type import on
line 4 — note `blockIdsForTransforms` is a **value**, not a type, so it needs a runtime import, not
`import type`):

```ts
import { blockIdsForTransforms } from '@optimystic/db-core'
```

Returning `undefined` when the transforms touch no blocks is correct and already handled by the caller
(`service.ts:217` — `blockKey !== undefined ? checkRedirect(...) : null`, handled locally, no redirect).

Also update the doc comment on `deriveBlockKey` (`service.ts:142`) which currently reads
`- pend → first transforms key`; change it to reflect `blockIds[0]` (e.g. `pend → blockIdsForTransforms(...)[0]`).

## Test rework

A valid `IBlock` is `{ header: { id, type, collectionId } }` (`packages/db-core/src/blocks/structs.ts:11`).
Use a small helper for fixtures, e.g.:

```ts
const makeBlock = (id: string): IBlock =>
    ({ header: { id, type: 'test', collectionId: 'c1' } });
```

(import `IBlock` from `@optimystic/db-core` in the spec's type imports).

Rework the two existing pend fixtures to a real `Transforms` shape:

- **`redirect.spec.ts:216-220`** ("redirects pend operations") — change the transforms to
  `{ inserts: { 'block-1': makeBlock('block-1') }, updates: {}, deletes: [] }`. The explicit-key
  `checkRedirect('block-1', 'pend', message)` call still asserts a redirect fires (unchanged).
- **`redirect.spec.ts:252-257`** ("derives pend key from the first transforms key") — change the
  fixture transforms to `{ inserts: { 'block-A': makeBlock('block-A') }, updates: {}, deletes: [] }`
  and assert `blockKey === 'block-A'`. Update the test title to e.g.
  *"derives pend key from blockIdsForTransforms(...)[0]"*.

Add a **large-mesh regression** mirroring the commit one (`redirect.spec.ts:288-325`, the
"commit redirect keys on blockIds[0] (large mesh)" describe). Use the existing `makeKeyedNetworkManager`
helper and `responsibilityK: 2`:

- Build a pend whose transforms touch `block-A` (e.g.
  `{ inserts: { 'block-A': makeBlock('block-A') }, updates: {}, deletes: [] }`).
- Map `blockKeyDigest('block-A')` → a cluster that **excludes** self (and size ≥ K → not small mesh).
- Derive via `service.deriveBlockKey(message.operations[0])`, assert `blockKey === 'block-A'`.
- `await service.checkRedirect(blockKey!, 'pend', message)` → expect a redirect to fire targeting
  block-A's cluster (`reason === 'not_in_cluster'`, peers include the block-A coordinator, exclude self).
- (Optional sanity) Confirm the OLD behavior would have keyed on `'inserts'` and would route to the
  fallback/wrong cluster — i.e. `checkRedirect('inserts', 'pend', message)` against a fallback cluster
  that includes self yields `null`. This documents the misroute the fix removes.

## Validation

- Build + typecheck `db-p2p` and `db-core`.
- Run `redirect.spec.ts`; confirm the reworked pend fixtures + new large-mesh pend regression pass and
  pend derives `blockIdsForTransforms(...)[0]`.
- Run the full `db-p2p` suite; confirm green. **Note**: there is a pre-existing flaky
  reactivity/cohort-topic test, `reactivity / mesh — slow-subscriber isolation`, unrelated to this
  change — if it (and only it) fails, follow the pre-existing-error flow rather than chasing it here.

## TODO

- [ ] Add `import { blockIdsForTransforms } from '@optimystic/db-core'` to `service.ts` (runtime value import).
- [ ] Replace the pend branch in `deriveBlockKey` to use `blockIdsForTransforms(operation.pend.transforms)[0]`.
- [ ] Update the `deriveBlockKey` doc comment line for `pend`.
- [ ] Add a `makeBlock` IBlock fixture helper to `redirect.spec.ts` and import `IBlock`.
- [ ] Rework the two existing pend fixtures (lines ~217, ~253) to real `Transforms` shape; fix titles/asserts.
- [ ] Add the large-mesh pend redirect regression (mirror the commit large-mesh describe block).
- [ ] Build + typecheck `db-p2p` and `db-core`; run `redirect.spec.ts` and the full `db-p2p` suite.
