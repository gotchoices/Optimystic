# Read Dependency Validation — Review

description: Read dependency capture and validation for optimistic concurrency control, preventing write-skew anomalies
dependencies: None
files:
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transaction/session.ts
  - packages/db-core/src/transaction/validator.ts
  - packages/db-core/src/transaction/index.ts
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Summary

Implemented read dependency capture and validation across the transaction lifecycle:

1. **TransactorSource** (`transactor-source.ts`): Added `readDependencies` accumulator. Every `tryGet()` call records `{ blockId, revision: state.latest?.rev ?? 0 }` from `GetBlockResult.state`. Exposed via `getReadDependencies()` and `clearReadDependencies()`.

2. **Collection** (`collection.ts`): Added `getReadDependencies()` and `clearReadDependencies()` methods that delegate to the underlying TransactorSource.

3. **TransactionCoordinator** (`coordinator.ts`): Added `getReadDependencies()` (collects from all registered collections) and `clearReadDependencies()`.

4. **TransactionSession** (`session.ts`): `commit()` now collects reads via `coordinator.getReadDependencies()` and includes them in the Transaction (replacing the hardcoded `reads: []`). Clears read dependencies after commit or rollback.

5. **TransactionValidator** (`validator.ts`): New `BlockStateProvider` type for looking up current block state. Constructor accepts an optional `blockStateProvider`. Step 3 of validation now iterates `transaction.reads`, queries current block state, and rejects if `currentRev !== read.revision` with descriptive message.

6. **Quereus validator** (`quereus-validator.ts`): Updated `QuereusValidatorOptions` to accept optional `blockStateProvider`, passed through to `TransactionValidator`.

## Testing Scenarios

- **Write-skew detection**: Two concurrent transactions read both accounts (A=100, B=100), each withdraws from one. After tx-a commits (changing blockA to rev 2), tx-b's read dependency on blockA at rev 1 is stale → validator rejects.
- **Reads unchanged**: Transaction reads block at rev 1, block is still at rev 1 → validation passes.
- **Non-existent block created**: Transaction reads block that didn't exist (rev 0), block gets created (rev 1) → stale read detected.
- **No reads (backward compat)**: Transaction with empty reads array → validation passes regardless of blockStateProvider.
- **Original write-skew test preserved**: Confirms that at the raw transactor pend/commit level, write-skew still occurs (the validator layer is what catches it).

## Build & Test Status

- `packages/db-core` builds cleanly (`tsc`)
- `packages/quereus-plugin-optimystic` builds cleanly (`tsup`)
- All 259 tests pass
