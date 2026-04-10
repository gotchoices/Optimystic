# Auto-Invalidate Schema Cache on DDL

description: QuereusEngine now auto-invalidates its schema hash cache when DDL operations occur, via `db.onSchemaChange()`.
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts
  - packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
----

## What was built

`QuereusEngine` now subscribes to `db.onSchemaChange()` in its constructor, automatically calling `invalidateSchemaCache()` whenever any DDL operation (CREATE/ALTER/DROP on tables, indexes, columns) occurs. This eliminates the previously documented bug where schema hash could become stale after DDL without manual invalidation.

### Changes

**quereus-engine.ts:**
- Added `private unsubscribeSchema` field to store the unsubscribe callback
- Constructor subscribes to `this.db.onSchemaChange(() => this.invalidateSchemaCache())`
- Added `dispose()` method that unsubscribes and nulls the reference

**quereus-engine.spec.ts:**
- Renamed section from "Schema hash cache staleness (TEST-7.1.2)" to "Schema hash auto-invalidation on DDL (TEST-7.1.2)"
- "should auto-invalidate cache after DDL" — asserts hash changes after CREATE TABLE without manual invalidation
- "should auto-invalidate across multiple DDL operations" — asserts each DDL produces a new hash
- "should stop auto-invalidation after dispose()" — asserts that after dispose, DDL no longer auto-invalidates (hash becomes stale again), and manual invalidation still works

## Testing notes

- All 22 tests in `quereus-engine.spec.ts` pass
- The `invalidateSchemaCache()` calls in existing tests (e.g., determinism tests) are now redundant but harmless — they still work correctly
- `dispose()` correctly stops the auto-invalidation, verified by asserting stale hash after DDL post-dispose
