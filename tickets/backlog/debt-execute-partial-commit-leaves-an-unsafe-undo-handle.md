description: When a transaction saves successfully to some data collections but permanently fails on another, one of the two ways of running a transaction still hands the caller an "undo" handle. Using that handle would try to un-save the data that already saved successfully, which cannot work and would leave the program's memory disagreeing with what is actually stored.
files:
  - packages/db-core/src/transaction/coordinator.ts (`execute`'s partial-commit branch ~745-770; compare `commitOnceLatched`'s partial-commit branch ~398-435, and `rollback` ~485-535)
  - packages/db-core/test/transaction.spec.ts (`execute() surfaces the partition on ExecutionResult …` ~4033 — the case that reaches this branch)
  - docs/transactions.md (the "Honest-reporting contract" block, ~lines 60-105)
difficulty: medium
repro: static
severity: corruption
likelihood: contrived
tradeoffs: The affected method has no caller outside tests today, and the safer of the two fixes takes away the only way to undo the half of the transaction that did NOT save — so a maintainer may reasonably say the current behaviour is no worse than having no undo at all, and wait until something actually calls the method.

# What happens

A transaction can touch several data collections. Normally it saves to all of them or none. But
one collection can permanently lose a race to a competing writer *after* its siblings already
saved — a **partial landing**. The system does not pretend otherwise: it reports which
collections saved and which did not, and the caller is expected to reconcile.

There are two code paths that run a transaction:

- `commit()` — the shipped one, used by every caller today.
- `execute()` — an alternative entry point, currently reached only by tests.

Both handle a partial landing the same way *locally*: the collections that saved get finalised
(their in-memory bookkeeping is advanced to match storage, and their queue of not-yet-saved work
is emptied). That much is correct and now covered by tests in both paths.

They differ in one thing. `commit()` additionally **throws away the transaction's undo handle**,
on the stated grounds that a half-landed transaction is neither cleanly retryable nor cleanly
undoable. `execute()` keeps the handle alive.

Keeping it is unsafe. The undo mechanism (`TransactionCoordinator.rollback`) is all-or-nothing
across every collection: it rewinds each one's in-memory state to a snapshot taken before the
transaction started. Run it after a partial landing and the collection that *did* save gets
rewound too — re-staging changes that are already permanently stored, so memory and storage
disagree. That is precisely the corruption `commit()`'s partial-landing comment says it exists to
avoid.

The failure needs three things to line up, which is why nothing has hit it: something must call
`execute()` (nothing shipped does), the transaction must actually land partially, and the caller
must respond by asking for an undo. But the undo handle is `execute()`'s *only* offered recovery
for the half that did not save — so a caller that behaves reasonably is exactly the caller that
trips it.

# What a fix has to decide

Both collections' halves want incompatible things from one all-or-nothing undo, so the fix is a
choice, not a mechanical edit:

1. **Match `commit()`** — drop the undo handle on a partial landing. One line, and it makes the
   two paths consistent. Cost: the half that did *not* save loses its only unwind, so its
   in-memory state keeps a log entry that was written but never stored. `execute()` is documented
   as deliberately not snapshot-wrapped precisely *because* that undo handle exists, so this
   also invalidates a comment that has to be rewritten rather than left standing.

2. **Make undo partial-aware** — teach `rollback` to skip collections that have already saved
   under this transaction, so the handle stays usable for the half that failed. More work, and it
   needs `rollback` to learn which collections landed (it is currently given only a transaction
   stamp id). Closer to what a caller actually wants.

Whichever is chosen, `docs/transactions.md`'s honest-reporting block should say what an
`execute()` caller may and may not do after a partial landing — it currently describes the
reporting but not the recovery.

# Expected behaviour

After `execute()` returns a partial landing, no recovery action the coordinator offers may leave
a collection's in-memory state disagreeing with what is permanently stored. Either the recovery
is refused outright (option 1) or it is scoped to the collections that genuinely did not save
(option 2) — but it must not silently rewind a collection that did.

The regression that proves it: drive `execute()` into a partial landing where the winning
collection had prior saved state, then attempt the undo, and assert the winner still reads back
its saved value and carries no re-staged work.
