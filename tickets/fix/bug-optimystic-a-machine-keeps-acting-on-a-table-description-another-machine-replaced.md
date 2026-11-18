description: A machine that is already running keeps using its old description of a shared table after another machine changes it, so its writes can erase a value in a column it does not know about or leave rows out of an index it does not know about, with no error on either machine.
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts (`encodeRow`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`update`, `reconcileMaintainedIndexes`), packages/quereus-plugin-optimystic/src/schema/index-manager.ts
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: It only happens between one machine's schema change and another's restart or re-apply, and following schema changes live needs a catalog check on the write path and an answer for statements Quereus has already planned, so a maintainer may prefer to require all machines to upgrade before any writes.
----

Each machine loads table descriptions from the shared catalog when it hydrates and does not hear about later changes. Nothing compares the description a write used with the one the catalog now holds. Both cases below ran at HEAD with two sessions over one `MemoryRawStorage`, with B having read `t` before A's change:

- **A value is erased.** A runs `alter table main.t add column y text null` and `update main.t set y = 'kept' where id = 1`. B runs `update main.t set a = 9 where id = 1`. A now reads `{id: 1, a: 9, y: null}`. B rewrites the whole row from its own column list (`encodeRow`), so a column it does not know is dropped.
- **An index misses a row.** A runs `create index t_a on main.t (a)`. B runs `insert into main.t (id, a) values (2, 7)`. A's `select id from main.t where a = 7` returns nothing, and `verifyIndexes` reports one missing entry. B's `IndexManager` holds the index list from its own initialization and refreshes it only in `addIndex`.

A table a machine first touches after the change has the same problem once `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record` lands: that ticket stops the older description being written back, and deliberately leaves the machine on its old columns, because the engine plans statements from its own catalog entry. That ticket also leaves an index over a column the machine does not know unmaintained there.

## Expected

A write made under a description older than the catalog's either follows the current description or is refused, so that no value or index entry is lost silently. Which of these applies, and how a running engine's catalog entry gets refreshed, is the design question. `alter table` arms and `apply schema` on the stale machine already refresh or adopt parts of this, so the design should start from what they do.

`bug-unique-enforcement-tree-set-differs-across-handles` is a related case at a narrower site, where machines disagree about which uniqueness trees exist.
