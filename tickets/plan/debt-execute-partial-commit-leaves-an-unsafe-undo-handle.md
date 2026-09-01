description: When a transaction saves to some data collections but permanently fails on another, one of the two ways of running a transaction leaves the caller with an "undo" handle that would try to un-save data already saved, and never unwinds the half that failed. Decide what recovery that path should offer and make it safe.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute` partial-commit branch ~744-771; `commitOnceLatched` partial-commit branch ~404-437; `rollback` ~487-535; `stampData` field ~61-65; `applyActions` snapshot ~85-101)
  - packages/db-core/src/collection/collection.ts (`snapshotPending` ~629, `restorePending` ~640)
  - packages/db-core/test/transaction.spec.ts (`execute() surfaces the partition on ExecutionResult ...` line 4033 — the existing case that reaches this branch)
  - packages/db-core/src/transaction/session.ts (~193 — `session.rollback()` is the shipped caller of `coordinator.rollback`)
  - docs/transactions.md (the "Honest-reporting contract" block, lines 63-105)
difficulty: medium
----

# Background, in plain terms

A transaction can touch several data collections. Normally it saves to all of them or none.
But one collection can permanently lose a race to a competing writer *after* its siblings
already saved — call this a **partial landing**. The system does not pretend otherwise: it
reports which collections saved and which did not, and expects the caller to reconcile.

Two methods on `TransactionCoordinator` run a transaction:

- `commit()` (via `commitOnceLatched`) — the shipped one, used by every caller today.
- `execute()` — an alternative entry point, currently reached only by tests.

# What is actually wrong

Verified by reading the code at the line numbers above (no runtime repro — nothing calls
`execute()` outside tests). On a partial landing the two methods diverge in **two** ways, not
one:

**1. The failed half is never unwound in `execute()`.**
`commitOnceLatched` takes a `snapshotPending()` of every collection before it appends to the
logs, and on a partial landing calls `restorePending(...)` on each collection that did *not*
commit — leaving it clean for a retry. `execute()` takes no such snapshot and has no `else`
branch: a collection that failed keeps the log entry that was written but never stored. So
`docs/transactions.md`'s claim that `execute()` "mirrors this" is not accurate today — it
mirrors only the treatment of the collections that *did* save.

**2. The undo handle survives, and using it would corrupt the half that saved.**
`commitOnceLatched` deletes the transaction's entry from `stampData` on a partial landing, on
the stated grounds that a half-landed transaction is neither cleanly retryable nor cleanly
undoable. `execute()` does not. The undo mechanism (`TransactionCoordinator.rollback`, reached
in shipped code via `session.rollback()`) is all-or-nothing: it rewinds every collection's
in-memory state to a snapshot taken before the transaction's first action, then replays other
in-flight transactions on top. Run it after a partial landing and the collection that *did*
save is rewound too — re-staging actions that are already permanently stored, so memory and
storage disagree. That is exactly the corruption `commitOnceLatched`'s comment says it exists
to avoid.

Three things must line up to hit this: something must call `execute()` (nothing shipped does),
the transaction must land partially, and the caller must then ask for an undo. But the undo
handle is `execute()`'s only offered recovery for the half that did not save, so a caller
behaving reasonably is precisely the caller that trips it.

# The decision this plan owes

The two halves want incompatible things from one all-or-nothing undo, so this is a choice, not
a mechanical edit. At least three shapes are on the table:

1. **Match `commit()` — drop the undo handle.** Delete the `stampData` entry in `execute()`'s
   partial branch. One line, makes the two paths consistent. Cost: the failed half keeps a
   written-but-not-stored log entry with nothing to unwind it, unless combined with (3).
   Also invalidates the in-code comment that justifies `execute()` not being snapshot-wrapped
   *because* the handle exists — that comment must be rewritten, not left standing.

2. **Make undo partial-aware.** Teach `rollback` which collections landed under this stamp and
   skip them. Closer to what a caller wants, but note two complications the planner must
   resolve rather than assume away: `rollback` is currently given only a stamp id, and its
   replay loop re-applies *other* in-flight stamps' action batches, whose own recorded
   snapshots for a skipped collection are stale (taken before that collection committed).

3. **Give `execute()` the same pre-append snapshot `commitOnceLatched` has** — call
   `snapshotPending()` before the apply loop and `restorePending()` on the failed half in the
   partial branch. This closes gap 1 directly and is largely independent of the choice between
   (1) and (2). Note the two unwind points differ and the planner should be explicit about
   which one is wanted: `snapshotPending` rewinds to "staged but not written to the log"
   (retry-clean for `commit()`), whereas the `stampData` snapshot rewinds further, to before
   the actions were staged at all — which is what an `execute()` retry needs, since `execute()`
   re-stages the engine's actions itself each call.

Whichever shape wins, `docs/transactions.md`'s honest-reporting block should state what an
`execute()` caller may and may not do after a partial landing. It currently describes the
reporting but not the recovery, and its "mirrors this" sentence overstates what `execute()`
does.

# Expected behaviour

After `execute()` returns a partial landing:

- No recovery action the coordinator offers may leave a collection's in-memory state
  disagreeing with what is permanently stored. Either the undo is refused outright, or it is
  scoped to the collections that genuinely did not save — but it must not silently rewind one
  that did.
- The collections that did not save should be left in a defined state the plan names
  explicitly (clean for retry, or knowingly left staged), not the accidental one they are in
  today.

The regression that proves it: drive `execute()` into a partial landing where the winning
collection had prior saved state, then attempt the undo, and assert the winner still reads
back its saved value and carries no re-staged work. A second case should assert the defined
state of the losing collection.

# Out of scope

Genuine all-or-nothing commit across collections is a separate, much larger piece of work
already parked as `feat-cross-collection-atomic-commit`. This ticket is only about making the
recovery `execute()` offers honest under the partial landings the current design permits.
