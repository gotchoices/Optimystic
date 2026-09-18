description: When two machines in a two-member group insert different rows that share a value in a unique column at the same instant, both rows end up stored and readable on both machines, breaking the unique constraint. It happened in every attempt measured, so for writers that collide at the same moment it is the normal outcome, not a rare window.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (legacy commit: table first, then indexes, each final on completion; `PartialCommitError`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the pre-flight from `3.5-concurrent-secondary-unique-guard`)
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transaction/coordinator.ts (the coordinator's multi-collection commit, for comparison)
  - docs/transactions.md (the legacy-mode warning, and "Planned narrowing")
repro: downstream (6 of 6)
severity: corruption
likelihood: unusual
----

# What was measured

Reported 2026-09-17 by sereus (`sereus-83`); its ticket is `../sereus/tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`. Measured against optimystic `61747f60`.

**Setup:** two real nodes in a confirmed two-member cohort, both in legacy commit mode (the default). In the same tick, each inserts a row with a different primary key but the **same value in a secondary unique column**.

**Result, 6 of 6 rounds:**
- the loser's commit ends in `PartialCommitError`
- the loser's **base row and first index are durably stored, and its unique index is not**
- both rows are readable on both nodes under one unique value

# Why the existing guard does not catch it

`complete/3.5-concurrent-secondary-unique-guard` added a pre-flight that refuses an insert whose unique value another writer has already committed. Here neither rival has committed when the pre-flight runs, so both pass it. Legacy commit then saves the table, then each index, and each save is final when it completes (the warning in `docs/transactions.md`). The unique index is where the conflict is finally detected, but by then the base row and earlier indexes are already stored, and nothing undoes them.

# What sereus asks, and what to decide

Sereus asks that `backlog/feat-optimystic-legacy-commit-two-phase` ("Narrow the legacy multi-tree commit window: pend-all-then-commit-all") be treated as a **bug fix rather than a future enhancement**, because this is a measured, repeatable constraint violation in the smallest multi-writer deployment. That backlog ticket's `tradeoffs:` line says the remaining work "means restructuring the most safety-critical sync loop in db-core". The fix stage should decide, with a reproduction in hand:

1. **Is pend-all-then-commit-all the right cure?** If every collection in the write pends first and all must succeed before any commits, the unique index's refusal happens at pend time, before anything is final. That would make the loser refuse with nothing stored, which is sereus's unblock condition.
2. **Is there a narrower cure that does not restructure the sync loop?** For example, pending the unique indexes first, or checking the unique index as part of the pend of the base table. Say why it does or does not close the same-instant case.
3. **Does coordinator (session) mode have the same shape?** It is not enabled by default here, but the answer determines whether the fix belongs in the bridge or in db-core.

Start with a failing test: two nodes in one mesh, a table with a secondary unique column, one concurrent insert pair sharing the unique value. Assert that exactly one row survives, the loser gets a constraint error, and nothing of the loser's is stored on either node. If this needs the two-node plugin harness rather than the db-p2p mesh, say which and why.

**Sereus unblocks when a same-instant unique-value loser is refused with nothing stored.**
