description: When a table is opened partway through a transaction and then the transaction is cancelled, the cancelled changes to that table are never undone — they stay staged and get written into the next transaction's durable history.
files:
  - packages/db-core/src/transaction/coordinator.ts (`applyActions` snapshot loop ~85-101, `rollback` restore loop ~505-535)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`registerCollection` ~350-362, and the comment at ~241-248 describing trees created mid-run)
repro: static
severity: corruption
likelihood: unusual
tradeoffs: The window is narrow — it needs a table to be opened after a transaction has already started writing — and the obvious fix (snapshotting a collection lazily, when a transaction first touches it) breaks an ordering invariant the rollback replay depends on, so a correct fix needs a real capture-ordering change rather than a one-liner.
----

# What happens

The transaction coordinator undoes a cancelled transaction by restoring each
collection to a snapshot it took when that transaction performed its first write.
That snapshot covers only the collections that were registered with the coordinator
*at that moment*.

The set of collections is a live map that the database adapter keeps adding to: a
table (or index tree) opened partway through a run is registered on the
already-constructed coordinator — this is explicit in the adapter, see the comment at
`txn-bridge.ts:~241-248` and the note on `registerCollection` at `~350-362`.

So a collection registered after every in-flight transaction took its snapshot is in
nobody's snapshot map. When one of those transactions is rolled back,
`TransactionCoordinator.rollback` iterates the snapshot map and simply never visits
that collection. Its staged state — both the in-memory data picture and the queued
action list — keeps everything the cancelled transaction wrote.

Consequence, same shape as `bug-coordinator-rollback-leaves-pending-queue-populated`:
the next transaction to commit on that collection writes the cancelled transaction's
actions into its own durable log entry, still tagged with the cancelled transaction's
id. A peer replaying that log, or a conflict-driven local replay, then turns the
cancelled work into live data.

# Why the obvious fix does not work

The tempting change is to snapshot a collection lazily — capture it the first time a
transaction touches it, instead of capturing every collection up front. That breaks
the invariant the rollback replay rests on.

`rollback` restores to the *earliest* snapshot among the cancelled transaction and
all survivors, chosen by an `order` counter assigned when a transaction performs its
first write. Because the snapshot is currently taken at that same moment and covers
all collections, "lowest `order`" also means "earliest in wall-clock time", and the
restore therefore rewinds past every write of every tracked transaction. That is what
makes the subsequent replay land each survivor's work exactly once.

With lazy capture, `order` no longer implies capture time. A lower-`order`
transaction could capture a collection *after* a higher-`order` transaction already
staged into it; picking that entry as "earliest" would restore to a state that still
contains the cancelled write, and the rollback would silently fail to undo it.

A correct fix therefore needs capture ordering to be tracked explicitly — e.g. a
monotonic capture sequence per snapshot entry, with "earliest" chosen per collection
by that sequence rather than by transaction order — plus a top-up capture when a
collection is registered while transactions are in flight. That is a real design
change to how the coordinator represents "state before this transaction", not a
patch.

# How you would confirm it

Not yet reproduced at runtime — inferred from reading the two sites above. To confirm:
open a transaction, write through it, register a second collection with the
coordinator's live map *after* that first write, write into the new collection through
the same transaction, then roll back. Expect the new collection's
`getPendingActions()` to still hold the rolled-back action, and a subsequent commit on
that collection to carry it into the durable entry.

# Relationship to other tickets

Found while designing `bug-coordinator-rollback-leaves-pending-queue-populated`, which
fixes a different root cause at the same method: that one restores only half of each
snapshot (the data picture, not the queued actions). This ticket is about the snapshot
map covering the wrong *set* of collections. The other fix does not make this worse and
does not fix it; either can land first.
