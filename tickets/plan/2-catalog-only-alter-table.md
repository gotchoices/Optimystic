description: The plugin refuses `alter table … add column`, `drop column` and `drop constraint`, so Sereus cannot upgrade a party's replicated control database in place when a phone updates the app. Add catalog-only arms for a nullable column with no default, a column in no index and not in the primary key, and a CHECK constraint. None rewrites a row, each is undoable inside a failed `apply schema`, and each is harmless when a second machine applies it.
prereq: bug-optimystic-table-tag-changes-lost-on-restart
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, ../quereus/packages/quereus/src/schema/schema-differ.ts
----

# Catalog-only ALTER TABLE: add a nullable column, drop a column, drop a CHECK

From Sereus `../sereus/tickets/blocked/optimystic-catalog-only-alter-table.md` (gotchoices/sereus#46). Read that report for the full analysis and the rejected alternatives. Sereus's `implement/control-store-migrates-on-start` waits on this.

## Why

The maintainer decided (2026-10-15, on #46) that a control-schema change is applied to each machine's existing control store when that machine starts on the new release, because phones update one at a time. On a warm start Sereus runs `apply schema CadreControl`, and the Quereus differ emits only these statements between consecutive versions (Sereus enforces the limit):

- `create table`, `create index`, `drop index`, `alter table … add constraint <name> check (…)`: supported today.
- `alter table … set tags (…)`: runs but is not saved. That is the prereq, `bug-optimystic-table-tag-changes-lost-on-restart`; Sereus keeps its control-schema version in a tag.
- `alter table … add column <name> <type> null`, with no default, no generated expression and no inline constraint.
- `alter table … drop column <name>`, for a column in no index and not in the primary key.
- `alter table … drop constraint <name>`, for a CHECK. The differ emits a changed CHECK body as this drop followed by an add.

`OptimysticModule.alterTable` throws `UNSUPPORTED` for the last three today.

## Why no row is rewritten

`RowCodec.encodeRow` stores a row as a JSON object keyed by column name. `decodeRow` reads each catalog column by name, a missing field reads as null (`denormalizeValue`), and a field with no column is ignored. So a row written under either catalog reads under the other.

## Expected

1. **ADD COLUMN**, nullable with no DEFAULT, GENERATED expression or inline constraint: write the column to the table's catalog record, inside the open `beginSchemaBatch`/`endSchemaBatch` pair so it commits with the rest of the apply. Existing rows read null. Any other ADD COLUMN stays refused as today.
2. **DROP COLUMN**, for a column in no index and not in the primary key: remove it from the record. Rows keep the field, which is ignored on read and dropped the next time the row is rewritten. A later ADD COLUMN under the same name would read those old values again. Decide in the plan whether to document that or refuse the re-add; Sereus never reuses a dropped name.
3. **DROP CONSTRAINT** of a CHECK: remove it from the record; mirror `addCheckConstraint`.
4. **Undo:** Quereus unwinds a failed `apply schema` by running each step's undo (`dropAddedColumn`, `droppedColumn`, `readdConstraint` in `schema-differ.ts`). Each arm must work when it runs as an undo step, as `create table`/`drop table` already do. A DROP COLUMN's undo re-adds the column, and its row values come back.
5. **Applied twice:** two machines of one network can run the same alteration at about the same time. The catalog tree `tree://optimystic/schema` is replicated, so a machine may find its stored record already changed while its own catalog has not caught up. It must not fail permanently. Either the arm finds the record already matching and writes nothing, or it fails with an error a schema-init retry can classify as transient and a re-run succeeds. The plan picks one and the docs name it.

Tests: each arm over a single handle, the undo path through a deliberately failed `apply schema`, a restart reading old rows under the new catalog, and the two-handle concurrent apply. Docs: the plugin README's ALTER support list. Add a line to `.release-notes.pending.md`.
