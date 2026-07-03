----
description: Review three landed correctness fixes — change-set merging no longer drops operations, overlapping atomic updates no longer corrupt each other, and a B-tree rebalance now lands on the right child.
prereq:
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/atomic-proxy.ts, packages/db-core/src/btree/btree.ts, packages/db-core/test/transform.spec.ts, packages/db-core/test/btree.spec.ts
difficulty: hard
----

Adversarial review of the three fixes from `implement/2-transform-merge-and-atomic-concurrency`. All three landed in `packages/db-core`; build (`tsc`) is clean and the full suite is green (**1109 passing**). Treat the tests below as a floor, not a ceiling — part (c) in particular is a latent (currently-unobservable) defect and its regression test is white-box by necessity; scrutinize whether the invariant it asserts is the right one.

---

## What changed

### (a) `mergeTransforms` no longer clobbers per-block ops — `helpers.ts:74`
`mergeTransforms(a, b)` now, for a block id present in **both** sides, concatenates `[...aOps, ...bOps]` instead of letting `b`'s array replace `a`'s, and dedupes `deletes` to a unique set (`[...new Set(...)]`). `inserts` stay last-wins (unchanged, per ticket — insert precedence was settled by the reinserted-block-precedence work).

Tests updated in `transform.spec.ts` "Block ID Collision and Overlap Tests (TEST-1.1.1)":
- the updates-overlap case now asserts `[op1, op2, op3]` (was `[op3]`) and is retitled away from "BUG";
- the deletes case now asserts `lengthOf(1)` (deduped) and is retitled;
- the insert-overwrite case is unchanged (last-wins is intended).

**Verify:** `concatTransforms` (plural, the reducer over `mergeTransforms`) feeds `distinctBlockActionTransforms` in `network-transactor.ts`; its per-action block updates are disjoint, so concatenation and dedupe are no-ops there. Full suite passing corroborates no behavioral change for the disjoint caller.

