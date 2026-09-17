description: A new schema version that adds a named UNIQUE rule or a foreign key to an existing Optimystic-backed table fails to apply at all, because the plugin cannot add those constraints to a table that already exists.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`alterTable` `addConstraint` arm, added by optimystic-alter-add-check-persists; `addIndex` for how a unique enforcement tree is built and back-filled)
  - ../quereus/packages/quereus/src/runtime/emit/add-constraint.ts (`runAddConstraintViaModule`)
  - ../quereus/packages/quereus/src/vtab/memory/layer/manager.ts (`addUniqueConstraint`, `addForeignKeyConstraint` — reference behaviour)
prereq: optimystic-alter-add-check-persists
tradeoffs: Adding a UNIQUE to a populated distributed table means scanning and validating every existing row and building an enforcement tree inside one apply, and a host can work around it today by declaring the rule as a unique index, which already migrates.
----

Verified 2026-09-17: version 1 `table t { id integer primary key, a integer null }`, version 2 adds `constraint ua unique (a)`. `apply schema` fails with `Failed to execute DDL: ALTER TABLE s.t ADD constraint ua unique (a)` / `Module for table 't' does not support ADD CONSTRAINT`, and the whole upgrade is refused. A foreign key added the same way takes the same module-routed path and is refused the same way (static: `runAddConstraintViaModule` requires `alterTable`).

Expected: the constraint is added, existing rows are validated (duplicate values / dangling references refuse the ALTER with a constraint error and leave the table unchanged), the enforcement structure is built, and the catalog record ends byte-identical to a fresh apply of version 2 and survives `hydrate`.
