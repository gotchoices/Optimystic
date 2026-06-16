description: When a peer decides whether to forward an incoming write to another group, the "pend" write type picks the wrong identifier to route by, so on a large multi-group network those writes can be sent to a group that can't handle them. Fix the routing key and add a real-shaped test.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey pend branch — uses Object.keys(transforms)[0])
  - packages/db-core/src/transform/struct.ts (Transforms = { inserts?, updates?, deletes? })
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — the correct derivation)
  - packages/db-p2p/src/cluster/cluster-repo.ts (getAffectedBlockIds / validatePendOperations use blockIdsForTransforms correctly)
  - packages/db-p2p/test/redirect.spec.ts (pend tests pass a flat block-id-keyed transforms object — wrong shape; must be reworked)
difficulty: medium
----

# `pend` redirect key derives a structural field name, not a block id

## Problem

`RepoService.deriveBlockKey` (`packages/db-p2p/src/repo/service.ts`) derives the redirect routing key
for a `pend` op as:

```ts
return { blockKey: Object.keys(operation.pend.transforms)[0], opName: 'pend' }
```

`PendRequest.transforms` is typed `Transforms` (`packages/db-core/src/transform/struct.ts`):

```ts
export type Transforms = {
    inserts?: Record<BlockId, IBlock>;
    updates?: Record<BlockId, BlockOperations>;
    deletes?: BlockId[];
};
```

So `Object.keys(operation.pend.transforms)[0]` yields a **structural field name** —
`'inserts'` / `'updates'` / `'deletes'` — **not a block id**. The redirect check then hashes
`H('inserts')` (a constant) and routes pend redirects to a fixed, wrong cluster regardless of which
blocks the pend actually touches.

This is the **same class of bug** just fixed for `commit` in the
`commit-redirect-key-anchors-on-wrong-block` ticket (redirect routing key inconsistent with where the
op is actually coordinated/verified). The correct derivation is the canonical
`blockIdsForTransforms(transforms)` helper (`packages/db-core/src/transform/helpers.ts`), which is what
every other consumer uses — e.g. `cluster-repo.ts` `validatePendOperations` and the network transactor's
`pend` batching (`network-transactor.ts`).

### Why latent

Same as the commit bug: every current test runs in a "small mesh" (`cluster.length < responsibilityK`),
where `checkRedirect` returns `null` regardless of the key. It only misroutes on a large multi-cluster
mesh whose pend touches blocks outside the structural-key cluster.

### Test gap (must fix as part of this)

The existing pend redirect tests pass a **flat, block-id-keyed** transforms object that does NOT match
the real `Transforms` shape, e.g. (`redirect.spec.ts`):

```ts
{ pend: { transforms: { 'block-A': {} }, actionId: 'a1' } }
```

With the real shape, `{ 'block-A': {} }` has no `inserts`/`updates`/`deletes`, so
`blockIdsForTransforms(...)` returns `[]` and the derived key would be `undefined`. Therefore fixing the
derivation **requires reworking these fixtures** to a real `Transforms` shape, e.g.
`{ inserts: { 'block-A': <IBlock> }, updates: {}, deletes: [] }`, and asserting the derived key is
`'block-A'`. Add a regression assertion mirroring the commit one: a pend whose first affected block is
`block-A` must redirect-check against `block-A`'s cluster (the `!smallMesh && !isMember` path).

## Fix sketch

```ts
if ('pend' in operation) {
    return { blockKey: blockIdsForTransforms(operation.pend.transforms)[0], opName: 'pend' }
}
```

(Import `blockIdsForTransforms` from `@optimystic/db-core`.) Returning `undefined` when the transforms
touch no blocks is correct and already handled by the caller (handled locally, no redirect).

## Validation

- Build + typecheck `db-p2p` and `db-core`.
- Update + run `redirect.spec.ts` with real-shaped pend fixtures; confirm pend derives `blockIds[0]`.
- Run the full `db-p2p` suite; confirm green (note: there is a pre-existing flaky reactivity/cohort-topic
  test, `reactivity / mesh — slow-subscriber isolation`, unrelated to this change).
