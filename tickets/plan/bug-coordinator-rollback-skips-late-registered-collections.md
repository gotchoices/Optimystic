description: When a table is opened partway through a transaction and then the transaction is cancelled, the cancelled changes to that table are never undone — they stay staged and get written into the next transaction's saved history.
files:
  - packages/db-core/src/transaction/coordinator.ts (`applyActions` snapshot capture ~94-110; `rollback` earliest-snapshot walk + restore loop ~505-565)
  - packages/db-core/src/collection/collection.ts (`snapshotPending` / `restorePending` ~617-645 — the staged-state pair being captured)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`registerCollection` ~350-362; `collectionRegistry` doc ~236-252; `createSavepoint` / `rollbackToSavepoint` ~910-953 — second site, same shape)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`registerCollections` ~1575-1583 and its caller in `doInitialize` ~678-683; `reconcileMaintainedIndexes` ~2870-2876)
repro: static
difficulty: medium
----

# The defect

A transaction is undone by restoring each collection to a snapshot of its staged
state. The coordinator takes that snapshot once, when the transaction performs its
first write, and it covers exactly the collections registered with the coordinator at
that instant (`coordinator.ts:94-110`).

The set of collections is not fixed. The database adapter keeps a live map and adds to
it as tables open: `registerCollection` is called from a table's initialization, which
happens the first time a statement touches that table — which may be well after the
transaction started writing. The coordinator is handed that same live map, so a
late-registered collection is visible for commit but absent from every snapshot taken
before it appeared.

Cancelling such a transaction therefore never visits that collection. `rollback`
iterates the snapshot map (`coordinator.ts:~545-551`); a collection missing from it is
simply skipped, and both halves of its staged state survive — the in-memory data
picture and the queued action list.

Consequence, same shape as `bug-coordinator-rollback-leaves-pending-queue-populated`:
the next transaction to commit on that collection writes the cancelled transaction's
actions into its own durable log entry, still tagged with the cancelled transaction's
id. A peer replaying that log, or a conflict-driven local replay, turns cancelled work
into live data.

## How a user reaches it

`BEGIN; INSERT INTO a …; INSERT INTO b …; ROLLBACK;` where table `b` had not been
touched earlier in the session. `b` initializes at its first statement, registers its
main collection and index trees then, and so is missing from the snapshot taken during
the `a` insert. The `b` rows survive the rollback.

Registration also happens on `reconcileMaintainedIndexes` (index re-declare), which
registers index trees for an already-open table.

Not reproduced at runtime — read from the code. A test that would confirm it: drive the
coordinator directly, write through one collection, add a second collection to the live
map, write into it through the same stamp, roll back, then assert the second
collection's `getPendingActions()` is empty and its tracker carries no transforms.

# Second site, same shape

`TransactionBridge.createSavepoint` (`txn-bridge.ts:~922-928`) captures the same kind of
map — every collection registered *at that moment* — and `rollbackToSavepoint` restores
only what it captured. A table opened after a statement-level savepoint was created is
not restored when that statement aborts, so a failed statement's partial rows stay
staged. This path is legacy (staged-tracker) mode only; session mode leaves the
savepoint map empty and routes rollback through the coordinator.

The two sites share one root: **a snapshot map that silently means "whichever
collections happened to be registered when I was taken".** Design the fix so both are
covered, or state plainly why the savepoint arm is deliberately left alone.

# What the design has to establish

The original filing of this bug argued that any late capture is unsound, because
`rollback` restores to the *earliest* snapshot chosen by a per-transaction `order`
counter, and `order` implies capture time only while every snapshot is taken eagerly at
first-write. Capturing a collection lazily on first touch does break that: a
lower-`order` transaction could capture a collection after a higher-`order` one already
staged into it, and restoring that entry would keep the cancelled write.

Reading the registration sites suggests a narrower fix that does not have that problem,
and the plan should test this claim first because it decides how large the change is:

**A top-up at registration time is not a lazy capture.** `registerCollection` is
documented and called *before any DML against that collection*. If, at registration,
the coordinator adds the collection's current (untouched) staged state into every
in-flight transaction's snapshot, all those entries describe the same clean state, so
"which one is earliest" no longer matters for that collection. The ordering invariant
is untouched.

That argument holds only if the collection really is untouched at registration. Two
cases to check before relying on it:

- **Re-registration of an already-staged collection.** `registerCollection` is
  idempotent by collection id and is called again on paths like
  `reconcileMaintainedIndexes`. A top-up must fire only when the id is genuinely new to
  the map, never on a repeat registration of a collection that has since been staged
  into — that would capture dirty state as "before", and rollback would then preserve
  the very actions it should discard.
- **Re-initialization producing a *new* `Collection` instance for an existing id.** If
  a table re-initializes mid-transaction and registers a different instance under the
  same id, the snapshot entries held for the old instance are meaningless and the new
  instance's staged state is unaccounted for. Decide whether that is reachable and, if
  so, what the correct behaviour is.

If either case makes the top-up unsound, fall back to the heavier design the original
filing described: an explicit monotonic capture sequence per snapshot entry, with
"earliest" chosen per collection by that sequence rather than by transaction order.

**A notification path is needed either way.** The coordinator is handed the collection
map but is never told when something is added to it — the adapter just mutates the map.
Whatever the capture rule ends up being, the coordinator needs to learn about a new
collection (the adapter calling a coordinator method, the coordinator reconciling the
map at defined points, or the map itself becoming an observable registry). Pick one and
say why; this is the part of the change that touches both packages.

# Related work

- `bug-coordinator-rollback-leaves-pending-queue-populated` (landed) fixed a different
  root cause in the same method: the snapshot restored only the data picture and not the
  queued actions. It neither worsens nor fixes this.
- `bug-coordinator-stamp-snapshots-go-stale-when-a-sibling-commits` (backlog) is a third
  distinct fault at the same site: a committed sibling transaction leaves other
  in-flight transactions' snapshots describing a pre-commit world. Independent of this
  one; no ordering dependency between them, but a design here that reshapes how
  snapshots are stored should note the interaction.

# Out of scope

Making the coordinator's per-transaction undo model correct under genuinely concurrent
transactions on one coordinator. That is the sibling ticket's territory and, per its
own filing, may be answered by refusing concurrent transactions rather than supporting
them.
