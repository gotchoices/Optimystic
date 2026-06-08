description: Cover (and verify) the deferred-DML staging refactor in quereus-plugin-optimystic's TransactionBridge — landed untested, especially the session/consensus commit path. Work scope-leaked into an unrelated commit and references this (previously non-existent) ticket.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - packages/db-core/src/collection/collection.ts (Collection.discardPending)
  - packages/db-core/src/collections/tree/tree.ts (Tree.stage / sync / discardChanges)
----

# Verify + cover the deferred-DML staging refactor (TransactionBridge)

## Origin

This work landed in commit `05faf5f` (`ticket(implement): cohort-topic-antiflood-antidos`) — a
commit whose stated scope is the cohort-topic anti-flood / anti-DoS substrate in `db-core`. The
quereus-plugin transaction-staging changes below are **unrelated to that ticket** and were bundled
in (almost certainly a stray `git add -A` over in-flight working-tree changes). The review of 9.8
flagged the scope leak; this ticket exists to give the orphaned work a proper home, because a
comment inside `txn-bridge.ts` already points readers to a `fix/optimystic-session-mode-commit-composition`
ticket that did not exist until now.

The code **compiles** (`quereus-plugin-optimystic` builds green) and is internally coherent and
well-commented. The concern is **correctness verification and missing test coverage**, not a known
crash.

## What the refactor does

`Tree.replace()` used to stage *and* flush DML in one step (an inline `updateAndSync` per row). The
refactor splits that into:

- `Collection.discardPending()` (db-core) — drop queued pending actions and `tracker.reset()`, so
  reads observe committed source state again. Synchronous, latch-free; intended for rollback when no
  concurrent act/sync is in flight.
- `Tree.stage()` / `Tree.sync()` / `Tree.discardChanges()` (db-core) — deferred counterparts to
  `replace`: stage into the tracker without flushing, then either flush at commit or discard at
  rollback.
- `TransactionBridge` (quereus-plugin) — tracks a `dirtyTrees: Set<DirtyTree>` populated by a new
  `markDirty(tree)` at DML time (main-table tree + each touched index tree). At commit, **legacy
  mode** flushes every dirty tree (`tree.sync()`); at rollback, **both modes** call
  `tree.discardChanges()`.

The motivating fix: Quereus runs deferred (subquery-bearing) row CHECK constraints **before**
`connection.commit()`. Deferring the storage flush to commit means a constraint rejection rolls back
cleanly — the staged trees are discarded never having touched storage.

## The risk to verify

The **session / consensus commit path is deliberately left un-flushed** and is self-described in the
code as untested:

> "The DML path now STAGES into the collection trackers (no inline sync), and the coordinator's
> commit() reads `tracker.transforms` directly, so we deliberately do NOT `tree.sync()` here —
> flushing would reset the trackers out from under consensus. Session-mode commit composition
> against the staging DML path is not yet covered by a real-DML test."

So in session mode, commit relies on the coordinator reading `tracker.transforms` directly while the
trees stay staged. If `markDirty`/staging ever leaves a tracker in a state the coordinator does not
read (or `discardChanges` races a commit that already consumed the transforms), DML could be
silently dropped or double-applied. This needs a real-DML integration test, not just a compile.

## Required outcome

- A real-DML test that exercises **both** commit modes (legacy flush-at-commit and session/consensus)
  end-to-end: insert/update/delete across the main table **and** at least one index tree, commit, and
  assert the rows + index entries are durably present.
- A rollback test proving the deferred-constraint atomicity fix: a subquery-bearing CHECK rejection
  leaves storage untouched (no staged rows, no orphaned index entries) in both modes.
- Confirm `markDirty` actually captures index trees (the comment notes index trees are created with a
  "throwaway txnState" and so do not land in `currentTransaction.collections`) — a regression here
  would silently skip index flush at commit.
- Confirm `discardChanges`/`discardPending` is safe on an already-synced or never-staged tree (the
  code claims "reset of an empty tracker is a no-op").

Note: `quereus-plugin-optimystic` is **not** in the root `yarn build`/test fan-out's test path the
way `db-core` is — check whether this package has a runnable test suite at all, and wire one if the
coverage above has nowhere to live.
