description: A change statement is recorded into the replicated transaction record without waiting for it to actually be applied, so a statement can go missing from the record that other nodes replay — causing undetected data divergence between nodes.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/transaction/session.ts
difficulty: medium
----

## Bug

`addStatement` in the transaction bridge does
`void this.session.execute(statement, [])` (`txn-bridge.ts:374-379`), with a
comment claiming statement tracking is synchronous. It is not:
`session.execute` (`db-core/src/transaction/session.ts:69-110`) `await`s
`applyActions` **before** pushing the statement onto the transaction record, and
the returned promise (including any failure) is discarded by the `void`.

Consequences:
- If the async work has not completed when the transaction record is finalized,
  a statement can be **silently missing** from the record that validator peers
  re-execute.
- A failure inside `execute` is swallowed.

The record other nodes replay is the source of truth for validation; a missing
statement means peers re-execute a *different* operation set. Best case the
resulting state hashes diverge and it's caught; worst case divergence goes
undetected.

## Expected behavior

Every statement accepted by the DML path is durably present in the transaction
record before the record is finalized, and any failure to record it propagates
to the caller (the DML fails rather than committing a record missing a statement).

Suggested direction (from review): add a synchronous `session.recordStatement(sql)`
that appends to the record without the async `applyActions` round-trip, or `await`
the `session.execute` promise in the DML path and propagate failure. Prefer the
option that keeps recording ordering deterministic relative to staging.

## Edge cases

- Multi-statement transaction where an early statement's async apply is slow.
- A statement whose `execute` rejects — must surface, not vanish.
- Ordering vs `collection.stage` (recording currently precedes staging in
  `OptimysticModule.update`; keep that ordering intact).
