description: Deleting a row from an Optimystic table removes the row, but Quereus treats the row as not found, so `on delete cascade` never runs, child rows are left behind, and `returning` and change events report nothing. A Quereus memory table does all of these correctly.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (the `case 'delete'` arm of `update`), @quereus/quereus/src/runtime/emit/dml-executor.ts (`runDelete`, which reads `result.row`)
repro: verified
----

Measured on this tree's build and Quereus 4.25.0, with `pragma foreign_keys = true`, a parent table, and a child table declaring `pid text references <parent>(id) on delete cascade`:

| after deleting the parent row | Optimystic | memory table |
|---|---|---|
| parent row | gone | gone |
| child row | **still there, naming a parent that no longer exists** | gone |
| `delete … returning id` | **no rows** | the deleted row |
| `db.onDataChange` events | **none** | one per deleted row, child included |

## Cause

The `case 'delete'` arm of `update` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` ends with `return { status: 'ok' }`. `runDelete` in `@quereus/quereus/src/runtime/emit/dml-executor.ts` reads a result with no `row` as "the row was not found" and returns at once, with this comment: "Skip if row was not deleted (row not found returns ok with no row)". Everything after that check is skipped:

- `_recordDelete`, which records the change for watchers (`Database.watch` was not measured)
- row-time structure maintenance
- foreign-key actions: cascade, set null and set default
- the automatic data event
- the batched parent-side restrict check, when the statement uses one (not measured)
- the row that `returning` projects

## Expected

A delete that removes a row behaves as it does on a memory table: every step above runs, and `returning` yields the deleted row. The arm already holds the deleted row as `oldRow`.

A delete that a concurrent writer already applied is a separate case to decide when fixing this. The arm stages under an `unchangedOrAbsent` guard, so it can answer `ok` for a row a rival removed at initial staging on a mesh.

Tests should compare against a memory table, as the table above does, and cover at least cascade, set null, `returning` and the data event. Check the other `return { status: 'ok' }` sites in `update` for the same shape while there. This ticket measured only the delete arm.
