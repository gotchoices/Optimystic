description: Range scans over the sorted-key index can silently return nothing when the starting key falls right at the end of a node; fix the forward-step so it walks into the next node.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: easy
----

## Summary

`BTree.range({ first: <key> })` returns zero results when `<key>` lands on an
"end-of-leaf crack" — the cursor position produced by `find(key)` when the key
is greater than every entry in the leaf it routes into, yet still less than the
parent separator to the next leaf. The scan should step forward into the next
leaf and return all subsequent entries; instead it stalls and yields nothing.

Root cause confirmed by reproduction (see below) and by a temporary patch that
made the failing case pass with the full suite green (1038 passing).

## Reproduced

A repro test was written and run against `packages/db-core/src/btree/btree.ts`:
insert `0..199` (forces a multi-leaf tree; first leaf holds `0..31`), then
`range({ first: 31.5 })`. Expected first result `32`; actual result: **empty**
(`at(path)` returned `undefined`). Matches the ticket exactly. The test file was
removed after confirming — the implementer should add it back properly (see
TODO). Note: the `.5` key exploits the numeric comparator to land strictly
between the first leaf's max (`31`) and the next leaf's min (`32`), i.e. on the
end-of-leaf crack, without needing a delete.

## Root cause

`internalNext` (btree.ts:391) — the forward single-step used by `range`,
`next`, `getCount`, ascending iteration:

```
if (!path.on) {                     // off a crack — try to "get on" at current position
    path.on = <all branch indices in range> && leafIndex in [0, entries.length);
    if (path.on) return;
    // BUG: if get-on failed because leafIndex === entries.length (end crack),
    //      falls out of the if/else entirely and returns without advancing.
} else if (path.leafIndex >= path.leafNode.entries.length - 1) {
    ... branch-popping advance into next leaf ...   // the code that SHOULD run
} else {
    ++path.leafIndex; path.on = true;
}
```

When `path.on` is false and `leafIndex === entries.length`, the get-on check
fails (`leafIndex < entries.length` is false), and because the block is an
`if / else if / else` the branch-popping leaf-advance is skipped. The path stays
off, `internalAscending` (btree.ts:295) sees `path.on === false` and never
yields, so `range` produces nothing.

How the end-of-leaf crack arises from `find` / `getPath` (btree.ts:335): the
branch descent (`indexOfKey`) routes the key into the leaf whose range contains
it, but within that leaf `indexOfEntry` (btree.ts:349) returns
`[false, entries.length]` because the key exceeds every entry there. The ticket
also names the delete path (deleting a leaf's max leaves the parent separator
stale — `internalDelete` only refreshes the separator when index 0 is deleted,
btree.ts:478 — so `find(deletedMax)` lands on the same crack); the fractional
key above is a simpler deterministic trigger for the test.

`internalPrior` (btree.ts:426) handles the symmetric start-of-leaf crack
correctly — it always falls through to its branch-popping advance — which is why
descending scans are unaffected.

`getCount` (btree.ts:245) sidesteps the bug: it forces `leafIndex =
entries.length - 1` and keeps `path.on` true before calling `internalNext`, so it
takes the working `else if` advance branch, never the broken off-crack path.

## Fix (validated)

Restructure `internalNext` so an off-crack path with `leafIndex >=
entries.length` falls through into the same branch-popping leaf-advance the
on-path uses. The validated patch (all 1038 tests passed with it applied):

```ts
private async internalNext(path: Path<TKey, TEntry>) {
    if (!path.on) {	// Attempt to move off of crack
        path.on = path.branches.every(branch => branch.index >= 0 && branch.index < branch.node.nodes.length)
            && path.leafIndex >= 0 && path.leafIndex < path.leafNode.entries.length;
        if (path.on || path.leafIndex < path.leafNode.entries.length) {
            return;	// got on an entry, or an interior crack with nothing to advance into
        }
        // end-of-leaf crack (leafIndex === entries.length): fall through to branch-popping leaf-advance
    } else if (path.leafIndex < path.leafNode.entries.length - 1) {
        ++path.leafIndex;
        path.on = true;
        return;
    }
    // on the last entry of the leaf, or off an end-of-leaf crack: advance into the next leaf
    let popCount = 0;
    let found = false;
    const last = path.branches.length - 1;
    while (popCount <= last && !found) {
        const branch = path.branches[last - popCount]!;
        if (branch.index === branch.node.partitions.length)	// last node in branch
            ++popCount;
        else
            found = true;
    }

    if (!found) {
        path.leafIndex = path.leafNode.entries.length;	// after last row = end crack
        path.on = false;
    } else {
        path.branches.splice(-popCount, popCount);
        const branch = path.branches.at(-1)!;
        ++branch.index;
        await this.moveToFirst(await get(this.store, branch.node.nodes[branch.index]!), path);
    }
}
```

Key points about the shape:
- The advance block is de-nested to the method body so both the on-path
  (last entry of leaf) and the off end-of-leaf-crack path reach it.
- The interior-crack case (`leafIndex < entries.length` but get-on failed —
  e.g. a stale/edge branch index) still returns early, preserving prior
  behavior. Only the true end crack (`leafIndex === entries.length`) advances.
- Single-leaf root (`branches.length === 0`): `last = -1`, loop never runs,
  `found` stays false → sets end crack, `on = false`. Correct (no next leaf).

The implementer may keep this exact form or refactor equivalently, but must
preserve all three behaviors above.

## TODO

- Apply the fix to `internalNext` in `packages/db-core/src/btree/btree.ts`.
- Add a regression test in `packages/db-core/test/btree.spec.ts`: insert
  `0..199`, read the first leaf's max via `(await btree.first()).leafNode.entries`,
  then `range(new KeyRange(new KeyBound(max + 0.5, true), undefined, true))` and
  assert the first yielded entry is `max + 1` and the count is `200 - (max + 1)`.
  (Import `KeyRange`/`KeyBound` from `../src/btree/key-range.js`.)
- Also cover the delete-driven crack per the ticket: insert enough for ≥2
  leaves, delete a first-leaf max key, then `range({ first: that key })` and
  assert the following entries are returned.
- Run `yarn test` (or `npm test`) in `packages/db-core` and confirm all pass;
  stream output (`... | tee /tmp/btree-test.log`).
