----
description: Fix three correctness bugs in the change-merging and atomic-update machinery: merging two change sets can silently drop operations, two overlapping atomic operations can corrupt each other, and one B-tree rebalance path lands on the wrong child.
prereq:
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/atomic-proxy.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/btree/btree.ts, packages/db-core/test/transform.spec.ts, packages/db-core/test/btree.property.spec.ts, packages/db-core/test/btree.spec.ts
difficulty: hard
----

Three small, related correctness bugs the review grouped under the merge/atomicity theme. All three are confirmed by reading the code. Each part is independent — do them in any order — but they land as one implement pass and one review handoff.

Test runner: `packages/db-core`, mocha + chai, specs are `test/**/*.spec.ts`. Run with `yarn test` (or `npm test`) from `packages/db-core`. `fast-check` is already a devDependency and is used by `test/btree.property.spec.ts` / `test/transform.property.spec.ts`.

---

## (a) `mergeTransforms` clobbers per-block ops

**Site:** `packages/db-core/src/transform/helpers.ts:74-80`

```ts
export function mergeTransforms(a: Transforms, b: Transforms): Transforms {
	return {
		inserts: { ...a.inserts, ...b.inserts },
		updates: { ...a.updates, ...b.updates },   // <-- b's array REPLACES a's for a shared block id
		deletes: [...(a.deletes ?? []), ...(b.deletes ?? [])]   // <-- duplicates accumulate
	};
}
```

`Transforms.updates` is `{ [blockId]: BlockOperation[] }`. The spread `{ ...a.updates, ...b.updates }` means that for a block id present in *both* `a` and `b`, `b`'s operation array wholly replaces `a`'s — `a`'s operations are silently lost. It happens to be safe for the current caller (`concatTransforms` → `distinctBlockActionTransforms` in `network-transactor.ts`, whose per-block updates are disjoint), but the helper reads as general-purpose and will drop ops for any future overlapping use.

`deletes` also accumulates duplicates (same id from both sides appears twice).

**Expected behavior:** for a shared block id, concatenate `a`'s ops then `b`'s ops (`[...aOps, ...bOps]`) rather than letting one replace the other; dedupe `deletes` to a unique set. Leave `inserts` as last-wins (spread) — the ticket does not change insert precedence, and the "reinserted block precedence" work already settled that.

