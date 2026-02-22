# Cryptographic Hash Upgrade

description: Replaced djb2 with SHA-256 in hashString and all callers

## Summary

Replaced the non-cryptographic djb2 hash (32-bit, collision-prone) with SHA-256 via `multiformats/hashes/sha2`. The `hashString` function is now async and returns base64url-encoded output (43 chars) instead of base-36 (5-8 chars).

## Changes

### Core
- **`packages/db-core/src/utility/hash-string.ts`** — SHA-256 via `multiformats/hashes/sha2` + `uint8arrays/to-string`. Signature: `(str) => Promise<string>`.

### Transaction pipeline (async propagation)
- **`packages/db-core/src/transaction/transaction.ts`** — `createTransactionStamp` and `createTransactionId` now async.
- **`packages/db-core/src/transaction/coordinator.ts`** — `hashOperations` async; awaited at both call sites.
- **`packages/db-core/src/transaction/validator.ts`** — `hashOperations` async; awaited at call site.
- **`packages/db-core/src/transaction/session.ts`** — Private constructor + `static async create()` factory.

### External callers
- **`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`** — Uses `TransactionSession.create()`.

### Tests
- **`packages/db-core/test/transaction.spec.ts`** — All hash calls awaited, `TransactionSession.create()` used, collision test validates SHA-256 uniqueness within 100K inputs.
- **`packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts`** — Awaited stamp/ID creation calls.

### Docs updated
- **`docs/transactions.md`** — `new TransactionSession()` references updated to `await TransactionSession.create()`.
- **`docs/system-review.md`** — djb2 references updated to reflect SHA-256 upgrade (HUNT-2.1.1, HUNT-2.1.2, SEC-9.2.2, THEORY-10.4.2, TEST-10.8.1).

## Review Notes

- Build passes (one pre-existing TS error in transactor-source.spec.ts fixed: missing `tailId` in CommitRequest).
- db-core: 206 tests passing. db-p2p: 118 passing. quereus-optimystic: 80 passing (18 pre-existing failures unrelated to this change).
- SHA-256 collision test confirms no collisions within 100K inputs.
- Duplicated `Operation` type in coordinator.ts/validator.ts is a pre-existing pattern (with matching comment) — acceptable for module isolation.
- Breaking change: `hashString` sync→async, `TransactionSession` constructor now private. Internal APIs in pre-1.0 project.
