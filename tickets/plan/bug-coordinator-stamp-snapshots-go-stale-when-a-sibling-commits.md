description: When two transactions are open on the same data at once, saving one of them writes the other's unsaved changes into the permanent history, and cancelling the other afterwards re-writes changes that were already saved — so the permanent history disagrees with what was actually saved. Decide how the coordinator should behave with two transactions open at once, then make it behave that way.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` decl ~84-91; `applyActions`/`captureUncaptured` ~109-161; `applyActionsRaw` action tagging ~168-180; `commitOnceLatched` append loop ~421-434 and success fold ~522-540; `rollback` ~560-630; `execute` savepoint/session commit fold ~919-947)
  - packages/db-core/src/collection/collection.ts (`snapshotPending`/`restorePending` ~617-645, `getPendingActions`/`clearPendingActions` ~705-720 — the collection-wide staged state)
  - packages/db-core/src/collection/action.ts (`Action.transaction` — the per-action stamp tag that already exists)
  - docs/transactions.md (~150-162 — the "each writer needs its own bridge" constraint that keeps this off the shipping path today)
  - packages/db-core/test/transaction.spec.ts (existing coordinator commit/rollback coverage; where a regression test would live)
difficulty: hard
repro: verified
----

# What goes wrong

`TransactionCoordinator` lets more than one transaction stamp be open at the same
time against the same collections. It tracks each one separately in `stampData` —
which action batches that stamp staged, and a snapshot of each collection's staged
state from before the stamp touched it — so that cancelling one stamp can leave the
others' work intact.

That per-stamp bookkeeping is a fiction. A `Collection` holds exactly **one** staged
state — its tracker transforms plus one pending-action queue — shared by every open
stamp. Committing or rolling back any one stamp operates on that shared state as a
whole.

Two symptoms, one cause. They are listed apart only because they surface at different
moments.

**Arm A — committing a stamp writes the other stamp's work into the durable log.**
The append loop builds each collection's durable log entry from
`collection.getPendingActions()` — the collection's *whole* queue. It never filters
to the committing stamp, so anything a second, still-open stamp staged is written
into the first stamp's log entry, tagged with the first stamp's transaction id.

**Arm B — rolling back the other stamp afterwards rewinds past the commit.**
The snapshot `stampData` holds for the still-open stamp describes the collection as
it was *before* the other stamp committed. The commit fold neither refreshes nor
invalidates it — it deletes only its own `stampData` entry. So rolling back the
still-open stamp restores that stale snapshot, putting an already-durable action back
into the pending queue. The next commit logs it a second time.

# How it was reproduced

Verified by running it against `TestTransactor`, with a fresh reader opened on the
same storage after each step so the durable log is read independently of the
in-memory collection. One coordinator, one collection, nothing committed yet.

```
stage action 'A' under stamp A   (coordinator.applyActions)
stage action 'B' under stamp B   (coordinator.applyActions)

coordinator.commit(A)      -> durable log reads ['A','B']   <- arm A: B's action was written
coordinator.rollback(B)    -> log still ['A','B'], and the collection's pending queue
                              now holds A's already-durable action again
stage action 'C', commit   -> durable log reads ['A','C']   <- A written twice, B's record gone
```

Expected: `['A']` after the first commit, `['A','C']` after the second — B was
cancelled and should never appear; A should be recorded exactly once.

# Where the root cause sits

One representational fact, not two bugs: **`stampData` records per-stamp snapshots
and per-stamp action batches, while the state those describe (a `Collection`'s
tracker transforms and pending action queue) belongs to the collection, not to any
stamp.** Every commit/rollback path acts at collection granularity — commit drains
the whole queue then clears the whole collection; rollback restores a whole snapshot
— and nothing reconciles the other open stamps' bookkeeping with either.

Filtering the queue by stamp id at commit closes arm A and leaves arm B open, because
the stale snapshot is still stale. Refreshing other stamps' snapshots at commit closes
arm B and leaves arm A open. The arms have to be settled together — which is why this
is a representation decision, not a patch.

