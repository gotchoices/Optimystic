----
description: Reviewed and confirmed three landed correctness fixes — change-set merging no longer drops operations, overlapping atomic updates no longer corrupt each other, and a B-tree rebalance now lands on the right child — and filed two related latent-bug tickets found along the way.
prereq:
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/atomic-proxy.ts, packages/db-core/src/btree/btree.ts, packages/db-core/test/transform.spec.ts, packages/db-core/test/btree.spec.ts
----

Adversarial review of the three fixes from `implement/2-transform-merge-and-atomic-concurrency`. All three are correct. Build (`tsc`) clean; full db-core suite green at **1110 passing** (was 1109 — added one regression test in this pass).

## What landed (recap)

- **(a) `mergeTransforms`** (`helpers.ts:74`) — for a block id on both sides, concatenates `[...aOps, ...bOps]` instead of letting b replace a; dedupes `deletes`. Inserts stay last-wins.
- **(b) `AtomicProxy`** (`atomic-proxy.ts`) — top-level `atomic()` calls serialize through a promise queue; genuine nesting is made explicit via an opaque `AtomicScope` handle threaded `merge() → updateAt()`. Replaces the old ambiguous `_active !== _base` "already nested" check.
- **(c) `rebalanceBranch` left-merge** (`btree.ts:759`) — captures `leftLen` before the append and shifts the path index by it, mirroring `rebalanceLeaf`.

## Review findings

### Correctness — verified, no defects in the diff

- **(a) mergeTransforms:** Re-derived all four update cases (a-only, b-only, both, neither) and the deletes dedupe. Correct and order-preserving. Aliasing is no worse than the pre-existing shallow-merge behavior (shared-key path now produces a *fresh* concatenated array; a-only/b-only keys share refs exactly as before). Callers that need isolation still go through `copyTransforms`. The disjoint production caller (`concatTransforms → distinctBlockActionTransforms` in `network-transactor.ts`) is unaffected — concat/dedupe are no-ops on disjoint ids.
- **(b) AtomicProxy serialization:** Traced the queue by hand. The entry check `parent === _current` and the `_tail`/`release` handoff are all set synchronously with no `await` between read and write, so single-threaded JS cannot interleave two scopes onto one tracker. `release()` sits in `finally`, so a *failed* scope cannot poison the queue or deadlock a waiter. Verified the "only nesting site is `merge → updateAt`" claim exhaustively: the six atomic-wrapped methods (`insert`, `updateAt`, `upsert`, `merge`, `deleteAt`, `drop`) call only non-atomic `internal*` helpers plus that one threaded `merge → updateAt` — no un-threaded re-entrancy exists that would deadlock under the new mutex.
- **(c) rebalanceBranch:** Confirmed the fix mirrors the leaf path at `rebalanceLeaf` (`btree.ts:701-704`), which reads the pre-append sibling length directly. The white-box regression test asserts the *applied shift delta* (`idxOut - idxIn === leftLen`), which is robust to the stale incoming index — the right invariant to pin. Agreed with the implementer's judgment to keep the test rather than demote to a tripwire: it pins the arithmetic, guards re-regression, and goes live the moment a path-reuse consumer exists. The suggested `btree.property.spec.ts` reused-path fuzzing remains genuinely blocked (version guard on post-delete paths; insert/upsert paths split rather than merge) and correctly deferred.

### Tests — one gap closed inline (minor)

- Added `btree.spec.ts` › "a failed in-flight scope releases the serialization queue for a scope queued behind it". The existing `atomic rollback` tests await sequentially, so they only cover the new mutex's release-on-error path *indirectly*. The new test fires a rejecting scope and a second scope queued behind it (un-awaited) and asserts the second still commits — if `release()` weren't in `finally`, it would hang rather than fail. Deterministic; drives `AtomicProxy` directly.
- Happy path, edge (25-insert burst), nesting, and rollback are all covered by the implementer's tests; verified they exercise the real `AtomicProxy` (`BTree.create` wires `_proxy`, so the concurrency tests are not vacuous).

### Tripwire recorded (conditional, not a ticket)

- **`rebalanceLeaf` left-merge tolerated staleness** — same class as (c): the leaf left-merge fixes `leafIndex` but leaves the parent-branch index up the path pointing at the deleted leaf's old slot. Harmless today (post-delete paths are version-bumped and abandoned). Recorded as a `NOTE:` comment at the site (`btree.ts` rebalanceLeaf left-merge branch) so a future path-reuse effort audits *both* left-merge sites, not just `rebalanceBranch`.

### Major — filed as backlog tickets (out of this diff's scope)

- **`debt-concat-transform-overlapping-updates`** — `concatTransform` (singular, `helpers.ts:152`) still has the exact clobber that (a) fixed in `mergeTransforms`: `{ ...updates, [blockId]: transform.updates }` overwrites existing ops for a shared block id, and `deletes` isn't deduped. **Dormant** — every current caller passes disjoint block ids, so it never fires today; it's a latent data-loss trap, hence `debt-`. Fix mirrors (a) and flips the existing behavior-documenting test.
- **`bug-storage-repo-missing-transforms-empty`** — found while auditing `concatTransform` callers: `perBlockActionTransformsToPerAction` in `db-p2p/storage-repo.ts` (~line 571) **discards** `concatTransform`'s return value (`concatTransform` is pure), so `acc.transforms` stays `emptyTransforms()` and every multi-block missing action comes back empty. **Pre-existing and in a different package** — not introduced by this diff; filed as `bug-` with a reachability-check-first requirement.

## Validation

```
cd packages/db-core
yarn test    # 1110 passing, exit 0
yarn build   # tsc, exit 0
```
Only db-core was built/typechecked (`yarn build` is in-package `tsc`); (b)'s signature changes are additive/optional and `AtomicProxy.atomic` is called only by `BTree`, so db-p2p / quereus-plugin are expected unaffected but were not built here.
