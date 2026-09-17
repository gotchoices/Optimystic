description: A table's stored schema description depends on the sequence of schema versions a machine went through, not only on the final declaration, so two machines running the same app version can store different schema bytes, and a restarted machine can lose a CHECK rule that a later version added.
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`tableSchemaToStored`, `mergePersistedSchemas` / `mergeIndexLists`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`addIndex` appends to the persisted index list; the module implements no `alterTable`)
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts (the byte-identity test, which today covers only the paths that hold)
  - ../quereus/packages/quereus/src/runtime/emit/add-constraint.ts (`runAddCheckEngineSide`: the engine-only CHECK path taken for a module without `alterTable`)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Sorting the index list changes the order the engine sees on a hydrated table (it would no longer match a freshly declared table's order field for field), and persisting ALTER-added constraints means implementing `alterTable` for at least `addConstraint`, which is real work in a module that has so far refused every ALTER.
----

# What is wrong

The optimystic plugin stores one catalog record per table. The warm-restart work made that record carry everything a declaration determines, and it is written byte-identically for one declaration across machines, eras, whitespace and table order (`hydrate-restores-declared-table.spec.ts`, "writes byte-identical catalog records…"). Two paths still break that. Both reproduced on 2026-09-16 with scratch scripts against the built plugin, and both behave the same on the build before the warm-restart change, so neither is a regression.

**Arm 1: index order follows creation order.** Version 1 of a schema declares `unique index ByNote on Every (Note)`. Version 2 adds `index ByBig on Every (Big)`, declared *before* `ByNote`. A machine that applied version 1 and then version 2 stores `indexes: [ByNote, ByBig]`. A machine that applied version 2 fresh stores `indexes: [ByBig, ByNote]`. Same declaration, different bytes. (`addIndex` appends to the persisted list; `mergeIndexLists` keeps the incoming order.)

**Arm 2: a CHECK added by a later version never reaches the record.** Version 1: `table t { id integer primary key, a integer }`. Version 2 adds `constraint pos check (a > 0)`. `apply schema` emits `ALTER TABLE s.t ADD constraint pos check (a > 0)`. The optimystic module implements no `alterTable`, so Quereus takes its engine-only path and adds the CHECK to its in-memory catalog alone. Observed:

| step | CHECKs on the table | `insert (…, a = -1)` |
| --- | --- | --- |
| migrating session | `pos` | refused |
| restart, `hydrate` only | none | **accepted** |
| restart, `hydrate` then `apply schema` again | `pos` | refused |

The record written by the migrating machine also differs from a fresh machine's (it has no `pos`).

A related Quereus behaviour, not this repo's to fix: the declarative differ does not emit anything for an added *unnamed* table-level `unique (a)`, even for Quereus's own memory tables (a named `constraint ua unique (a)` is diffed). A named one on an optimystic table would be refused, because adding a UNIQUE needs `alterTable`.

# Why it matters

- A downstream host (sereus) writes the catalog alone on every machine at every launch, before contacting any peer, and that is fork-safe only while every machine writes identical catalog bytes (`backlog/more-design/6.5-partition-healing`, arm of 2026-09-16 evening, residual 2). An app upgrade that adds an index ahead of an existing one, or adds a CHECK, breaks that between upgraded and freshly installed machines.
- A host that hydrates and does not re-apply its declaration loses CHECKs added by later versions (stated as a limitation in the plugin README, "Warm Restart").

# Expected behaviour

The catalog record is a function of the final declaration only: every path that ends at declaration D (fresh apply; any earlier version followed by D; with rows written in between) stores the same bytes, and hydrate restores every constraint D declares.

The general guard, rather than a test per instance: extend the byte-identity test into a migration-path property. For a declaration D and a set of earlier versions derived from D (drop an index, drop a CHECK, drop a column-level CHECK, swap declaration order of indexes), assert that each path's catalog bytes equal a fresh apply of D, and that a hydrated table equals a declared one field for field.
