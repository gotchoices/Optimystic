----
description: Reviewed and completed two missing-await fixes in the B-tree (backward iteration and key-changing update) plus their regression tests, and reverted an unrelated docs rewrite the implement stage had bundled in.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/tree.spec.ts, AGENTS.md
difficulty: easy
----

## What was done (implement stage)

Two one-line correctness fixes in `packages/db-core/src/btree/btree.ts`, each with a regression test in `packages/db-core/test/tree.spec.ts`:

- **`prior()` (line 280)** — added `await` before `this.movePrior(newPath)`. `movePrior` → `internalPrior` is async (loads a sibling leaf from the store when the cursor is at leaf index 0). Without the await, `prior()` returned a path still being mutated. Now symmetric with `next()` above.
- **`internalUpdate` key-change path (line 463)** — added `await` before `this.internalDelete(await this.find(oldKey))`. `internalDelete` is async (calls `rebalanceLeaf`). Without the await the rebalance raced the following `find(newKey)`, and any rebalance error became an unhandled rejection that bypassed the `atomic()` rollback.

## Review findings

Checked: correctness of both awaits, symmetry with sibling methods, test validity (do they actually catch the bug), test/lint pass, scope of the diff, docs.

- **Correctness — CONFIRMED good.** Both awaits are the right fix. `movePrior`/`internalPrior` and `internalDelete`/`rebalanceLeaf` are genuinely async; the parent already awaits every other call to these routines (`moveNext` in `prior`, `internalDelete` in `deleteAt`). The change makes `prior()` symmetric with `next()` (btree.ts:265) and the delete-then-reinsert consistent with the awaited insert on the line above it.
- **Tests — CONFIRMED valid.** `prior() should cross leaf boundary` inserts 65 entries (capacity 64) forcing a split, so navigating to key 65 and calling `prior()` takes the async sibling-load branch — without the fix the assertion `key === 64` sees the un-resolved path (still key 65). `key-changing update should complete delete before re-find` inserts 70 entries so the `updateAt(35 → 1000)` delete triggers cross-leaf rebalance. Both genuinely exercise the async branches, not just the happy path.
- **Scope creep — FOUND and fixed inline (minor).** The implement commit (2b63c60) also rewrote **AGENTS.md** in full — an unrelated "caveman"-style compression of the contributor guide (dropped detail, stripped the trailing newline). Nothing in this ticket touches AGENTS.md. Restored it to its pre-ticket state (`git show 37b38eb:AGENTS.md`). The two btree/test changes are the only source edits this ticket should carry.
- **`(tree as any).btree` cast in test 2 — accepted, not a finding.** The `internalUpdate` key-change path is not reachable through the `Tree` wrapper's public API (`replace` → `upsert`, keyed on `entry.key`), so exercising the delete-then-reinsert path requires reaching the underlying `BTree.updateAt`. The public `BTree.updateAt` is already tested directly in `btree.spec.ts` ("should handle updates correctly"), but only on a 3-entry tree with no cross-leaf rebalance; the new test adds the rebalance coverage. The cast is the pragmatic way to reach it without widening `Tree`'s surface. No new ticket warranted.
- **Pre-existing diagnostics — not this ticket's.** The `describe`/`it` "not found" TS diagnostics in tree.spec.ts, and the `'await' has no effect` diagnostic at btree.ts:515 (`await this.store.insert(newBranch)`), predate this change and affect unrelated lines. Left as-is.
- **Tripwires — none.** Both fixes are unconditional correctness patches; no "fine now, breaks if X" concern to park.

## Test results

`yarn test` in `packages/db-core`: **1037 passing** (includes the two new regression tests).
