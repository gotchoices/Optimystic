# Auto-Invalidate Schema Cache on DDL

description: invalidateSchemaCache() exists but is not called automatically on DDL; requires manual invalidation after table_added/table_removed/table_modified events
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
----

`QuereusEngine` maintains a `schemaHashCache` with an `invalidateSchemaCache()` method, but no automatic subscription to `schemaManager.changeNotifier` events (`table_added`, `table_removed`, `table_modified`). Schema changes currently require callers to manually invalidate the cache, which is error-prone.

Low priority because schema changes are rare in production, but the fix is straightforward: subscribe to the change notifier and call `invalidateSchemaCache()` on relevant events.
