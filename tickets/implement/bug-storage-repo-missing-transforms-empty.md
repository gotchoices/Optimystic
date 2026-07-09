description: When a storage node rejects a write because someone else already wrote a newer version, it is supposed to send back the newer changes it has — but a coding slip makes it send back an empty set every time. Fix the slip and add a test.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: easy
----

## Confirmed defect (reproduced)

`perBlockActionTransformsToPerAction` (bottom of `packages/db-p2p/src/storage/storage-repo.ts`, ~line 688) regroups "missing actions per block" into "missing actions per action id". Its reduce throws away the return value of `concatTransform`:

```ts
items.reduce((acc, { blockId, transform }) => {
	concatTransform(acc.transforms, blockId, transform.transform);  // result discarded
	return acc;
}, { actionId: actionId as ActionId, rev: items[0]!.transform.rev, transforms: emptyTransforms() })
```

`concatTransform` (`packages/db-core/src/transform/helpers.ts`) is pure — returns a fresh `Transforms`, never mutates its first argument. So `acc.transforms` stays `emptyTransforms()`.

**Reproduced** with a throwaway mocha spec against `StorageRepo` (deleted after confirming; recreate as the regression test below):

1. `pend` + `commit` action-1 at rev 1 across `block-1` and `block-2` (two inserts).
2. `pend` + `commit` action-2 at rev **1** across both blocks → stale conflict.
3. `commit` returns `success:false` with:
   `missing: [{ actionId: 'action-1', rev: 1, transforms: { inserts: {}, updates: {}, deletes: [] } }]`

Expected `transforms.inserts` to contain both `block-1` and `block-2`. It is empty. Note the emptiness is **not** limited to multi-block actions — a single-block missing action comes back empty too, since the very first `concatTransform` result is dropped.

Applying `acc.transforms = concatTransform(acc.transforms, blockId, transform.transform)` makes the repro pass (both inserts present). That is the whole fix.

## Reachability (the ticket asked; answer: reachable)

- Only caller is `StorageRepo.commit`'s stale-conflict branch (`missedCommits` → `perBlockActionTransformsToPerAction`, ~line 449). That is a live path: a commit whose `latest.rev >= request.rev` for some block, under a different action id.
- `StorageRepo.commit` is the node-local repo behind `ClusterRepo` / the coordinator repos; its `StaleFailure.missing` travels back to `NetworkTransactor.commit`, which merges it via `distinctBlockActionTransforms` (`packages/db-core/src/transactor/network-transactor.ts:633`).
- No existing test covers commit's `missing` **contents**. `packages/db-p2p/test/storage-repo.spec.ts:132` asserts only `missing.length > 0` — and that test exercises `pend`, whose `missing` is built separately with `transformsFromTransform` and is correct. Nothing would have caught this.
- Today's downstream consumers happen to only read `missing.length` (`coordinator.ts` conflict classification, `cluster-repo.ts:1221` divergence tolerance) and `Collection.syncInternal` recovers by re-reading rather than by applying the returned transforms. So there is no known present-day data loss — but the empty payload violates the `StaleFailure` wire contract that other/future consumers (client-side rebase, dispute evidence) legitimately depend on. Fix, don't downgrade.

## Interaction with `debt-concat-transform-overlapping-updates`

Independent. In this helper each `(actionId, blockId)` pair appears at most once (one `ActionTransform` per block per action), so `concatTransform`'s overlapping-updates overwrite bug cannot trigger here. No ordering dependency between the tickets.

## TODO

- In `packages/db-p2p/src/storage/storage-repo.ts`, thread the result: `acc.transforms = concatTransform(acc.transforms, blockId, transform.transform)`.
- Add a regression test to `packages/db-p2p/test/storage-repo.spec.ts` (new `describe('commit')` case, or extend the existing commit block): commit an action across two blocks at rev 1, then commit a second action at rev 1 across the same two blocks; assert the returned `missing[0].transforms` names **both** block ids (non-empty). Use `MemoryRawStorage` + `BlockStorage` + `StorageRepo` exactly like the existing specs; `CommitRequest` needs `actionId`, `rev`, `blockIds`, `headerId`, `tailId`.
- Consider a second assertion that a single-block stale conflict also returns non-empty transforms — cheap, and it pins the "first `concatTransform` result dropped" half of the bug.
- Run `yarn workspace @optimystic/db-p2p build` and the package's test script (`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"`), streaming output.
