----
description: Encode expiration into transaction stamps to enforce outer time limit
dependencies: transaction protocol (db-core), TransactionValidator, TransactionSession, quereus-plugin txn-bridge
----

## Overview

Transactions currently have no outer time bound. A `TransactionStamp` is created at BEGIN with metadata (`peerId`, `timestamp`, `schemaHash`, `engineId`), and its `id` is a hash of those fields. This task adds an `expiration` field to the stamp, which:

1. Gets hashed into the stamp ID (tamper-proof, immutable once created)
2. Is checked at validation time to reject expired transactions early
3. Is checked at commit time to prevent long-running transactions from committing

The expiration is computed as `timestamp + ttlMs` at stamp creation, where `ttlMs` defaults to a constant (`DEFAULT_TRANSACTION_TTL_MS = 30_000`).

## Design

### TransactionStamp type change

```typescript
export type TransactionStamp = {
  peerId: string;
  timestamp: number;
  schemaHash: string;
  engineId: string;
  expiration: number;   // <-- NEW: absolute ms epoch after which transaction is invalid
  id: string;
};
```

### Enforcement points

- **TransactionValidator.validate()** (`packages/db-core/src/transaction/validator.ts`): Check `Date.now() > stamp.expiration` before re-execution (step added before existing step 1). This is the server-side enforcement during PEND.
- **TransactionSession.commit()** (`packages/db-core/src/transaction/session.ts`): Check expiration before orchestrating PEND/COMMIT. Client-side early rejection.
- **TransactionCoordinator.commit()** and **execute()** (`packages/db-core/src/transaction/coordinator.ts`): Check expiration before entering coordination phases.

### Utility

```typescript
export const DEFAULT_TRANSACTION_TTL_MS = 30_000; // 30 seconds

export function isTransactionExpired(stamp: TransactionStamp): boolean {
  return Date.now() > stamp.expiration;
}
```

## Key files

- `packages/db-core/src/transaction/transaction.ts` - Type + `createTransactionStamp` + constants
- `packages/db-core/src/transaction/session.ts` - `TransactionSession.create` and `.commit()`
- `packages/db-core/src/transaction/coordinator.ts` - `TransactionCoordinator.commit()` and `.execute()`
- `packages/db-core/src/transaction/validator.ts` - `TransactionValidator.validate()`
- `packages/db-core/src/transaction/index.ts` - Re-exports
- `packages/db-core/test/transaction.spec.ts` - Tests
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` - Quereus integration
- `packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts` - Quereus tests
- `docs/transactions.md` - Documentation

## TODO

### Phase 1: Core types and stamp creation
- Add `expiration` field to `TransactionStamp` type in `transaction.ts`
- Add `DEFAULT_TRANSACTION_TTL_MS` constant and `isTransactionExpired()` utility to `transaction.ts`
- Update `createTransactionStamp` to accept optional `ttlMs` param (default `DEFAULT_TRANSACTION_TTL_MS`), compute `expiration = timestamp + ttlMs`, include `expiration` in the hash input
- Export new constant and utility from `index.ts`

### Phase 2: Enforcement points
- Add expiration check in `TransactionValidator.validate()` as the first step (before engine/schema checks)
- Add expiration check in `TransactionSession.commit()` before initiating coordinator commit
- Add expiration check in `TransactionCoordinator.commit()` and `.execute()` before orchestrating phases

### Phase 3: Caller updates
- Update `TransactionSession.create()` to accept optional `ttlMs` and pass through to `createTransactionStamp`
- Update `TransactionBridge.beginTransaction()` in quereus plugin - no changes needed beyond what `TransactionSession.create()` already handles (default TTL applies)
- Update `TransactionCoordinator.commitTransaction()` which calls `createTransactionStamp` directly

### Phase 4: Test updates
- Update all existing `createTransactionStamp` calls in tests to work with the new signature (existing 4-arg calls should still work since `ttlMs` is optional and defaults)
- Add test: expired stamp is rejected by `TransactionValidator.validate()`
- Add test: expired stamp is rejected by `TransactionSession.commit()`
- Add test: stamp with custom TTL computes correct expiration
- Add test: `isTransactionExpired()` utility works correctly
- Add test: expiration is part of stamp hash (different expirations = different stamp IDs)

### Phase 5: Build and verify
- Run build across affected packages
- Run all tests to confirm passing
