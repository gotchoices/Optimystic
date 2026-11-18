description: When a machine updates a row of a shared table, it now keeps the values the stored row holds for columns that machine does not know about, instead of erasing them. Another machine may have added such a column after this machine loaded the table's description.
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts (`encodeRow`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`update`, its `update` case: `encodeRow(values)` beside `requirePreWriteRow`), packages/quereus-plugin-optimystic/README.md (the "Rows are stored keyed by column name" sentences), packages/quereus-plugin-optimystic/test/stale-hydrated-table.spec.ts (home for the regression test)
difficulty: easy
repro: verified
----

## The defect

A row is stored as a JSON object keyed by column name (`RowCodec.encodeRow` in `packages/quereus-plugin-optimystic/src/schema/row-codec.ts`). `encodeRow` builds that object from scratch, one key per column in this machine's description. An UPDATE therefore replaces the stored object with one holding only the columns this machine knows, and every other key in the stored row is lost.

Reproduced at HEAD with two sessions over one `MemoryRawStorage` through the `local` transactor (the harness in `test/stale-hydrated-table.spec.ts`): A creates `main.t (id integer primary key, a integer null)` and inserts `(1, 5)`; B hydrates and runs `select * from main.t`; A runs `alter table main.t add column y text null` and `update main.t set y = 'kept' where id = 1`; B runs `update main.t set a = 9 where id = 1`. A then reads `{ id: 1, a: 9, y: null }`.

## The fix

The UPDATE arm of `OptimysticVirtualTable.update` already reads the stored entry before staging (`requirePreWriteRow` returns `entry`, the entry as stored, `[primaryKey, encodedRow]`). Encode the new row over that entry's object: every key the stored object holds that names none of this codec's columns is carried into the new object unchanged; every column this codec knows is written from `values` as today. Matching is by the same rule `decodeRow` uses to read a column (exact `col.name` key).

- **Only UPDATE carries keys over**, including the primary-key move (delete at the old key, insert at the new one), since a sequential UPDATE moving a key keeps the row's other columns. INSERT has no prior row. INSERT OR REPLACE over an occupied key does not carry: a replacement row under the newer description would read NULL in the column this statement did not name, and so does a replacement that leaves the key out.
- **Concurrency needs nothing new.** The UPDATE's main-tree element already carries an `unchanged` (or `unchangedOrEqual`) guard on the entry as read, so a rival that changed the row after this machine read it refuses this write at commit; the carried keys therefore always come from the row the guard holds still.
- **The "already applied" guards still compare whole entries** (`structuralEquals` ignores key order), so two machines making the same self-independent update with the same carried keys still see each other's write as equal.

## Consequences to state in the README

The README says a dropped column's values "stay in the stored rows, unread" and that re-adding the name reads them back. Today an UPDATE strips such a value; after this change it keeps it, so the sentence becomes true of every row rather than only of rows not updated since the drop. Say so where those sentences are.

A column renamed in the record while another machine still uses the old name would leave both keys in a row that machine updates; renaming is refused today (backlog `feat-optimystic-rename-column`, which carries a line about this).

## Tests

One regression test, the reproduction above, in `test/stale-hydrated-table.spec.ts`: after B's update, A reads `y = 'kept'` and `a = 9`. It fails at HEAD.

## TODO

- Give `RowCodec.encodeRow` an optional prior encoded row; carry its keys that name no column of the codec. Keep `decodeRow` unchanged.
- Pass `oldEntry[1]` from the UPDATE arm of `update` (both the same-key and the primary-key-move paths); leave INSERT and INSERT OR REPLACE as they are. The call sits above `requirePreWriteRow` today, so move it below.
- Add the regression test.
- Update the README sentences on dropped columns, and the `NOTE:` on `SchemaManager.viewOverRecord` only if its wording names value loss (it names index maintenance).
- `yarn build`, `yarn typecheck` and `yarn test` in `packages/quereus-plugin-optimystic`; `yarn test` in `packages/upgrade-check` (no stored format changes, so it should pass unchanged).
