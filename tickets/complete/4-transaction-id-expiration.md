----
description: Encode expiration into transaction stamps to enforce outer time limit
dependencies: transaction protocol (db-core), TransactionValidator, TransactionSession, quereus-plugin txn-bridge
----

## Summary

Added an `expiration` field to `TransactionStamp` that encodes an absolute millisecond epoch deadline into the stamp. The expiration is computed as `timestamp + ttlMs` at stamp creation and is hashed into the stamp ID, making it tamper-proof.

### What changed

**Type change** (`packages/db-core/src/transaction/transaction.ts`):
- `TransactionStamp` now includes `expiration: number`
- `createTransactionStamp()` accepts optional `ttlMs` (default 30s) and includes `expiration` in the hash
- New exports: `DEFAULT_TRANSACTION_TTL_MS`, `isTransactionExpired()`

**Enforcement points**:
- `TransactionValidator.validate()` — rejects expired stamps before re-execution (step 0)
- `TransactionSession.commit()` — rejects expired stamps before initiating coordinator commit
- `TransactionCoordinator.commit()` — throws on expired stamps before consensus phases
- `TransactionCoordinator.execute()` — returns failure on expired stamps before engine execution

**Caller updates**:
- `TransactionSession.create()` accepts optional `ttlMs` parameter, passed through to `createTransactionStamp`
- All existing callers use the 4-arg signature unchanged (default TTL applies automatically)

**Documentation**: Updated `docs/transactions.md` type definitions to include `expiration` field.

## Testing

Tests in `packages/db-core/test/transaction.spec.ts`:
- `stamp includes expiration computed from timestamp + ttlMs` — verifies default TTL
- `stamp with custom TTL computes correct expiration` — verifies custom TTL
- `different expirations produce different stamp IDs` — verifies expiration is part of hash
- `isTransactionExpired returns false for non-expired stamp` — utility correctness
- `isTransactionExpired returns true for expired stamp` — utility correctness
- `TransactionValidator rejects expired transaction` — server-side enforcement
- `TransactionSession.commit rejects expired transaction` — client-side enforcement

All 213 db-core tests pass. Quereus plugin builds cleanly (uses default TTL via unchanged call signature).

## Validation

- `npm run build` passes for `@optimystic/db-core` and `quereus-plugin-optimystic`
- `npm test` passes for `@optimystic/db-core` (213 tests)
- Backward compatible: optional `ttlMs` parameter with default preserves all existing call sites

## Review Notes

- Interface is clean: absolute epoch avoids clock-drift during distributed validation
- Expiration hashed into stamp ID prevents tampering
- Early rejection at all four enforcement points avoids wasted computation
- Tests use past timestamps + tiny TTL rather than mocking `Date.now()` — pragmatic and non-fragile
- Exports properly re-exported from `transaction/index.ts`
