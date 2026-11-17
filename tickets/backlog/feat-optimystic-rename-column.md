description: Renaming a column on an Optimystic-backed table works for the rest of the session but is not saved, so after a restart the column has its old name again.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`alterTable` `renameColumn` arm, added by optimystic-alter-add-check-persists)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (index columns persisted by NAME; CHECK / default / generated expressions persisted as ASTs naming columns)
  - ../quereus/packages/quereus/src/runtime/emit/alter-table.ts (~L388–470, rename column)
prereq: optimystic-alter-add-check-persists
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Declarative hosts rarely rename columns, and doing it properly means rewriting every place the record names the column (index columns, CHECK, default and generated expressions, foreign keys) — refusing the rename outright is a cheaper honest alternative.
----

Verified 2026-09-17: `create table main.t (id integer primary key, a integer null, constraint pos check (a > 0))`, insert a row, `alter table main.t rename column a to aa` succeeds and the session sees `[id, aa]`. A new session over the same storage that runs `hydrate` sees `[id, a]`. The rename goes through Quereus's engine-side schema-only fallback, which never reaches the catalog record.

Expected: either the rename is persisted (record columns, index column names, and every stored expression that names the column rewritten, byte-identical to a fresh declaration with the new name), or it is refused with a clear error instead of silently reverting on restart.