**Watch out — existing tests assert the BUG.** `packages/db-core/test/transform.spec.ts` has a block "Block ID Collision and Overlap Tests (TEST-1.1.1)" (~lines 193-232) whose cases deliberately assert the *current buggy* output:
- "should silently drop updates from first transform…" asserts `merged.updates[sharedId]` equals `[op3]` (only b's op). After the fix this must become `[op1, op2, op3]`.
- "should accumulate duplicate block IDs in deletes…" asserts the deletes array has `lengthOf(2)`. After the fix this must become `lengthOf(1)` (deduped).
- The insert-overwrite case ("version-b" wins) stays as-is — insert precedence is unchanged.

Rewrite those assertions to the corrected expectations (and rename the `it(...)` titles so they no longer describe the behavior as a bug).

## (b) `AtomicProxy` re-entrancy vs. concurrency

**Site:** `packages/db-core/src/transform/atomic-proxy.ts:32-48` (see also `atomic.ts`, and `BTree.atomic` at `btree.ts:33-35`).

```ts
async atomic<R>(fn: () => Promise<R>): Promise<R> {
	if (this._active !== this._base) {
		return fn();	// Already in atomic context
	}
	const atomic = new Atomic<T>(this._base);
	this._active = atomic;
	try {
		const result = await fn();
		atomic.commit();
		return result;
	} catch (e) {
		atomic.reset();
		throw e;
	} finally {
		this._active = this._base;
	}
}
```

Re-entrancy is detected via `_active !== _base`. That flag cannot distinguish genuine *nesting* (a call made from inside `fn`) from a *second concurrent* `atomic()` started while the first is still awaiting. Every `BTree` mutation (`insert`/`updateAt`/`deleteAt`/`upsert`/`merge`/`drop`) wraps its body in `this.atomic(...)`. Two overlapping un-awaited inserts on a bare `BTree` therefore both see `_active !== _base` on the second call and the second insert runs against the *first's* in-flight `Atomic` — then the first's `commit()` flushes the second's half-finished mutations, even though the class advertises "Re-entrant safe."

**Expected behavior:** nesting is still supported (a genuinely nested `atomic()` call must not start a second tracker or double-commit), but a second *concurrent/foreign* `atomic()` must not share state with an in-flight one.

**Two viable approaches (pick one, document the choice in the review handoff):**
- **Serialize (preferred):** put a promise-queue mutex around `atomic()` so a concurrent second call awaits the first's commit/rollback before starting its own scope. This preserves the "just call insert twice without awaiting" ergonomics the BTree relies on. Genuine nesting must still bypass the queue (detect it — e.g. via an "am I currently the owner of the active scope" async-context/depth marker — so a nested call does not deadlock waiting on the scope it is already inside).
- **Throw on foreign overlap:** if a second top-level `atomic()` arrives while one is active, throw a clear error. Simpler, but it breaks any current caller that fires overlapping un-awaited BTree mutations — audit callers first (`btree.ts` public methods, and anything that drives them) before choosing this.

Distinguishing "nested" from "concurrent" is the crux: the current `_active !== _base` check conflates them. Whatever mechanism you add must answer "is this call reentering the scope I already own?" not merely "is a scope open?".

## (c) Branch left-merge path index off by the merged length

**Site:** `packages/db-core/src/btree/btree.ts:757-767` (the "merge self into left sibling" branch of `rebalanceBranch`).

```ts
if (leftSib && leftSib.nodes.length + branch.nodes.length <= this.nodeCapacity) {
	const pKey = pNode.partitions[pIndex - 1]!;
	this.deletePartition(pNode, pIndex - 1);
	apply(this.store, leftSib, [partitions$, leftSib.partitions.length, 0, [pKey]]);
	apply(this.store, leftSib, [partitions$, leftSib.partitions.length, 0, branch.partitions]);
	apply(this.store, leftSib, [nodes$, leftSib.nodes.length, 0, branch.nodes]);   // <-- appends branch.nodes
	pathBranch.node = leftSib;
	pathBranch.index += leftSib.nodes.length;   // <-- BUG: reads length AFTER the append
	this.store.delete(branch.header.id);
	return this.rebalanceBranch(path, depth - 1);
}
```

`pathBranch.index += leftSib.nodes.length` runs *after* the `apply` that appended `branch.nodes` into `leftSib.nodes`, so `leftSib.nodes.length` is already `original + branch.nodes.length`. The index is therefore shifted too far (by the merged length) and points at the wrong child.

The **leaf-level equivalent** at `btree.ts:699-706` does it in the correct order — it captures the offset *before* the append:

```ts
if (leftSib && leftSib.entries.length + leaf.entries.length <= this.nodeCapacity) {
	path.leafNode = leftSib;
	path.leafIndex += leftSib.entries.length;   // read BEFORE the apply below
	apply(this.store, leftSib, [entries$, leftSib.entries.length, 0, leaf.entries]);
	...
}
```

**Expected behavior:** after a branch left-merge the path still points at the correct child.

**Fix:** capture `leftSib.nodes.length` into a local *before* the `apply` calls and add that captured value to `pathBranch.index` — exactly mirroring the leaf path. e.g.

```ts
const leftLen = leftSib.nodes.length;   // before any apply
... applies ...
pathBranch.node = leftSib;
pathBranch.index += leftLen;
```

**Reproduction is subtle — the existing property suite does NOT catch this.** `test/btree.property.spec.ts` discards the path returned by `deleteAt` and re-derives everything via fresh `find`/`first` scans, so a stale `pathBranch.index` on the *returned* path is never observed. To reproduce, you must exercise the returned/reused path after a branch left-merge fires:
- Build a multi-level tree at small `nodeCapacity` (fan-out 4-8, as `makeTree` does) so branch-level merges actually fire.
- Drive a delete sequence that forces a branch (not just leaf) left-merge — i.e. a branch node under-flows and merges into its left sibling.
- Assert the path is still correct: either navigate down from `path.branches[d].node.nodes[path.branches[d].index]` and confirm it resolves to the expected child block, or add a targeted regression test in `test/btree.spec.ts` that reuses the post-merge path (e.g. via `getCount({ path })` or a range continuation from the returned path) and checks the result matches the model.

Consider also strengthening `btree.property.spec.ts` so at least some operations navigate via a *reused* path (not only fresh finds), which is what turns this class of "stale returned-path index" bug into something the fuzz suite can find — but the primary deliverable is a deterministic regression test that fails before the fix and passes after.

---

## TODO

Phase 1 — merge (a)
- [ ] In `helpers.ts`, rewrite `mergeTransforms` to concat per-block-id update arrays (`[...aOps, ...bOps]`) and dedupe `deletes` to a unique set; keep `inserts` last-wins.
- [ ] Update the "TEST-1.1.1" cases in `test/transform.spec.ts` (~193-232) to assert the corrected behavior (updates concatenated, deletes deduped) and rename their titles away from "BUG".
- [ ] Confirm `concatTransforms`/`distinctBlockActionTransforms` callers still behave (disjoint case unaffected).

Phase 2 — atomic (b)
- [ ] Choose serialize-via-mutex (preferred) or throw-on-foreign-overlap; if throwing, audit `btree.ts` callers first.
- [ ] Implement in `atomic-proxy.ts` so genuine nesting still bypasses (no second tracker / no double commit) while a concurrent/foreign `atomic()` does not share the in-flight `Atomic`.
- [ ] Add a spec: fire two overlapping un-awaited inserts on a bare `BTree` (`BTree.create` with a `TestBlockStore`) and assert the first commit does not flush the second's partial state, and both inserts ultimately land.

Phase 3 — branch merge-index (c)
- [ ] In `rebalanceBranch` (`btree.ts:757-767`), capture `leftSib.nodes.length` before the `apply` calls and use it for `pathBranch.index +=`.
- [ ] Add a deterministic regression test (in `test/btree.spec.ts`) that triggers a branch left-merge and reuses the returned path (fails before fix, passes after).
- [ ] Optional: extend `test/btree.property.spec.ts` to occasionally navigate via a reused path so this bug class is fuzz-reachable.

Phase 4 — validate
- [ ] `yarn test` in `packages/db-core`, streaming output (`yarn test 2>&1 | tee /tmp/db-core-test.log`). Fix regressions.
- [ ] `yarn build` (tsc) to confirm no type errors.
- [ ] Write the review handoff: which atomic() approach was chosen and why, and note that the pre-existing `btree.property.spec.ts` did not cover reused-path index bugs (now addressed).
