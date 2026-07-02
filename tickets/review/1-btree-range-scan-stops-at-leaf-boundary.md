description: Review the internalNext fix and regression tests for the range scan end-of-leaf crack bug.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: easy
----

## What was done

Fixed `BTree.internalNext` (btree.ts:391) so that a cursor sitting at the end-of-leaf crack (leafIndex === entries.length, path.on === false) falls through to the existing branch-popping leaf-advance code instead of silently returning. Previously the method was structured as `if / else if / else`; when the off-crack get-on attempt failed at end-of-leaf, none of the three branches ran and the method returned without advancing.

Two regression tests were added in `btree.spec.ts` under `describe('range scan end-of-leaf crack …')`:

1. **Fractional-key crack** — insert 0..199, compute first-leaf max, range from `max + 0.5` (numeric comparator places this strictly between `max` and `max+1`); assert count and first result.
2. **Delete-driven crack** — insert 0..64 (forces 2-leaf tree), delete first-leaf max (stales the parent separator), range from that deleted key; assert count and first result.

All 1039 tests pass.

## Fix shape

`internalNext` was restructured (not rewritten) so that:
- Off-crack get-on succeeds → return (unchanged behavior)
- Off-crack interior crack (leafIndex < entries.length, branch index out-of-range) → return (unchanged behavior, preserves prior guard)
- Off-crack end-of-leaf (leafIndex === entries.length) → fall through to branch-popping advance (was the bug)
- On, not at last entry → increment leafIndex, return (unchanged behavior)
- On, at last entry → branch-popping advance (unchanged behavior)

Single-leaf root edge case (branches.length === 0): `last = -1`, loop never runs, found = false → sets end crack. Correct.

## Known gaps / tripwires

- Descending scan (`internalPrior`) was already correct and is untouched; no new tests added for it.
- `getCount` sidesteps `internalNext` entirely for the off-crack case (forces leafIndex to entries.length - 1 before calling); it was never broken.
- The delete-driven variant depends on the parent separator staying stale (internalDelete only refreshes separator when index 0 is deleted, btree.ts:479). If that behavior changes, the test will need updating.

## Review focus

- Confirm the restructured `if/else` in `internalNext` correctly covers all five cases above and is logically equivalent to the prior code for the four non-buggy cases.
- Confirm the `path.leafIndex < path.leafNode.entries.length` interior-crack guard does not accidentally suppress an advance that should happen.
- Check the test for the delete-driven crack: `expectedCount = 65 - leafMax - 1`. Verify this arithmetic is correct for a first-leaf max of 31 (entries 32..64 = 33 entries).
