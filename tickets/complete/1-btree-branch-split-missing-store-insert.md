description: Growing the sorted-key index past ~2080 entries threw "Missing block" and corrupted the tree, because a newly-created internal node was never saved to storage. Fixed and reviewed.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: easy
---

## What was implemented

Two bugs fixed in `packages/db-core/src/btree/btree.ts`:

### Fix 1 — `branchInsert`: missing `store.insert`

`branchInsert` (line 631) created `newBranch` via `newBranchNode(...)` but never persisted it. On the next lookup the tree tried to load that id and threw `Missing block (block-NN)`. Added `this.store.insert(newBranch)` (line 632), mirroring `this.store.insert(newLeaf)` in `leafInsert` (line 594).

### Fix 2 — `internalNext`: missing `await` on `moveToFirst`

Line 417 called `this.moveToFirst(...)` without `await`. Invisible in a 2-level tree (leaf resolves synchronously); in a 3-level tree `moveToFirst` receives a branch and must `await get(...)` to descend, so the missing `await` left `path.leafNode` stale — a duplicate entry then a skipped child. `internalPrior` already had the correct `await`.

### Regression test

`packages/db-core/test/btree.spec.ts`: inserts 2200 sequential values, verifies every point lookup, and verifies a full forward scan returns `[0..2199]`.

## Review findings

**Verdict: implementation correct. Both fixes verified, one gap closed in-pass.**

### Checked — correctness of the two fixes
- **Fix 1 pairing.** Enumerated every `newBranchNode` / `newLeafNode` call site (btree.ts:514, 593, 631). All three are now paired with a `store.insert`: root-split at 514→515, `leafInsert` at 593→594, `branchInsert` at 631→632. `newBranchNode`/`newLeafNode` (btree.ts:816–824) construct only — they do not auto-insert — so the caller-inserts contract is consistent. No double-insert, no remaining orphan. **Confirmed correct.**
- **Fix 2.** `internalNext` (417) and `internalPrior` (447) are now symmetric — both `await` the descend. Root-split (514) and both leaf/branch inserts use correct async handling. **Confirmed correct.**
- **`await store.insert` inconsistency (non-issue, noted).** `insert` is declared `insert(block: T): void` (block-store.ts:10) — synchronous. Line 515 awaits it, lines 594/632 don't. Awaiting a void return is harmless; not worth churning. Recorded here so a future reader doesn't mistake it for a bug.

### Checked — test coverage; gap closed
- **Descending-scan gap (the implementer's flagged gap #1) — fixed in this pass.** Extended the regression test with a symmetric descending scan (`last()` / `movePrior()`) over the same 2200-entry 3-level tree, asserting `[2199..0]`. This exercises `internalPrior` at depth — the sibling of the code path Fix 2 repaired. Ascending-only coverage would have left `internalPrior`'s depth behavior unverified.

### Checked — docs
- `packages/db-core/docs/btree.md` (Rebalancing / Root changes, lines 168–175, 248) describes split/merge/root behavior at a design level. The fixes *restore* the documented behavior (splits persist their nodes); nothing in the docs contradicted the new reality. **No doc change needed.**

### Tripwire (recorded, not filed)
- **4-level tree untested.** 2200 entries triggers exactly one branch split (3 levels). A third branch split (4 levels) needs ~130,000 entries at NodeCapacity=64 — too slow for the unit suite and not a current use case. Left as the implementer's noted gap #2; only becomes work *if* very deep trees become a real workload, at which point add a 4-level stress test. No code site to tag, so parked here.

### Not my diff — flagged, not chased
- `npx tsc --noEmit` fails with `TS5101: Option 'downlevelIteration' is deprecated` (tsconfig.json:19) under the installed TypeScript. This is a config-level deprecation independent of the btree change and predates this ticket. The project's actual test gate (`yarn test`, node type-stripping via `register.mjs`) compiles and runs clean. Not filed as `.pre-existing-error.md` because the real gate passes; noted here for visibility.

## Test results

`yarn test` (packages/db-core): **1034 passing**, including the extended regression test (forward + descending scan).
