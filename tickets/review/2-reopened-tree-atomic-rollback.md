description: A tree loaded back from storage used to leave half-finished edits behind when a change failed partway through; it now discards the whole failed change cleanly, the same way a freshly created tree already did.
prereq:
files: packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/btree/btree.ts, packages/db-core/test/tree.spec.ts
difficulty: medium
---

## Summary

The tree collection's `"replace"` action handler used to ignore the `Atomic` store that
`Collection.internalTransact` hands it and instead mutated a captured outer `BTree`. On a
**reopened** collection that btree wrote straight into `collection.tracker` with no rollback
wrapper, so a mid-change error (e.g. a store error partway through a leaf split, or a bad
entry late in a multi-entry replace) left partial node writes staged with no way to undo them.
Freshly created trees happened to avoid this because `BTree.create` installs an `AtomicProxy`
that gives per-operation rollback; reopened trees had strictly weaker atomicity.

**Fix (recommended option from the implement ticket).** The `"replace"` handler now binds a
throwaway `BTree` to the `Atomic` store it is handed (`trx`) and mutates through that, instead
of the captured btree. `internalTransact`'s all-or-nothing wrapper now actually governs the
action: if any entry throws, `atomic.commit()` is skipped and every staged node write from the
action is discarded — **whole-action** rollback, identical for created and reopened trees. This
also removes the create-vs-reopen divergence at the source (neither path relies on the btree's
own `_proxy` for action atomicity) and stops the outer `Atomic` from being dead code.

The read path is unchanged: `Tree` keeps its persistent `this.btree` over `collection.tracker`
for all reads; only the mutation path moved to `trx`. After `atomic.commit()` folds the action
into `collection.tracker`, the read btree's trunk re-reads the updated root, so reads observe
the change. `createHeaderBlock` still uses `BTree.create` to bootstrap the root on first creation.

### The one non-obvious part — REVIEWER PLEASE SCRUTINIZE

The implement ticket's recommended fix, applied verbatim, **breaks the existing
`should handle path validity` test** — a subtlety the ticket did not call out. Here is why and
what I did:

- `BTree` hands out `Path` objects stamped with an internal `_version` counter, and
  `isValid(path)` returns `path.version === this._version`. Every mutating op bumps `_version`,
  so a `Path` obtained before a mutation reports invalid afterward (a real safety guard: a held
  path references old in-memory node objects that a later mutation makes stale).
- The OLD handler mutated `this.btree` directly (the captured btree **is** the same instance as
  the read btree), so a `replace` bumped `this.btree._version` for free.
- The NEW handler mutates a *throwaway* btree bound to `trx`, so `this.btree._version` never
  moves and held paths wrongly stay "valid".

To preserve the guard I added a small public method `BTree.invalidatePaths()` (just
`++this._version`) and call it at the end of the `"replace"` handler via the captured `btree`
reference. This bumps the read btree's version once per action — enough to invalidate any held
path (granularity does not matter; `isValid` is an equality check). It fires on the normal `act`
path **and** on the conflict-`replayActions` path (both go through the handler), matching the
old behavior where replay also bumped the version. The bump is unconditional (even a no-op /
empty replace bumps) — over-invalidation is always safe (never wrongly retains a stale path).

If the reviewer prefers, an equivalent alternative is to bump from `Tree.replace`/`Tree.stage`
after a successful `act` instead of inside the handler; I chose the handler because it also
covers the internal replay path, which is the more faithful match to the pre-fix behavior.

## What changed (three files)

- `src/collections/tree/tree.ts` — rewrote the `"replace"` handler: build
  `new BTree(trx, new CollectionTrunk(trx, id), keyFromEntry, compare)` per action, run
  `upsert`/`deleteAt` through it, then `btree?.invalidatePaths()`. (`id`, `keyFromEntry`,
  `compare`, `CollectionTrunk`, `BTree` are all already in scope.) The outer `btree` variable is
  still used for `createHeaderBlock` bootstrap and as the read btree passed to the `Tree` ctor.
- `src/btree/btree.ts` — added `invalidatePaths()` public method next to `isValid`.
- `test/tree.spec.ts` — two new tests + imports (`isTransformsEmpty`, `copyTransforms`).

## Use cases for testing / validation

