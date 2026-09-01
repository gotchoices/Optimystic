description: The part of the database that runs transactions can only ever have one open at a time, but it still stores that one in a container built to hold many — so "two are open" remains a shape the code can express, prevented only by hand-written checks. Change the storage to hold at most one, so the rule holds by construction instead of by vigilance.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` field + its ~35-line doc, ~59-95; `applyActions` open-guard ~118-133; `openStampOtherThan` ~140-149; `commit` guard; `rollback` ~600-625; `execute` partial-landing drop ~918; the success-fold drop ~575)
  - packages/db-core/test/coordinator-single-stamp.spec.ts (the guard's existing tests — must stay green unchanged)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts
  - docs/transactions.md (§"The coordinator refuses a second open transaction stamp")
difficulty: easy
tradeoffs: The rule is already enforced, tested, and documented at length, so this buys no behaviour — a maintainer may reasonably call it churn on a concurrency-critical file that two tickets just finished stabilising, and prefer to leave the map alone.

# Why this exists

`TransactionCoordinator` tracks in-flight transactions in

```ts
private stampData = new Map<string, { preSnapshot: Map<Collection<any>, CollectionSnapshot<any>> }>();
```

Two separate tickets have since established that **at most one entry may ever be in that map**:
`bug-coordinator-refuses-concurrent-stamps` added the guards that throw
`CoordinatorConcurrentStampError` when a second transaction tries to open, and
`coordinator-drop-multi-stamp-replay-machinery` deleted the rewind-and-replay routine that was the
only code the many-entry shape ever existed to serve.

What is left is a many-slot container holding a rule that says "never more than one". The rule now
lives in three places that must agree: a long comment on the field, a guard in `applyActions`, and a
guard in `commit`. Nothing structural stops a future edit from writing a second entry — it would
type-check, and the failure would surface far away as two transactions silently reading each other's
uncommitted rows.

This is not a defect report. Nothing is broken today and the guards are directly tested
(`coordinator-single-stamp.spec.ts`). It is the last piece of the multi-transaction design still
standing after its purpose was removed.

# What "done" looks like

The coordinator holds **one optional slot** rather than a map — conceptually

```
open: { stampId: string; preSnapshot: Map<Collection<any>, CollectionSnapshot<any>> } | undefined
```

so that "two transactions open" cannot be written down at all. Every current reader is satisfied by
that shape:

| current use | with one slot |
| --- | --- |
| `openStampOtherThan(id)` — names the other transaction in the error | compare `open?.stampId` to `id` |
| `applyActions` — find-or-create this transaction's entry | same comparison, then assign |
| `rollback(id)` / the two release sites | match the id, then clear the slot |

The behaviour the tests assert must not change: the same error type, naming both transactions;
rollback of an unknown or already-released transaction still a no-op; a failed clean commit still
keeping its slot so a later rollback is a complete recovery.

The field's existing documentation is genuinely valuable (it explains why snapshots are keyed by
collection instance, why both halves of the staged state live in one value, and which writers the
guard does *not* see). It should be carried over, not discarded — only the paragraphs justifying the
many-entry shape fall away.

`docs/transactions.md` §"The coordinator refuses a second open transaction stamp" describes the rule
as enforced by guards; it should say the shape enforces it and the guards report it.
