description: When a transaction is run through a session without pre-computed operations, each statement's effects get applied twice, corrupting the transaction's contents. The only reason this hasn't surfaced is that every current test happens to supply pre-computed operations and never exercises this path.
files:
  - packages/db-core/src/transaction/session.ts (execute — engine-translation path, ~lines 90-98)
  - packages/db-core/src/transaction/actions-engine.ts (ActionsEngine.execute already applies via coordinator, ~line 51)
  - packages/db-core/src/transaction/context.ts (deprecated TransactionContext.addAction — same tension)
difficulty: medium
----

# TransactionSession.execute double-applies actions on the engine-translation path

## The bug

When `session.execute` is called with no pre-computed actions, it calls
`engine.execute(tempTransaction)` and then applies the returned actions *again* via
`coordinator.applyActions`. But `ActionsEngine.execute` already applies each
statement's actions through the coordinator itself. So every statement executed via a
session + `ActionsEngine` without explicit actions is applied twice.

All current tests pass explicit actions, so this branch is untested and broken. The
deprecated `TransactionContext.addAction` path has the same double-apply tension.

## Expected behavior

A statement's actions are applied exactly once, whether or not the caller supplies
pre-computed actions.

## Suggested direction (hint, not a mandate)

Make engines side-effect-free translators: `engine.execute` should *return* actions
and never apply them; application belongs solely to the session/coordinator. On the
validator path, bind the engine to the isolated validation coordinator. Coordinate
with tx-7 (engine id) and tx-13 (deleting the dead deprecated `TransactionContext`
path), which touch the same seam.

Severity: HIGH.