## Three sites, same shape

Design the answer for all three; a fix landed at one is not a fix.

- `commitOnceLatched` append loop (~421-434) and success fold (~522-540) — arm A and
  arm B on the direct commit path. Carries a `NOTE:` pointing at this ticket.
- `rollback` (~560-630) — restores the stale snapshot, and its survivor-replay loop is
  what makes the duplicate observable.
- `execute` savepoint/session commit path (~890-947) — the same collection-wide fold
  and the same `stampData.delete`. Its existing `NOTE:` (~908-919) already spells out
  the failure and proposes a tombstone entry (batches dropped, snapshot kept for the
  replay walk) at both delete sites.

# Design options, in rough order of how much they close

- **Per-stamp staged state.** Each open stamp stages into its own tracker and its own
  queue; the collection merges at commit. Closes both arms by construction and makes
  the bad state unrepresentable. Largest change, and it touches how reads see staged
  data — the Quereus virtual-table path reads live from the tracker.
- **Tag-scoped commit and rollback.** Every staged action already carries its stamp id
  (`applyActionsRaw` sets `Action.transaction`). Commit takes only its own actions and
  leaves the rest queued; rollback removes only its own. This retires the
  snapshot-and-replay machinery entirely, which is where both arms live. Open question
  is the tracker half — transforms are not tagged, so dropping one stamp's transforms
  still needs a replay of the survivors.
- **Tombstones.** Keep the snapshot-and-replay design; on commit, replace the stamp's
  `stampData` entry with a batches-dropped/snapshot-kept tombstone and refresh the
  other stamps' captures. Smallest change that closes arm B; still needs a queue filter
  for arm A.
- **Refuse the situation.** Reject a second concurrent stamp on one coordinator with a
  clear error. Cheapest and honest, but deletes a capability the coordinator's own
  design exists to provide — the `order` counter, the `seq`-ranked captures, the
  survivor-replay loop, and `rollback`'s "preserve other sessions' staged state"
  contract all exist only to serve concurrent stamps. If this is the answer, those
  should go too, along with the API's claim to support them.

Whatever is chosen, the plan should say what happens to that machinery, and what the
public contract of `TransactionCoordinator` becomes — today it exports and advertises
concurrent stamps without supporting them.

# Why it is not reachable today

The Quereus adapter drives one transaction at a time: `TransactionBridge` holds a
single `currentTransaction`, and a second `BEGIN` adopts the existing one rather than
starting a second. `docs/transactions.md` (~150-162) states the constraint explicitly
and warns that sharing one bridge between two writers corrupts both.

So this is reachable only through `db-core`'s exported `TransactionCoordinator` API.
That makes it a latent defect on a public surface, not a live production bug — a plan
may legitimately land the cheap option, provided it removes the false advertisement.

# Relationship to other tickets

Third distinct root cause found at this seam, after two that have landed:

- `bug-coordinator-rollback-leaves-pending-queue-populated` (landed) — rollback
  restored only the tracker half of each snapshot. Its fix is what makes arm B write a
  duplicate rather than silently drop a record; the underlying corruption predates it.
- `bug-coordinator-rollback-skips-late-registered-collections` (landed) — the snapshot
  map covered the wrong *set* of collections. Independent: that one was about which
  collections are in the map, this one about the map's contents going out of date.

All three are the same modelling error — transaction-scoped bookkeeping laid over
collection-scoped state. The two landed fixes made the map's *coverage* correct; this
ticket is about its *contents*.

# Acceptance

- The reproduction above yields `['A']` then `['A','C']`, as a regression test in
  `packages/db-core/test/transaction.spec.ts` — or, if the chosen option is "refuse",
  the second `applyActions` under a second stamp throws a clear error and that is the
  test.
- All three sites above are settled consistently, including the savepoint/session path
  in `execute`.
- The `NOTE:` blocks that point at this ticket (`commitOnceLatched` success fold,
  `execute`'s partial-commit delete) are updated or removed to match what landed.
- `docs/transactions.md` states the coordinator's actual concurrency contract.
