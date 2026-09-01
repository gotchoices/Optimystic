description: Cancelling a transaction rewinds the data in memory but forgets to throw away the list of changes it was going to write. The next transaction on the same data then records those cancelled changes in the durable history as if they had been kept.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` ~60-65, `applyActions` snapshot ~85-101, `rollback` ~487-535, `commitOnceLatched` append ~350-372)
  - packages/db-core/src/collection/collection.ts (`actInternal` pushes to `pending` ~443-446; `CollectionSnapshot` ~90; `snapshotPending`/`restorePending` ~616-643; `getPendingActions`/`clearPendingActions` ~705-721)
  - packages/db-core/src/transaction/session.ts (`rollback` ~184-197 — the shipped caller)
  - packages/db-core/test/transaction.spec.ts (existing rollback cases at ~1500, ~1539, ~1597, ~1623, ~1651, ~3421, ~3486, ~3767)
repro: verified
difficulty: medium
----

# Background: two halves of "staged state"

Every `Collection` stages a pending change in **two** places, and both are written
together by `Collection.actInternal`:

- the **tracker transforms** — the in-memory picture of the data, what reads observe;
- the **pending queue** (`Collection.pending`) — the ordered list of actions that a
  commit records into the collection's durable action log.

`Collection` already models the pair as one value: `CollectionSnapshot` (transforms +
pending + action context), captured by `snapshotPending()` and put back by
`restorePending()`. The commit path uses that pair correctly.

# The defect

`TransactionCoordinator.rollback(stampId)` restores only the tracker half. It calls
`collection.tracker.reset(...)` and never touches `collection.pending`. Its
per-transaction snapshot type only *has* the tracker half:

```ts
private stampData = new Map<string, {
    order: number;
    preSnapshot: Map<CollectionId, Transforms>;   // <- tracker half only
    actionBatches: CollectionActions[][];
}>();
```

Two consequences, both reproduced at runtime (see *Reproduction* below):

**A. Rolled-back actions stay queued and become durable.** After a rollback the
collection still carries the aborted transaction's actions. `commitOnceLatched`
builds each collection's log entry from `collection.getPendingActions()`, so the
*next* transaction to commit on that collection writes the aborted actions into its
own durable log entry — still tagged with the rolled-back transaction's stamp id.

**B. Surviving in-flight transactions get their actions queued more than once.**
`rollback` replays the other in-flight stamps' batches through `applyActionsRaw` →
`collection.act`, which pushes onto `pending` again. Because `pending` was never
reset, the queue ends up holding the phantom action *and* two copies of the
survivor's action.

# What is and is not corrupted

The log entry's **transforms** come from the tracker, which *is* correctly rolled
back — so a local read right after the bad commit still returns the right rows, and
that is why the existing rollback tests (which assert on transforms and on reads)
never caught this. The corruption is in the entry's **action list**, which is what
gets replayed rather than materialized:

- `Collection.updateInternal` calls `replayActions()` on a conflicting sync, which
  re-applies everything in `this.pending` — including the phantom — back into the
  tracker, where it *does* become live data;
- the durable entry's action list is the record other peers and any log-replay
  consumer read.

So the honest statement of impact: reads immediately after the bad commit look fine;
the durable history is wrong, and a conflict-driven replay or a log-replaying peer
turns that wrong history into wrong data.

# Reproduction

Verified against `main` at commit `3a227c1d` with a scratch spec placed in
`packages/db-core/test/`, run from `packages/db-core` with
`node --import ./register.mjs node_modules/mocha/bin/mocha.js <file>`. The scratch
file was deleted afterwards; the three observations were:

1. Stage one action through `coordinator.applyActions`, then `session.rollback()` —
   `usersCollection.getPendingActions()` still returns that action (expected an
   empty array).
2. Stage into two sessions, roll the first back — the queue holds **3** entries: the
   rolled-back action, plus the survivor's action twice.
3. Roll session 1 back, then stage and commit a different action through session 2 —
   the array handed to the log-entry append (observed by wrapping
   `getPendingActions`) contains **both** actions, the rolled-back one still carrying
   session 1's stamp id.

An aborted transaction's stamp appearing inside a *different* transaction's durable
entry is the clearest single symptom to assert on.

# Required behaviour

- After `coordinator.rollback(stampId)`, no collection's pending queue contains any
  action from the rolled-back transaction, and a subsequent commit on those
  collections logs only its own actions.
- Transactions still in flight when another is rolled back keep their staged work in
  **both** halves: their transforms are replayed as today, and each of their actions
  appears **exactly once** in the relevant pending queue.
- A rollback of a stamp the coordinator never tracked (the directly-staged
  `Tree.stage` path, which does not go through `applyActions`) stays a no-op — that
  is already covered by the test at `transaction.spec.ts:~3726` and must stay green.

# Direction for the design pass

The root cause is a representation choice, not a missing line: `stampData.preSnapshot`
records half of what "staged state" means, so half-restored state is representable at
all. Widening it to `Map<CollectionId, CollectionSnapshot<any>>` and restoring through
`restorePending` removes the whole class rather than patching this instance — which is
why this is a design ticket and not a one-liner.

Points the design has to settle:

- **The replay loop must land each survivor's actions exactly once.** Restoring both
  halves to the earliest snapshot may make this fall out for free: the queue is
  rewound to a point before any survivor staged, and the existing replay through
  `collection.act` re-queues each batch once. Confirm rather than assume — including
  the mid-replay `replayData.preSnapshot` refresh, which has to capture both halves
  too.
- **`rollback` runs without holding the participants' instance latches**, documented
  in a `NOTE:` at the top of the method (coordinator.ts:~488). Widening what it
  overwrites means re-deciding whether that note still holds, rather than inheriting
  it silently.
- **Actions staged directly (outside any tracked stamp) after the earliest tracked
  snapshot** would be dropped by a restore to that snapshot. The tracker half already
  behaves this way, so the pending half merely becomes symmetric — but the design
  should say explicitly whether that is accepted (and record it as a `NOTE:` at the
  site) or fixed.
- **Collections registered after the snapshot was taken** are absent from
  `preSnapshot` and so are not restored. Same pre-existing shape on the tracker half;
  decide and document.

Adjacent but out of scope: `restorePending` restores `transforms` and `pending` but
not the `context` that `snapshotPending` captures. Unrelated to this defect; worth a
glance while in the file, not worth widening this ticket for.

`debt-optimystic-session-mode-statement-savepoint-gap` (backlog) uses the same
`snapshotPending`/`restorePending` pair for *savepoint*-scoped rollback. Different
site and scope, so not a prerequisite either way — but whoever designs this should
skim it, since both want the same "staged state is one value" shape and the savepoint
work is easier if this lands first.

# Test coverage the fix should carry

Every existing rollback test asserts on transforms or on reads, never on
`getPendingActions()` — that blind spot is why this shipped. The fix should assert on
the pending queue for the three reproduction scenarios above, and should prefer one
general assertion — after any rollback, no collection queue holds an action tagged
with the rolled-back stamp — over three point cases, so future rollback paths inherit
the guard.