**Primary behavior — a failed replace stages nothing (the two new tests):**
- *Reopened tree* (`atomic rollback of a failed replace › reopened tree leaves no partial staged
  mutations when a replace fails midway`): create+commit a seed so a header exists → reopen via a
  second `Tree.createOrOpen` (hits the `new BTree(collection.tracker, …)` reopen path) → assert
  the reopened tracker starts empty → issue a two-entry replace `[[1, good], [2, POISON]]` where a
  poison `keyFromEntry` throws on the second entry → assert it throws and that
  `isTransformsEmpty(tracker.transforms)` is true and `getPendingActions()` is empty (entry 1's
  node writes went to the discarded `Atomic`).
- *Freshly created tree, create/reopen parity* (`… freshly created tree rolls back a failed
  replace identically`): create but do NOT sync (header/root live uncommitted in the tracker) →
  snapshot `copyTransforms(tracker.transforms)` → run the same poison two-entry replace → assert it
  throws and the tracker deep-equals the pre-replace snapshot.

**I verified these two tests genuinely discriminate the bug:** I temporarily reverted the handler
to its pre-fix form and re-ran — both new tests FAIL (partial mutations remain staged), while
`should handle path validity` still passes on the old code. With the fix restored, all pass. So
the tests are a real regression floor, not tautologies.

**Guard against my own change — path invalidation still works:** the pre-existing
`should handle path validity` test (tree.spec.ts) covers that a `replace` invalidates a
previously-found path; it passes because of `invalidatePaths()`. `key-changing update should
complete delete before re-find`, `should handle entry updates/deletions/batch operations`, the
`concurrent creation` recovery test, and the BTree fuzz suite also all pass.

## Known gaps / honest flags for the reviewer

- **No explicit reopen happy-path read-back test.** Successful `replace`-then-read on a *reopened*
  tree is only covered indirectly (via `multiple tree instances` / `concurrent creation`). A
  reviewer may want a direct "reopen → replace → get() returns the value" test to pin the commit-
  fold + re-read path on the reopen branch specifically. I judged existing coverage sufficient but
  did not add it.
- **`invalidatePaths()` granularity/timing differs from the old code.** Old code bumped `_version`
  *per successful op* (so a failed multi-entry replace still bumped for the entry that succeeded
  before the throw). New code bumps *once per action, only on full success* — a fully-failed
  replace now bumps nothing. No test depends on the old partial-bump behavior, and the new
  behavior is arguably better, but it is a behavior change worth a glance.
- **Per-action allocation.** Each `replace` now constructs a throwaway `BTree` + `CollectionTrunk`.
  These are cheap ref-holders (no I/O), so I did not treat it as a concern; if replace ever shows
  up as an allocation hot path, the trunk/btree could be memoized against `trx`. Not ticketed, not
  commented (too speculative for a code `NOTE:`); flagged here only.
- **`btree?.` optional chaining in the handler** is defensive. By the time any handler runs (first
  invocation is via `act()`, after the `Tree` is constructed and the outer `btree` assigned), the
  reference is always set; no handler runs during `createOrOpen`. The `?.` costs nothing and guards
  against future reordering.
- **Docs:** I checked `docs/transactions.md` and `docs/internals.md`. They document
  transaction-level / multi-collection cluster atomicity, not the single-collection `Atomic`
  action-handler wrapper, so there is no section describing the behavior this ticket changed —
  I added nothing (per the ticket's "skip if no such section exists").

## Validation performed

- `yarn build` (tsc) at repo root → clean, exit 0 (all packages compiled).
- `packages/db-core` `yarn test:verbose` → **1101 passing, 0 failing** (was 1099; +2 new tests).
- Confirmed the two new tests fail against the reverted handler and pass against the fix.

## Pre-existing test failures (NOT this ticket)

Root `yarn test:verbose` walks all packages and stopped at `packages/db-p2p`, which reports
**5 failing** tests — all in the `cohort-topic` subsystem (RegisterV1 wire validation rejecting
test fixtures whose `correlationId` is 11–13 bytes; the validator requires 16). These live in
`cohort-topic/wire`, a module this ticket never touches, and trace to the recent
`2.5-cohort-topic-wire-validate-hoist` change (stale db-p2p fixtures vs. the hoisted validator).
db-core's own suite is fully green. Documented in `tickets/.pre-existing-error.md` for the
runner's triage pass; out of scope here.
