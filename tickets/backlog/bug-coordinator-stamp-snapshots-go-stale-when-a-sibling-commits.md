description: When two transactions are open on the same data at once, saving one of them writes the other's unsaved changes into the permanent history, and cancelling the other afterwards then re-writes changes that were already saved — so the permanent history ends up disagreeing with what was actually saved.
files:
  - packages/db-core/src/transaction/coordinator.ts (`commitOnceLatched` append loop ~336-366 reads the whole pending queue; finalize loop ~479-490 clears the whole collection and drops only its own stamp entry; `rollback` restore loop ~530-545 restores the now-stale snapshot)
  - packages/db-core/src/collection/collection.ts (`getPendingActions`, `clearPendingActions`, `snapshotPending`/`restorePending` ~616-643 — the collection-wide staged state the coordinator accounts for per transaction)
  - docs/transactions.md (~156-161 — the "each writer needs its own bridge" constraint that keeps this off the production path today)
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: No shipping caller hits it — the database adapter runs one transaction at a time per connection and says so in its docs — so a maintainer could reasonably decide that supporting two simultaneous transactions on one coordinator is a feature to design rather than a bug to fix, and instead close the door by rejecting the second transaction outright.
----

# What goes wrong

The transaction coordinator lets more than one transaction be open at the same time
against the same collections. It tracks each one separately — which actions it staged,
and a snapshot of the collection state from before it started — so that cancelling one
transaction can leave the others' work intact. That per-transaction bookkeeping is a
fiction: a collection holds exactly **one** staged-state, shared by every open
transaction. Saving or cancelling any one transaction operates on that shared state as a
whole.

Two things break as a result. They are two symptoms of the same fact, and they are
listed separately only because they show up at different moments.

**Arm A — saving a transaction writes the other transaction's unsaved work.** When a
transaction is saved, the coordinator builds its permanent history entry from the
collection's whole queue of staged actions. It does not filter that queue down to the
transaction being saved, so anything a second, still-open transaction has staged is
written into the first one's history entry, tagged with the first one's id.

**Arm B — cancelling the other transaction afterwards rewinds past the save.** The
snapshot the coordinator holds for the still-open transaction describes the collection
as it was *before* the other transaction was saved. Saving does not refresh or discard
it. So cancelling the still-open transaction restores that stale snapshot, which puts
back into the staged queue an action that has already been permanently written. The next
save writes it again.

# How it was reproduced

Verified by running it, against `TestTransactor`, with a fresh reader opened on the same
storage after each step so the permanent history is read independently of the
in-memory collection.

Setup: one coordinator, one collection, nothing committed yet.

```
stage action 'A' under transaction A   (coordinator.applyActions)
stage action 'B' under transaction B   (coordinator.applyActions)

coordinator.commit(A)      → permanent history reads ['A','B']   ← arm A: B's unsaved action was written
coordinator.rollback(B)    → permanent history still ['A','B'], but the collection's
                             staged queue now holds A's already-saved action again
stage action 'C', commit   → permanent history reads ['A','C']   ← A written a second time,
                                                                    B's record gone
```

The expected history after that sequence is `['A']` then `['A','C']` — B was cancelled
and should never appear, and A should be recorded exactly once.

# Where the root cause sits

One representational fact, not two bugs: **the coordinator's `stampData` map records
per-transaction snapshots and per-transaction action batches, while the state those
describe (`Collection`'s tracker transforms and pending action queue) belongs to the
collection, not to any transaction.** Every place the coordinator saves or cancels acts
at collection granularity: the save path drains the entire queue and then clears the
entire collection; the cancel path restores an entire snapshot. Nothing reconciles the
other open transactions' bookkeeping with either.

A fix that only filters the queue by transaction id at save time closes arm A and leaves
arm B open, because the stale snapshot is still stale. A fix that only refreshes other
transactions' snapshots at save time closes arm B and leaves arm A open. The two arms
have to be settled together, which is why this is a representation change rather than a
patch: staged state needs to be attributable to a transaction, or the coordinator needs
to stop pretending it can be.

Options worth weighing when this is planned, in rough order of how much they close:

- **Make staged state per-transaction.** Each open transaction stages into its own
  tracker and its own queue; the collection merges at save time. Closes both arms by
  construction and makes the bad state unrepresentable, but it is the largest change and
  touches how reads see staged data.
- **Tag-scoped save and cancel.** Every staged action already carries its transaction id
  (`applyActionsRaw` tags them). Save could take only its own actions and leave the rest
  queued; cancel could remove only its own. This retires the snapshot-and-replay
  machinery entirely, which is where both arms live. The open question is the tracker
  half — transforms are not tagged, so removing one transaction's transforms still means
  a replay of the survivors.
- **Refuse the situation.** Reject a second concurrent transaction on one coordinator
  with a clear error. Cheapest and honest, but it deletes a capability the coordinator's
  own design (the `order` counter, the survivor-replay loop, and the
  "preserve other sessions' transforms" contract in `rollback`'s doc comment) exists to
  provide.

# Why it is not reachable today

The Quereus adapter drives one transaction at a time: `TransactionBridge` holds a single
`currentTransaction`, and a second `BEGIN` adopts the existing one rather than starting a
second. `docs/transactions.md` (~156-161) states the constraint explicitly and warns that
sharing one bridge between two writers corrupts both.

So this is reachable only through `db-core`'s own `TransactionCoordinator` API, which is
exported and does advertise multiple concurrent transactions. A `NOTE:` at the finalize
loop in `coordinator.ts` points here.

# Relationship to other tickets

Third distinct root cause found at `TransactionCoordinator.rollback`, after:

- `bug-coordinator-rollback-leaves-pending-queue-populated` (landed) — cancel restored
  only half of each snapshot. Its fix is what makes arm B write a duplicate rather than
  silently drop a record; the underlying corruption predates it and the fix neither
  causes nor removes it.
- `bug-coordinator-rollback-skips-late-registered-collections` (open) — the snapshot map
  covers the wrong *set* of collections. Independent of this: that one is about which
  collections are in the map, this one is about the map's contents being out of date.

All three are symptoms of the coordinator modelling transaction-scoped state on top of
collection-scoped state. If a maintainer plans any of them, planning them together is
likely cheaper than three separate fixes.
