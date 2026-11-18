description: When a machine updates a row of a shared table, it now keeps the values the stored row holds for columns that machine does not know about, instead of erasing them. Another machine may have added such a column after this machine loaded the table's description.
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts (`encodeRow`, `unknownColumnsOf`, `parseStored`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`update`, its `update` case), packages/quereus-plugin-optimystic/test/stale-hydrated-table.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md
difficulty: easy
----

## What changed

- `RowCodec.encodeRow(row, prior?)`: with `prior` (the stored encoded row), every key of the stored object that names no column of this codec is copied into the new object first; every known column is then written from `row` as before. `decodeRow` and the new encode path share one `parseStored` (still throws for `msgpack`).
- The UPDATE arm of `OptimysticVirtualTable.update` now encodes after `requirePreWriteRow`, passing `oldEntry[1]`. This covers both the same-key rewrite and the primary-key move (the insert half at the new key carries the old row's unknown keys). INSERT and INSERT OR REPLACE are unchanged (a replacement row replaces whole).
- The `unchanged`/`unchangedOrEqual` guard on the pre-write entry is what holds the carried keys still under concurrency; no new mechanism.
- README: the "dropped column's values stay in the stored rows, unread" sentence now says an UPDATE keeps them and INSERT OR REPLACE does not. docs/internals.md: one paragraph under "A first touch writes only what the table owes".
- `SchemaManager.viewOverRecord`'s `NOTE:` names only index maintenance, so it was left alone.

## Test

- `stale-hydrated-table.spec.ts` › "keeps the value of a column it does not know when it updates a row": A creates `t`, B hydrates and reads, A adds `y` and sets it, B updates `a`; A reads `a = 9, y = 'kept'`. This is the ticket's reproduction. I did not re-run it against HEAD's code to watch it fail (the ticket records the repro as verified).

## Validation

- `yarn build`, `yarn typecheck`, `yarn test` in `packages/quereus-plugin-optimystic`: 1386 passing, 14 pending.
- `yarn test` in `packages/upgrade-check`: 323 passing.
- `yarn lint:docs`: clean.

## For the reviewer

- An UPDATE that moves the primary key now also carries unknown keys; check that's the intended reading of "a sequential UPDATE moving a key keeps the row's other columns".
- A rename (refused today) would leave both old and new keys in a row a stale machine updates — noted in the ticket; backlog `feat-optimystic-rename-column` already carries it.
- Cost: one extra `JSON.parse` of the stored row per UPDATE, beside the decode `requirePreWriteRow` already does.
