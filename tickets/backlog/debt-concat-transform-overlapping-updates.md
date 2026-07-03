----
description: A helper that stitches block changes together throws away one side's edits when both sides touch the same block, mirroring a bug just fixed in its sibling helper — harmless today because no caller feeds it overlapping blocks, but a latent trap.
prereq:
files: packages/db-core/src/transform/helpers.ts, packages/db-core/test/transform.spec.ts
difficulty: easy
----

## Background

`packages/db-core/src/transform/helpers.ts` has two "stitch two change-sets together" helpers:

- `mergeTransforms(a, b)` — merges whole `Transforms` objects. **This one was just fixed** (ticket `transform-merge-and-atomic-concurrency`): for a block id present on both sides it now concatenates `[...aOps, ...bOps]` and dedupes `deletes`.
- `concatTransform(transforms, blockId, transform)` (singular) — appends a single block's `Transform` onto an existing `Transforms`. **This one still has the old clobber bug:**

```ts
export function concatTransform(transforms: Transforms, blockId: BlockId, transform: Transform): Transforms {
	return {
		inserts: { ...transforms.inserts, ...(transform.insert ? { [blockId]: transform.insert } : {}) },
		updates: { ...transforms.updates, ...(transform.updates ? { [blockId]: transform.updates } : {}) },  // <-- overwrites existing ops for blockId
		deletes: [...(transforms.deletes ?? []), ...(transform.delete ? [blockId] : [])]                      // <-- no dedupe
	};
}
```

If `transforms.updates[blockId]` already holds operations and `transform.updates` also targets `blockId`, the spread **replaces** the existing ops array — the earlier operations are silently dropped. `deletes` can also accrue duplicate ids.

An existing test documents the current (buggy) behavior: `transform.spec.ts` › "should silently drop operations when concatTransform overlaps existing updates (BUG: data loss)".

## Why it is dormant (not an active bug)

Every current caller passes **disjoint** block ids per accumulator, so `blockId` is never concatenated onto itself:

- `network-transactor.ts` `pend` → `transformForBlock`: iterates a set of distinct `consolidatedBlocks`, one `concatTransform` per unique bid.
- `test-transactor.ts` (test helpers): accumulate one blockId per action per block-iteration.
- `db-p2p/storage-repo.ts` `perBlockActionTransformsToPerAction`: (separately broken — see ticket `bug-storage-repo-missing-transforms-empty`).

Because no caller currently feeds an overlapping block id, the clobber never fires today. It becomes a live data-loss bug the moment any caller accumulates two edits for the same block into one `Transforms`.

## Requirements

- Fix `concatTransform` to **concatenate** update operations for a shared block id (a's ops then the new ops, order-preserving), matching the `mergeTransforms` fix.
- Dedupe `deletes` to a unique set, matching `mergeTransforms`.
- Keep `inserts` last-wins (intentional, same as `mergeTransforms`).
- Flip the assertion in the `transform.spec.ts` "…concatTransform overlaps existing updates (BUG: data loss)" test to assert the concatenated (non-lossy) result, and retitle it away from "BUG".
- Full db-core suite must stay green (`cd packages/db-core && yarn test`).

Small, self-contained, mirrors an already-landed change.
