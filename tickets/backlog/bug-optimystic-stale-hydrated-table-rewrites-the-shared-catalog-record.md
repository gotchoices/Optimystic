description: When one machine changes a shared table's stored description, another machine that loaded the old description earlier writes that old copy back over the change the first time it touches the table, so the change is silently undone until someone re-applies it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`doInitialize`'s DDL-wins arm, `lookupOrInstantiate`, `instantiateTable`, the `declaredColumns` field), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`storeStoredSchema`, `mergePersistedSchemas`)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs another machine's upgrade to land between this machine's hydrate and its first touch of the table, and a machine that re-runs its schema upgrade on the next start re-applies the lost change, so a maintainer may prefer to wait until a multi-machine upgrade shows it in the field.
----

## What happens

`hydrate` copies every catalog record into the engine's in-memory catalog. The first statement that touches a hydrated table builds the table instance from that engine entry (`lookupOrInstantiate` → `instantiateTable`), so the instance's `declaredColumns` is true and its first `doInitialize` takes the "DDL wins" arm: it builds a record from the instance's schema, compares it with the stored record, and on any difference writes its own (`storeStoredSchema`, which unions only `indexes` and `orphanedIndexes`).

If another machine changed the record after this machine hydrated — added or dropped a column or a CHECK, changed tags — the two differ, and this machine writes its hydrate-time copy over the newer record. Nothing reports it. The other machine keeps running on its newer view; on its next start it hydrates the reverted record.

Found while planning `catalog-only-drop-check-constraint`, where it matters for Sereus: phones of one party start on a new release one at a time and each runs `apply schema` against a catalog it hydrated at start. The catalog-only arms in that ticket avoid instantiating a table for exactly this reason, but any other first touch (a query, an insert, `create index`) still triggers it.

To confirm: two `Database` sessions over one `MemoryRawStorage` (`test/shared-local-transactor.ts`); both hydrate a table `t`; session A runs `alter table t add constraint c check (…)` (or `set tags`); session B runs `select * from t`; a third session that only hydrates sees `t` without A's change.

## Arm: `apply schema` itself triggers it, and can remove another machine's CHECK (seen while implementing `catalog-only-drop-check-constraint`)

`alter table … add constraint … check` is not free of a first touch: before calling the module, Quereus checks the stored rows against the new CHECK with a `select` over the table (`rejectCheckViolatedByExistingRows` in `@quereus/quereus/src/runtime/emit/add-constraint.ts`). On a hydrated table no statement has touched, that `select` builds the instance, and its first initialize runs the DDL-wins compare described above — inside the open `apply schema` batch, so the stale record is staged into the batch and the module's ADD arm then reads it.

Verified on two sessions over one `MemoryRawStorage` (the harness in `test/alter-table-arms.spec.ts`): A declares `t` with `constraint pos check (a > 0)`; B hydrates; A applies the same table with `pos check (a >= 0)` (the differ emits `drop constraint pos` then `add constraint pos …`); B applies that declaration plus a step that fails (`constraint one_c unique (c)`, which the module refuses). B's drop finds the record already changed and writes nothing, but the add's row check builds B's instance from B's catalog entry (no `pos` at that point), which stages a record without `pos`; the add then judges that record as missing the CHECK and writes it as B's own change; the failed step's unwind undoes that add in the record. A third session that hydrates finds **no `pos` at all** — A's committed CHECK is gone. Without the failing step the record ends up right (B re-adds the same body). The arm spec `a second machine adopts both halves of a changed CHECK body…` reads the table on B before A's upgrade to stay clear of this.

A second, narrower path to the same outcome: after a failed apply whose undo was kept off the record (B's catalog back on the old description, the record on A's), a failed end-of-batch catalog commit marks B's table unpersisted, and its next touch re-persists B's older description through the same arm.

## Expected

A first touch of a hydrated table never writes a record older than the one stored. The likely shape: a table built from a hydrated entry is not a declaration — it should take the load arm (adopt the stored record, rebuild its schema from it) rather than the DDL-wins arm, which exists for a `create table` whose local declaration is meant to win. Whether that also needs the engine's catalog entry refreshed from the newer record (the engine would otherwise plan against the old columns) is part of the fix.
