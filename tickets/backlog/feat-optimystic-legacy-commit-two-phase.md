description: In the default commit mode, saving to a table and its indexes together isn't fully all-or-nothing; move the likely failure earlier so those saves either fully succeed or fully undo, shrinking the window where data can end up half-written.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transaction/coordinator.ts, docs/transactions.md
difficulty: hard
tradeoffs: The honest-failure half already shipped, so a split no longer masquerades as a rollback; the remaining narrowing means restructuring the most safety-critical sync loop in db-core, and getting it wrong corrupts the durable log format.
----

# Narrow the legacy multi-tree commit window (pend-all-then-commit-all)

## Background

The implement ticket `optimystic-legacy-commit-not-atomic` shipped the **honest-
failure** half of the fix: in legacy (default, no-coordinator) mode, when the
commit sweep flushes several trees (main table + secondary indexes, or two tables
in one SQL transaction) and a flush fails **after** the first tree already
committed to storage, the bridge now raises a loud `PartialCommitError` naming the
persisted vs. unpersisted trees instead of silently faking a rollback. That stops
the data-corruption-masquerading-as-rollback, but it does **not** make the commit
atomic — a real split on disk can still happen.

This ticket is the **preferred narrowing** that was deferred from that pass.

## What "narrow the window" means

Today each dirty tree is flushed with an independent `tree.sync()`, and each sync
is its own pend→commit against the transactor (`TransactorSource.transact` does
`pend` then `commit` back-to-back per tree). So the *first* durable commit happens
before we even know whether the *second* tree will pend cleanly. The failures we
most expect — stale-read / write-conflict / constraint-validation rejections —
surface at **pend**. Because pend of tree 2 happens only after commit of tree 1,
those common failures can still leave tree 1 durably written.

The fix is to restructure legacy commit into two phases mirroring the coordinator:

1. **Pend** every dirty tree's staged transforms to the transactor (no commit).
2. If **all** pends succeed → **commit** every tree.
   If **any** pend fails → **cancel** all pended trees and roll back in-memory
   (clean: nothing was durably committed).

After this, a pend-time failure (the common case) is truly all-or-nothing. Only a
failure during the final commit sweep remains a partial window — and that is the
same residual window the distributed consensus path already has (its
`commitPhase` commits critical blocks via `Promise.all`). So this does not claim
perfect durable atomicity; it shrinks the exposure to just the commit sweep.

## Why it was deferred (the hard part)

Two candidate implementations were evaluated; both are non-trivial:

- **Split Collection's sync into pend / commit phases.** `Collection.sync()` →
  `syncInternal()` wraps `TransactorSource.transact()`, which does `pend` then
  `commit` (and `cancel` on failure) as one unit, all inside a retry/stale-replay
  loop with backoff, multi-batch pending, and `updateInternal()` re-fetch on
  conflict. Exposing a "pend-only, hold the pended blockIds, commit later" step
  means restructuring that core loop so it can yield after pend and resume commit
  across N collections. This touches the most safety-critical sync machinery in
  db-core and must preserve the retry/replay/abort semantics exactly.

- **Route legacy commit through a locally-constructed `TransactionCoordinator`.**
  The bridge already keeps a live `collectionRegistry` (`getCollectionRegistry()`)
  and the coordinator's `commit()` already does pend-all-then-commit-all reading
  each `collection.tracker.transforms`. BUT in legacy mode the vtab stages via
  `tree.stage()` = `collection.act()`, which does **not** append the action to the
  collection log — the log-tail append is done by `syncInternal` via
  `Log.addActions`. The coordinator's `commit()` reads raw tracker transforms and
  does not call `Log.addActions`, so routing legacy staging through it risks
  producing a **different on-disk log structure** than the current sync path. This
  needs verification against session-mode's actual log-append behavior before it
  can be trusted (session mode may rely on a different staging path). Getting this
  wrong corrupts the durable log format, so it must be proven equivalent first.

Either path is a focused but genuinely risky refactor of core commit/sync/log
code, out of proportion to the honest-failure minimum that already shipped.

## Requirements

