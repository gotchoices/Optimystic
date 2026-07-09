description: StorageRepo stale-conflict missing transforms were always empty — one-line fix and regression tests.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
----

## What was done

### Fix (storage-repo.ts:695)

`perBlockActionTransformsToPerAction` was calling `concatTransform` (a pure function) and throwing away its return value, leaving `acc.transforms` as the initial `emptyTransforms()` forever.

```ts
// before
concatTransform(acc.transforms, blockId, transform.transform);
// after
acc.transforms = concatTransform(acc.transforms, blockId, transform.transform);
```

### Tests added (storage-repo.spec.ts — new `describe('commit — stale-conflict missing transforms')`)

Two regression cases:

1. **single-block stale conflict** — commit `a1` (insert `block-1` @rev 1), then try to commit `a2` at rev 1 (stale); assert `missing[0].transforms.inserts` contains `block-1`.
2. **multi-block stale conflict** — commit `a1` inserting both `block-1` and `block-2` @rev 1, then stale-conflict `a2`; assert both blocks appear in `missing[0].transforms.inserts`.

## Test run

`yarn workspace @optimystic/db-p2p build` → clean.  
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"` → **1308 passing, 0 failing**.

## Known gaps / reviewer notes

- Only `inserts` in `transforms` is exercised by these tests (the stale-conflict scenario here uses two inserts). The fix is correct for updates and deletes too — `concatTransform` handles all three cases — but no new test pins the update/delete paths of the stale-conflict return.
- Downstream callers today only inspect `missing.length`, not `missing[*].transforms`, so no present-day data loss existed. The fix restores the wire contract for future consumers (client-side rebase, dispute evidence).
- The `debt-concat-transform-overlapping-updates` ticket is independent: in this path each `(actionId, blockId)` pair appears at most once, so the overlapping-updates overwrite cannot trigger here.

## Review findings

- No tripwires introduced. Bug site had one code comment explaining the assumption (`all missing actionIds share the same revision`) — left in place.
