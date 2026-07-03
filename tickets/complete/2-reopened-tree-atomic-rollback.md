description: A tree loaded back from storage used to leave half-finished edits behind when a change failed partway through; it now discards the whole failed change cleanly, the same way a freshly created tree already did.
prereq:
files: packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/btree/btree.ts, packages/db-core/test/tree.spec.ts
difficulty: medium
---

## Summary

The tree collection's `"replace"` action handler used to ignore the `Atomic` store that
`Collection.internalTransact` hands it and instead mutated a captured outer `BTree`. On a
**reopened** collection that btree wrote straight into `collection.tracker` with no rollback
wrapper, so a mid-change error left partial node writes staged with no way to undo them.
Freshly created trees avoided this only because `BTree.create` installs an `AtomicProxy` that
gives per-operation rollback; reopened trees had strictly weaker atomicity.

**Fix (shipped).** The `"replace"` handler now binds a throwaway `BTree` to the `Atomic` store
it is handed (`trx`) and mutates through that. `internalTransact`'s all-or-nothing wrapper now
actually governs the action: if any entry throws, `atomic.commit()` is skipped and every staged
node write from the action is discarded — **whole-action** rollback, identical for created and
reopened trees. Because the read btree is no longer the mutation target, its path-version counter
no longer advances for free, so the handler calls a new `BTree.invalidatePaths()` on the read
btree once per action to preserve the held-path-invalidation guard.

## Review findings

Adversarial pass over the implement diff (commit `6ffc400`), reading every source file the change
touches plus the machinery it depends on (`collection.ts` `internalTransact`/`sync`/`replayActions`,
`atomic.ts`, `atomic-proxy.ts`, `collection-trunk.ts`, `btree.ts` mutating ops + `isValid`).

**Correctness — CONFIRMED sound.**
- *Rollback mechanics:* `internalTransact` builds `new Atomic(this.tracker)`, runs the handler,
  and only reaches `atomic.commit()` on full success. `Atomic.commit()` folds transforms into the
  base tracker; a throw leaves the `Atomic` un-committed and discarded → `collection.tracker`
  untouched. The rewritten handler writes exclusively through that `trx`, so the wrapper — dead
  code before — now genuinely provides whole-action rollback. Verified on both the fresh-create and
  reopen branches.
- *Read-back:* the read btree (`this.btree`) re-reads nodes from `collection.tracker`/`sourceCache`
  every op (no in-memory node cache), so after `atomic.commit()` folds the action in, reads observe
  it. On the created branch reads route through the `AtomicProxy` to the same tracker; the proxy is
  never used for mutation anymore, so there is no double-write conflict. On sync success,
  `replayActions()` resets the tracker and `transformCache()` moves committed data into the cache —
  reads still resolve correctly.
- *Path invalidation:* the new `invalidatePaths()` (just `++this._version`) fires once per action on
  both the normal `act` path and the conflict `replayActions` path, preserving the `isValid` guard
  and the "mutation during iteration throws" contract. The granularity change the implementer flagged
  (old: bump per successful op, so a failed multi-entry replace still bumped for the entry that
  succeeded; new: bump once per action, only on full success) is an *improvement*, not a regression:
  a fully-rolled-back replace leaves the data unchanged, so held paths are correctly still valid and
  should NOT be invalidated. Unconditional over-invalidation on success is always safe.
- *Closure capture:* the handler reads the outer `btree` variable (reassigned at tree.ts:85 after the
  `Tree` is built); closures capture the binding, so `btree?.invalidatePaths()` hits the final read
  btree. The `?.` is dead-defensive (btree is always set by the time any handler runs) — harmless.

**Tests — starting point extended.** The two implement tests (reopen + create-parity failure paths)
genuinely discriminate the bug — the implementer verified both FAIL against the reverted handler while
`should handle path validity` still passes on old code, so they are a real regression floor. **Gap found
and fixed inline:** the ticket had no direct reopen *happy-path* read-back test (success was only covered
indirectly). Added `reopened tree observes a successful replace on read-back` (tree.spec.ts) — reopen →
replace → `get()` returns the new value and the pre-existing committed seed. Full db-core suite now
**1102 passing, 0 failing** (was 1101; build `tsc` clean).

**Docs — checked, nothing to change.** `docs/transactions.md`, `docs/internals.md`, and
`docs/correctness.md` document transaction-level / multi-collection cluster atomicity and the
`ActionHandler` signature, but no section describes the single-collection `Atomic` wrapper that
`internalTransact` puts around each handler (the exact contract this ticket restored: a handler must
write through the store it is passed). Nothing became stale; inventing a new section was out of scope.

**Tripwire (recorded, not ticketed).** Each `replace` now allocates a throwaway `BTree` +
`CollectionTrunk` bound to `trx`. These are cheap ref-holders (no I/O), so it is not a concern now; *if*
`replace` ever shows up as an allocation hot path, memoize the trunk/btree against `trx`. Left as a
handoff note only (too speculative for a code `NOTE:` at the site) — parked here per the tripwire rules.

**No major findings → no new tickets filed.** The db-p2p `cohort-topic` failures the implementer flagged
in `.pre-existing-error.md` were already triaged by the runner (commit `6e28703`) and are unrelated to
this change; db-core's suite is fully green.

## What changed (three files)

- `src/collections/tree/tree.ts` — `"replace"` handler builds `new BTree(trx, new CollectionTrunk(trx,
  id), keyFromEntry, compare)` per action, runs `upsert`/`deleteAt` through it, then
  `btree?.invalidatePaths()`. Outer `btree` still used for `createHeaderBlock` bootstrap and as the read
  btree passed to the `Tree` ctor.
- `src/btree/btree.ts` — added public `invalidatePaths()` next to `isValid`.
- `test/tree.spec.ts` — three tests total (implement's two rollback tests + review's reopen read-back
  test) plus imports (`isTransformsEmpty`, `copyTransforms`).

## Validation performed

- `packages/db-core`: `yarn build` (tsc) clean; `yarn test` → **1102 passing, 0 failing**.
