# Cryptographic Hash Upgrade

description: Replaced djb2 with SHA-256 in hashString and all callers

## Summary

Replaced the non-cryptographic djb2 hash (32-bit, collision-prone) with SHA-256 via `multiformats/hashes/sha2`. The change makes `hashString` async and returns base64url-encoded output (43 chars) instead of base-36 (5-8 chars).

## Changes

### Core
- **`packages/db-core/src/utility/hash-string.ts`** — Replaced djb2 body with SHA-256 using `multiformats/hashes/sha2` + `uint8arrays/to-string`. Signature changed from `(str) => string` to `(str) => Promise<string>`.

### Transaction pipeline (add `await` to hash calls)
- **`packages/db-core/src/transaction/transaction.ts`** — `createTransactionStamp` and `createTransactionId` are now `async`.
- **`packages/db-core/src/transaction/coordinator.ts`** — `hashOperations` is now `async`; awaited at both call sites. `commitTransaction` awaits stamp/ID creation.
- **`packages/db-core/src/transaction/validator.ts`** — `hashOperations` is now `async`; awaited at call site.
- **`packages/db-core/src/transaction/session.ts`** — Constructor made `private`; added `static async create()` factory (constructor can't be async). Doc comment updated.

### External callers
- **`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`** — Uses `TransactionSession.create()` instead of `new TransactionSession()`. Removed unused `createTransactionStamp`/`createTransactionId` imports.

### Tests
- **`packages/db-core/test/transaction.spec.ts`** — All `createTransactionStamp`/`createTransactionId` calls awaited, all `it()` callbacks made async, `new TransactionSession()` → `await TransactionSession.create()`. Collision test flipped: SHA-256 should NOT collide within 100K inputs. Two hardcoded `'ops:0'` hashes replaced with dynamic `hashString` computation.
- **`packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts`** — Awaited stamp/ID creation calls.

## Validation

- Build passes across all packages
- 202 tests passing; 4 pre-existing failures unrelated to this change (log, transactor-source, transform isolation)
- SHA-256 collision test confirms no collisions within 100K inputs (vs djb2 which collided)

## Breaking Change

`hashString` signature changed from sync to async. `TransactionSession` constructor is now private (use `TransactionSession.create()`). These are internal APIs in a pre-1.0 project.