### (b) `AtomicProxy` — serialize overlapping scopes, keep genuine nesting — `atomic-proxy.ts`, `btree.ts`
**Approach chosen: serialize-via-mutex + explicit scope-token for nesting** (the ticket's preferred option), **not** throw-on-overlap.

Why not the alternatives:
- **`AsyncLocalStorage`** (the textbook way to tell "nested" from "foreign concurrent") is **`node:async_hooks`** — not available in browser/RN. `AGENTS.md:18` requires db-core to "Be cross-platform (browser, node, RN, etc.)", and db-core currently has **zero** `node:` imports. Ruled out.
- **Shared-state nesting detection** (a flag/pointer/counter like the old `_active !== _base`) is **fundamentally ambiguous**: at the instant a second `atomic()` arrives while the first is mid-await, a nested descendant call and a foreign concurrent call see identical state. No synchronous signal distinguishes them. This is the exact defect being fixed.
- **Throw-on-foreign-overlap** would break the "fire two un-awaited inserts" ergonomics the BTree relies on (see the burst test).

Design (`atomic-proxy.ts`):
- Top-level `atomic()` calls take a place in a promise queue (`_tail`); a second, unrelated overlapping call awaits the first's commit/rollback before opening its own `Atomic` tracker. So overlapping un-awaited mutations no longer share one tracker.
- Genuine nesting is made **explicit**: `atomic(fn, parent?)` passes an opaque `AtomicScope` handle into `fn`; a nested call hands that handle back as `parent`. When `parent === _current` (the running scope) the call reuses that scope inline — no second tracker, no second commit, and it skips the queue (so it can't deadlock on the scope it's already inside).
- Threading: `BTree.atomic(fn, parent?)` forwards the handle; the **only** nesting site is `merge() → updateAt()` (confirmed by reading all six wrapped public methods), so only `updateAt` gained an optional trailing `parent?: AtomicScope` and only `merge` threads the scope. `updateAt`'s public 2-arg callers are unaffected (optional param).

Tests (`btree.spec.ts` › "atomic scope concurrency"): two overlapping un-awaited inserts both land (count == 2); a 25-insert un-awaited burst loses none; `merge → updateAt` nesting completes with a single commit and no deadlock.

### (c) Branch left-merge index off-by-length — `btree.ts:757`
`rebalanceBranch`'s "merge self into left sibling" now captures `const leftLen = leftSib.nodes.length` **before** the `apply` that appends `branch.nodes`, and does `pathBranch.index += leftLen` — mirroring the leaf path at `rebalanceLeaf` (`btree.ts:699`). Previously it read `leftSib.nodes.length` **after** the append, overshooting the index by `branch.nodes.length`.

---

## Honesty about part (c) — read before trusting the test

**(c) is a latent defect with no current consumer.** The corrupt index lives only on the path `deleteAt` returns, and that path is deliberately treated as invalid (delete bumps `_version` without refreshing `path.version`), so public navigation on it throws the staleness guard; nor is the index re-read within the same delete (the rebalance recursion only ever reads shallower depths). So:
- **End-to-end scans cannot observe it.** By the time a branch underflows, the child merges that caused the underflow have *already* left the path index stale — a post-delete path carries several intentionally-stale indexes from `rebalanceLeaf` too (measured: 47 "stale" links across one teardown, *with the fix applied*). An earlier oracle attempt (walk the version-refreshed post-delete path) produced garbage on correct code and is not usable.
- **The regression test is therefore white-box** (`btree.spec.ts` › "rebalanceBranch left-merge shifts the path index by the sibling original length"): it wraps `rebalanceBranch` on one instance and, when a left-merge fires (node reassigned to the left sibling), asserts the **applied shift** `idxOut - idxIn === leftLen` (where `leftLen = mergedLen - branch.nodes.length`). This is robust to the stale incoming index because it checks the *delta the merge applies*, which is exactly what the bug got wrong. **Validated both ways:** fails with the buggy line ("shifted by 3, expected 2; off by 1"), passes with the fix. `leftMerges > 0` guards against the test going vacuous if capacity/N change.

**Reviewer judgement calls for (c):**
- Is a white-box shift-assertion the right regression guard, or should this instead be recorded as a tripwire / `debt-` (fix is correct but unobservable) with the test dropped? I kept the test because it pins the arithmetic and would catch a re-regression, and because a *future* path-reuse consumer would make the bug live.
- The ticket suggested also strengthening `btree.property.spec.ts` to navigate via a **reused** path. I did **not** do this: reusing a post-delete path is blocked by the version guard, and reusing a post-`insert`/`upsert` path never exercises a branch *merge* (those split). If you want fuzz coverage of reused-path indexes, it needs a new mutation entry point that returns a still-valid post-merge path — larger than this ticket. Flagging, not doing.

---

## Known gaps / tripwires (index — analysis is above/at the site, not restated here)

- **Sibling bug not fixed (out of scope, flagged for a ticket):** `concatTransform` (singular, `helpers.ts:146`) has the *same* overlapping-updates clobber this ticket fixed in `mergeTransforms` — `{ ...a.updates, ...b.updates }` drops `a`'s ops for a shared block id. An existing test (`transform.spec.ts` "…concatTransform overlaps existing updates (BUG: data loss)") asserts the buggy behavior. Current callers pass **disjoint** block ids (`network-transactor.ts` `pend`, `test-transactor.ts`, db-p2p `storage-repo.ts`), so it is dormant. If you want it fixed for symmetry, it warrants a small `fix/` or `backlog/debt-` ticket (concat updates, dedupe deletes, keep insert last-wins; flip that test's assertion). Not done here to respect ticket scope.
- **Pre-existing tolerated staleness:** `rebalanceLeaf`'s left-merge leaves the deepest-branch parent index pointing past the merged leaf; harmless today because the post-delete path is abandoned. Same class as (c). Noted here so a future path-reuse effort audits `rebalanceLeaf` too, not just `rebalanceBranch`.
- **`updateAt` public signature** gained an optional `parent?: AtomicScope`. Backward-compatible; every external caller uses 2 args. `AtomicScope` is exported from `atomic-proxy.ts` and surfaces in `updateAt`'s `.d.ts`.
- **Only db-core was type-checked** (`yarn build` runs `tsc` in-package). `AtomicProxy.atomic` is called only by `BTree` (verified), and the other signature changes are additive/optional, so db-p2p / quereus-plugin should be unaffected — but they were not built here.
- **Pre-existing hint (not introduced):** `btree.ts:528` `await this.store.insert(...)` — `insert` returns void, so `await` is a no-op (TS 80007). Untouched by this ticket.

## How to validate

```
cd packages/db-core
yarn test 2>&1 | tee /tmp/db-core-test.log     # 1109 passing
yarn build                                      # tsc, exit 0
```
Targeted: `yarn test -- --grep "atomic scope concurrency|rebalanceBranch left-merge|Collision and Overlap"`.
To re-prove (c) is a real regression test: revert `btree.ts:758` back to `pathBranch.index += leftSib.nodes.length` and re-run that grep — the shift assertion fails.
