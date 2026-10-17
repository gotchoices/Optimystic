description: When one machine changes a shared table's stored description, another machine that loaded the old description earlier writes that old copy back over the change the first time it touches the table, so the change is silently undone until someone re-applies it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`doInitialize`'s DDL-wins arm, `lookupOrInstantiate`, `instantiateTable`, the `declaredColumns` field), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`storeStoredSchema`, `mergePersistedSchemas`)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The catalog-only ALTER arms already avoid the trigger, and a machine that re-runs its schema upgrade on the next start re-applies the lost change, so a maintainer may prefer to wait until a multi-machine upgrade shows it in the field.
----

## What happens

`hydrate` copies every catalog record into the engine's in-memory catalog. The first statement that touches a hydrated table builds the table instance from that engine entry (`lookupOrInstantiate` → `instantiateTable`), so the instance's `declaredColumns` is true and its first `doInitialize` takes the "DDL wins" arm: it builds a record from the instance's schema, compares it with the stored record, and on any difference writes its own (`storeStoredSchema`, which unions only `indexes` and `orphanedIndexes`).

If another machine changed the record after this machine hydrated — added or dropped a column or a CHECK, changed tags — the two differ, and this machine writes its hydrate-time copy over the newer record. Nothing reports it. The other machine keeps running on its newer view; on its next start it hydrates the reverted record.

Found while planning `catalog-only-drop-check-constraint`, where it matters for Sereus: phones of one party start on a new release one at a time and each runs `apply schema` against a catalog it hydrated at start. The catalog-only arms in that ticket avoid instantiating a table for exactly this reason, but any other first touch (a query, an insert, `create index`) still triggers it.

To confirm: two `Database` sessions over one `MemoryRawStorage` (`test/shared-local-transactor.ts`); both hydrate a table `t`; session A runs `alter table t add constraint c check (…)` (or `set tags`); session B runs `select * from t`; a third session that only hydrates sees `t` without A's change.

## Expected

A first touch of a hydrated table never writes a record older than the one stored. The likely shape: a table built from a hydrated entry is not a declaration — it should take the load arm (adopt the stored record, rebuild its schema from it) rather than the DDL-wins arm, which exists for a `create table` whose local declaration is meant to win. Whether that also needs the engine's catalog entry refreshed from the newer record (the engine would otherwise plan against the old columns) is part of the fix.
