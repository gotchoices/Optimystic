----
description: When a peer reports back which changes another node is missing across several blocks, the code that assembles that report throws away the result of each step and hands back an empty report, so cross-block conflict recovery may silently lose the very changes it is meant to carry.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts
difficulty: medium
----

## What is wrong

`perBlockActionTransformsToPerAction` in `packages/db-p2p/src/storage/storage-repo.ts` (~line 571) regroups "missing actions per block" into "missing actions per action id". The reduce that builds each action's combined `Transforms` **discards the return value** of `concatTransform`:

```ts
items.reduce((acc, { blockId, transform }) => {
	concatTransform(acc.transforms, blockId, transform.transform);  // return value thrown away
	return acc;                                                     // acc.transforms never updated
}, {
	actionId: actionId as ActionId,
	rev: items[0]!.transform.rev,
	transforms: emptyTransforms()
});
```

`concatTransform` is **pure** — it returns a new `Transforms` and does not mutate its first argument. So `acc.transforms` stays `emptyTransforms()` for the whole reduce. Every action produced by this helper carries an **empty transform set**, regardless of how many blocks it actually spans.

The fix is to thread the return value: `acc.transforms = concatTransform(acc.transforms, blockId, transform.transform)` (or reduce over `concatTransforms`).

## Scope / provenance

- **Pre-existing.** Found during review of `transform-merge-and-atomic-concurrency`; **not** introduced by that ticket's diff (which touched only `db-core`). This is in `db-p2p`.
- Depends conceptually on `concatTransform` behaving correctly — see `debt-concat-transform-overlapping-updates`. Even with that fixed, this call site is still broken because it ignores the result entirely.

## Requirements

- Thread the `concatTransform` result into the accumulator so multi-block missing actions carry their real transforms.
- **First establish reachability:** confirm whether `perBlockActionTransformsToPerAction` is exercised on a live path (missing-action / stale-conflict recovery) and whether any existing test would have caught an empty-transform result. If it is dead code, downgrade/close rather than fix blindly.
- Add a regression test that a missing action spanning ≥2 blocks comes back with both blocks' operations present (non-empty).
- Build + tests for `db-p2p` must pass.
