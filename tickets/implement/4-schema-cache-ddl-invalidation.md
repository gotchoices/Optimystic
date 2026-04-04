# Auto-Invalidate Schema Cache on DDL

description: Subscribe to Quereus `db.onSchemaChange()` in `QuereusEngine` constructor to automatically invalidate the schema hash cache when DDL operations occur.
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts
  - packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
----

## Design

Quereus `Database` already exposes `onSchemaChange(listener)` which fires after any DDL operation (CREATE/ALTER/DROP on tables, indexes, columns). The `QuereusEngine` already holds a `db: Database` reference and has `invalidateSchemaCache()`.

The fix is to:
1. Subscribe to `db.onSchemaChange()` in the `QuereusEngine` constructor
2. Store the unsubscribe function for cleanup
3. Add a `dispose()` method to unsubscribe
4. Call `invalidateSchemaCache()` in the listener callback

The event type is `DatabaseSchemaChangeEvent` with fields `type: 'create' | 'alter' | 'drop'` and `objectType: 'table' | 'index' | 'column'`. All schema change events should invalidate the cache since any of them can affect the schema hash (which is computed from `select type, name, sql from schema()`).

### Key types from Quereus

```typescript
// From @quereus/quereus (database-events.ts)
interface DatabaseSchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'column';
  moduleName: string;
  schemaName: string;
  objectName: string;
  // ...
}

// Database method:
onSchemaChange(listener: (event: DatabaseSchemaChangeEvent) => void): () => void;
```

### Existing "known bug" tests

Two tests in `quereus-engine.spec.ts` (lines 164-197, section "Schema hash cache staleness (TEST-7.1.2)") document this as known bugs where DDL doesn't auto-invalidate. After this fix, those tests should be updated to assert the correct (non-stale) behavior.

## TODO

### Phase 1: Implementation
- In `QuereusEngine` constructor, subscribe to `this.db.onSchemaChange(() => this.invalidateSchemaCache())`
- Store the unsubscribe function as a private field (e.g., `private unsubscribeSchema: (() => void) | undefined`)
- Add a `dispose(): void` method that calls the unsubscribe function and nulls it out

### Phase 2: Update tests
- Update the "should return stale hash after DDL without invalidation (known bug)" test to assert that the hash is automatically invalidated (hash2 !== hash1), removing the "known bug" framing
- Update the "should accumulate staleness across multiple DDL operations (known bug)" test similarly
- Add a test that verifies `dispose()` stops the auto-invalidation (subscribe, dispose, DDL, assert hash is stale again)
- Ensure all existing schema hash tests still pass (the manual `invalidateSchemaCache()` calls become redundant but harmless)
