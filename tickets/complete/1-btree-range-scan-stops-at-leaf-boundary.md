description: Fixed a bug where scanning a range of keys returned nothing when the starting key fell right at the end of a leaf's data block, instead of continuing into the next block.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
----

## What was done

Fixed `BTree.internalNext` (btree.ts:391) so a cursor sitting at the end-of-leaf crack (`leafIndex === entries.length`, `path.on === false`) falls through to the branch-popping leaf-advance instead of silently returning. The prior `if / else if / else` structure left the off-crack end-of-leaf case handled by no branch, so the method returned without advancing and range scans yielded zero results.

Two regression tests added in `btree.spec.ts`:
1. **Fractional-key crack** — insert 0..199, range from `firstLeafMax + 0.5`.
2. **Delete-driven crack** — insert 0..64, delete first-leaf max (stales parent separator), range from the deleted key.

## Review findings

### Checked: fix logic equivalence (`internalNext`, five cases)
Verified the restructured control flow against the prior code. All four non-buggy cases are logically equivalent, and the fifth (off-crack end-of-leaf) is the fix:
- Off-crack get-on succeeds → return (unchanged).
- Off-crack interior crack (`leafIndex < entries.length`, get-on failed on a stale branch index) → return via the `path.leafIndex < entries.length` guard (unchanged — preserves prior degenerate-state behavior).
- Off-crack end-of-leaf (`leafIndex === entries.length`) → fall through to branch-popping (the fix).
- On, not last entry → `++leafIndex; return` (unchanged; the `else if` condition was inverted from `>= length-1` to `< length-1` but is equivalent).
- On, last entry → fall through to branch-popping (unchanged).

Confirmed the interior-crack guard does not suppress a legitimate advance: get-on only fails while `leafIndex` is in `[0, length)` when a branch index is out of range — a degenerate state not produced by insert/delete cracks, and returning matches prior behavior. **No defect.**

### Checked: empty/single-leaf-root edge case
Empty root (`branches.length === 0`, `entries.length === 0`): off-crack `find` gives `leafIndex = 0`; get-on false; `0 < 0` false → falls through; `last = -1`, loop skipped, `found = false` → sets end crack, `on = false`. Correct. **No defect.**

### Checked: descending path (`internalPrior`) — untouched, independently verified correct
`internalPrior` (btree.ts:427) has no get-on logic by design: from any off-crack it decrements to the entry below the crack, which is the correct descending predecessor for interior, end-of-leaf, and beginning-of-leaf cracks alike. There is **no symmetric bug**, so the implementer's decision to leave it untouched with no new tests is correct. **No defect, no ticket.**

### Checked: test correctness
- Fractional test: `firstLeafMax + 0.5` routes into leaf1 (numeric comparator, separator = `leafMax+1`), landing on the end-of-leaf crack — exactly the target path. Count `200 - expectedFirst` and `results[0] === leafMax+1` are correct.
- Delete test: leaf1 `[0..31]`, `leafMax = 31`; delete 31; range `[31, ∞)` inclusive → `32..64` = 33 entries. `expectedCount = 65 - 31 - 1 = 33` is correct.
- Confirmed both tests exercise the bug (would return 0 results without the fix).

### Checked: build + tests
`yarn build` (tsc type-check across the monorepo) exits 0. `yarn test` in db-core: **1039 passing**. No ESLint config exists in the repo (no `.eslintrc*`/`eslint.config*`, no lint script) — nothing to run.

### Tripwires (recorded, not filed)
- **Delete-driven test coupling** — the test relies on `internalDelete` only refreshing the parent separator when index 0 is deleted (btree.ts:479); if that changes, the test's stale-separator assumption breaks. Already documented in the implement handoff; left as knowledge here rather than a code comment since it's a test-design dependency, not a code-site concern.
- **Multi-level branch-pop not directly targeted** — the new tests pop a single branch level. The fall-through reuses the pre-existing branch-popping code, which is already exercised by the full forward-scan tests (200- and 2200-entry sequential scans through the on-last-entry path). Coverage is adequate; no new test warranted.

### Minor / major findings
None. The fix is minimal, correct, and equivalent for all non-buggy cases; tests are sound; build and full suite green.