- Legacy multi-tree commit pends all dirty trees before committing any; a pend
  failure cancels all pends and rolls back in-memory with nothing durably written.
- The residual (commit-sweep) failure still surfaces as `PartialCommitError` — do
  not regress the honest-failure behavior.
- On-disk log/block structure after a successful legacy commit must be
  **byte-for-byte equivalent** to the current per-tree-sync path (prove via a
  reopen test that reads committed state; ideally compare block layout).
- Preserve every existing guarantee: deferred-constraint whole-txn rollback,
  statement-level savepoints, PK-move uniqueness, secondary-UNIQUE enforcement,
  session-mode commit/rollback. All current plugin specs must stay green.

## Use cases / tests to add

- Two dirty trees (main + one index, or two tables in one txn); inject a
  transactor whose **pend** fails on the second collection. Assert: nothing
  persisted, in-memory clean, a clean rollback error (NOT `PartialCommitError`),
  reopen shows the pre-transaction state.
- Same harness but failing the **commit** (not pend) of the second collection —
  assert the residual `PartialCommitError` path still holds (this is unchanged
  from the shipped minimum; `legacy-commit-atomicity.spec.ts` already covers it,
  extend rather than duplicate).
- A successful two-tree commit produces on-reopen state identical to the current
  path (guards against a log-structure regression from either implementation).

## Reference

Full analysis and the shipped honest-failure minimum:
`tickets/complete/optimystic-legacy-commit-not-atomic.md` and the
`PartialCommitError` / `commitDirtyTreesLegacy` code in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`.

## Arm, 2026-09-06 — reported from the field as GitHub issue #17, and the header understated who is exposed

An outside consumer (VoteTorrent, on-device n=4 replication proof, `db-p2p` / plugin 0.27.0,
cadre-core 0.12.0) hit this on an ordinary membership write:

```
Legacy multi-tree commit was not atomic: 1 tree(s) were durably committed to storage
before the commit failed and CANNOT be rolled back.
Persisted (now out of sync with the unpersisted trees): [default/CadrePeer].
Not persisted (reverted in-memory only): [default/CadrePeer/index/_uniq_7.stampid].
Underlying failure: sync for collection default/CadrePeer/index/_uniq_7.stampid
exhausted 10 retries: pending conflict: block(s) held by unresolved rival action(s) WbVKD69Qk_UPao9R5GoQNg
```

The row persisted; the unique index enforcing that same row's uniqueness did not. They are explicit
that the *reporting* is not the complaint — `PartialCommitError` named both sets honestly, which is
what the shipped honest-failure half was for.

**The header said "single-node mode" and that is wrong — corrected in this pass.** The branch at
`txn-bridge.ts` selects the legacy sweep whenever `this.session` is null, and a session is created
only when `coordinator && engine && schemaHashProvider` are all wired. That is a function of how the
plugin was constructed, **not of how many machines are in the cohort** — which is why this report
comes from a four-machine deployment. A reader who took "single-node" at face value would have
dismissed it as impossible; that reading has now been removed from the `description:`.

**The scope argument they make, which this ticket did not:** a unique constraint is enforced by its
own separate tree, so **every** insert into a unique-constrained table dirties at least two trees and
is therefore exposed to a half-applied commit. Not a narrow window — an ordinary write path. The
consequence is a database that can no longer enforce a constraint it believes it holds: later inserts
that should collide on the indexed column have no index to collide against, and base table and index
disagree with no local means of reconciliation.

**What triggered it here is separately owned.** The underlying failure is the pend-conflict family
(GitHub issue #18, and `debt-unpromotable-pending-records-need-a-sweep` for the residual). That
matters for prioritisation in both directions: fixing the trigger makes this rarer without making it
safe, and this ticket makes the trigger survivable without making it rarer. They are independent.

**They shipped a runnable reproduction** — `legacy-multi-tree-tear.test.mjs`, three tests, no mesh
and no sockets, using only exported plugin API, deriving the index tree name via
`uniqueEnforcementTreeName` rather than pasting a literal so an upstream rename turns it red. Whoever
picks this up should start from that file rather than writing a fixture; it is in the issue body.
