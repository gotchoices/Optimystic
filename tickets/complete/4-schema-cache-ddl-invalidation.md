# Auto-Invalidate Schema Cache on DDL

description: QuereusEngine auto-invalidates its schema hash cache on DDL via `db.onSchemaChange()`.
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts
  - packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
----

## What was built

`QuereusEngine` subscribes to `db.onSchemaChange()` in its constructor, automatically calling `invalidateSchemaCache()` on any DDL operation (CREATE/ALTER/DROP). This eliminates stale schema hash after DDL without requiring manual invalidation.

### Key changes in `quereus-engine.ts`
- `private unsubscribeSchema` field stores the unsubscribe callback
- Constructor: `this.db.onSchemaChange(() => this.invalidateSchemaCache())`
- `dispose()` method unsubscribes and nulls the reference

## Testing

Tests in `quereus-engine.spec.ts` section "Schema hash auto-invalidation on DDL (TEST-7.1.2)":
- **auto-invalidate cache after DDL** — hash changes after CREATE TABLE without manual call
- **auto-invalidate across multiple DDL operations** — each DDL yields a new hash
- **stop auto-invalidation after dispose()** — post-dispose DDL leaves hash stale; manual invalidation still works

All 182 tests in the package pass. Build clean.

## Review notes

- Resource cleanup is correct: `dispose()` null-checks, unsubscribes, nulls reference
- The `invalidateSchemaCache()` calls in existing determinism tests are redundant but harmless
- Minor pre-existing concern: `createQuereusValidator()` creates a `QuereusEngine` without a dispose path, but the subscription is lightweight and beneficial for keeping the validator's schema hash fresh
