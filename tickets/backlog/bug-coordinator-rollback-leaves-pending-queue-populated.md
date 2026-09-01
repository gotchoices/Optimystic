description: Cancelling a transaction rewinds the data in memory but forgets to throw away the list of changes it was going to write. A later transaction on the same data then writes those cancelled changes to storage as if they had been kept.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` field ~61-65, `applyActions` snapshot ~85-101, `rollback` ~487-535)
  - packages/db-core/src/collection/collection.ts (`actInternal` pushes to `pending` ~443-446; `snapshotPending`/`restorePending` ~616-643; `clearPendingActions` ~717-721)
  - packages/db-core/src/transaction/session.ts (`rollback` ~184-197 — the shipped caller)
  - packages/db-core/test/transaction.spec.ts (existing rollback cases at ~1500, ~1539, ~1597, ~1623, ~1651, ~3421, ~3486, ~3767)
repro: static
severity: corruption
likelihood: normal-use
tradeoffs: The fix widens a coordinator-internal snapshot type and touches the replay loop that several existing rollback tests pin, so a maintainer may prefer to bundle it with other transaction-recovery work rather than land it alone.
----

# What goes wrong

Each collection keeps two pieces of staged state: the **tracker transforms** (the in-memory
picture of the data) and the **pending queue** (the ordered list of actions that a commit will
write into the collection's log). Both are populated together — `Collection.actInternal` applies
the action to the tracker and then pushes it onto `pending`.

`TransactionCoordinator.rollback(stampId)` only ever undoes the first of the two. It restores
each collection with `collection.tracker.reset(...)` and never touches `collection.pending`. So
after a rollback the data reads as if the transaction never happened, while the collection is
still carrying that transaction's actions in its queue.

The queue is not inert. `commitOnceLatched` builds each collection's log entry from
`collection.getPendingActions()`. So the next transaction that commits on the same collection
instance writes the rolled-back actions into the log alongside its own, and they become durable.
The rollback is silently undone.

The replay half of `rollback` compounds it: it re-applies the surviving in-flight transactions'
actions through `applyActionsRaw` → `collection.act`, which pushes onto `pending` again. Those
transactions' actions are therefore queued twice, and a later commit of one of them logs each
action a second time.

Found by reading the code while planning
`debt-execute-partial-commit-leaves-an-unsafe-undo-handle`; not reproduced at runtime. What
would confirm it: stage an insert through a session, roll the session back, then stage and
commit a *different* insert through a second session on the same collection instances, and read
the collection's log — the rolled-back row should not be there.

# Why it is reachable in shipped code

`TransactionSession.execute` stages through `coordinator.applyActions`, which is exactly the
path that registers a `stampData` entry, and `TransactionSession.rollback` calls
`coordinator.rollback`. So an ordinary "begin, write, abort, then run another transaction"
sequence on shared collection instances hits it. The existing rollback tests assert on tracker
transforms and on reads, never on `getPendingActions()`, which is why it has gone unnoticed.

Note this is distinct from a *directly staged* transaction (`Tree.stage` and friends, which do
not go through `applyActions`): there `rollback` finds no `stampData` entry and no-ops entirely,
so nothing is half-undone.

# The shape of a fix

The root cause is a representation choice, not a missing line: the coordinator's per-transaction
snapshot records only half of what "staged state" means.

```ts
private stampData = new Map<string, {
    order: number;
    preSnapshot: Map<CollectionId, Transforms>;   // <- only the tracker half
    actionBatches: CollectionActions[][];
}>();
```

`Collection` already has the right pair for this — `snapshotPending()` returns transforms *and*
the pending queue, and `restorePending()` puts both back; `commitOnceLatched` uses them
correctly. Widening `preSnapshot` to hold `CollectionSnapshot` and having `rollback` restore
through `restorePending` makes the half-restored state unrepresentable rather than merely
fixing this instance.

Two things a fix has to work out, which is why this is not a one-liner:

- The replay loop re-derives each surviving transaction's snapshot from live state mid-replay,
  and re-applies its batches through `collection.act` — which re-queues them. Restoring both
  halves means the replay has to leave each replayed transaction's pending queue holding its
  actions exactly once, not twice, and not zero times.
- `rollback` runs without holding the participants' instance latches (documented in a `NOTE:` at
  the top of the method). Any change that widens what it overwrites should re-check that note
  rather than inherit it silently.

# Expected behaviour

- After `coordinator.rollback(stampId)`, no collection's pending queue contains any action from
  the rolled-back transaction, and a subsequent commit on those collections logs only its own
  actions.
- Transactions still in flight when another is rolled back keep their staged work in both halves:
  their transforms are replayed as today, and each of their actions appears exactly once in the
  relevant pending queue.
- A rollback of a stamp the coordinator never tracked stays a no-op.
