description: Transactions built through a session are stamped with a placeholder engine identifier of "unknown"; any node that actually validates transactions rejects them outright, so the security and validation path can never engage for session-built transactions.
prereq:
files:
  - packages/db-core/src/transaction/session.ts (create hardcodes engineId 'unknown', ~line 53)
  - packages/db-core/src/transaction/validator.ts (resolves engine by stamp.engineId, ~lines 70-75)
  - packages/db-core/src/transaction/coordinator.ts (related placeholder stamps 'local'/'', ~lines 354-358)
  - packages/db-core/src/transaction/actions-engine.ts (engine that needs a stable id)
difficulty: medium
----

# Session transactions carry engineId 'unknown' — remote validation is dead on arrival

## The bug

`TransactionSession.create` hardcodes `engineId: 'unknown'` (marked TODO). But
validators resolve the engine to use by `stamp.engineId`, and `pendPhase` always
attaches the transaction to the `PendRequest`. So any validating cluster node rejects
every session-built transaction with "Unknown engine: unknown".

It only appears to work today because storage-only nodes skip validation entirely —
meaning the security/validation path can *never* engage for these transactions.
Related placeholders live at `coordinator.ts:354-358` (`'local'`, `''`).

## Expected behavior

A session-built transaction carries a real, resolvable engine id so a validating node
can look up the correct engine and validate it, instead of rejecting it as unknown.

## Suggested direction (hint, not a mandate)

Expose an `id` on `ITransactionEngine`, require it in `createTransactionStamp`, and
remove the placeholder defaults (`'unknown'`, `'local'`, `''`). Coordinate with tx-4
(engine as side-effect-free translator) since both reshape the engine contract.

## Cross-section note

This relates to SQL-layer finding "SQ-8" (owned by the SQL agent) — the quereus
engine must supply a stable id consistent with what validators expect. Keep the id
scheme compatible; don't design the SQL side here.

Severity: MEDIUM.
