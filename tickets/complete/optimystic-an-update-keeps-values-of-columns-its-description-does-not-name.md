description: When a machine updates a row of a shared table, it now keeps the values the stored row holds for columns that machine does not know about, instead of erasing them. Another machine may have added such a column after this machine loaded the table's description.
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
files: packages/quereus-plugin-optimystic/src/schema/row-codec.ts (`encodeRow`, `unknownColumnsOf`, `parseStored`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`update`, its `update` case), packages/quereus-plugin-optimystic/test/stale-hydrated-table.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md
difficulty: easy
----

## What changed

- `RowCodec.encodeRow(row, prior?)`: given `prior` (the stored encoded row), it first copies every key of the stored object that names no column of this codec, then writes every known column from `row` as before. `decodeRow` and the new path share one `parseStored`, which still throws for `msgpack`.
- The UPDATE arm of `OptimysticVirtualTable.update` now encodes after `requirePreWriteRow` and passes `oldEntry[1]`. This covers the same-key rewrite and the primary-key move: the insert half at the new key carries the old row's unknown keys. INSERT and INSERT OR REPLACE are unchanged, so a replacement row replaces the whole row.
- The `unchanged`/`unchangedOrEqual` guard on the pre-write entry keeps the carried keys correct under concurrency. No new mechanism was needed.
- README and docs/internals.md §A first touch writes only what the table owes describe the new behaviour.

Test: `stale-hydrated-table.spec.ts` › "keeps the value of a column it does not know when it updates a row" (the ticket's reproduction).

## Review findings

Read the diff from `ticket(implement): optimystic-an-update-keeps-values-of-columns-its-description-does-not-name` before the handoff notes.

- **Correctness, happy path and the arms the handoff asked about.** I ran temporary probes beside the new test, then removed them: an `insert … on conflict (id) do update` on the stale machine (the engine sends this through the UPDATE arm), a primary-key move (`update set id = 2`), and a drop-column → update → re-add on one machine. All three keep the carried value. Reading "a sequential UPDATE that moves a key keeps the row's other columns" as including unknown keys is consistent with the docs. No change needed.
- **Concurrency.** The guard's `expected` is still the entry as read, and the new encoding carries the same unknown keys the rival's row has. So `unchangedOrEqual` still treats an equal rival row as equal. Found during probing: an upsert sent by the stale machine *without a read before it* is refused at commit with `TreeEntryChangedError`. The insert arm's pre-stage `collection.get` does not pull the latest state first, so the guard was built over an older entry. That is the guard working as designed: the refusal can be retried, and it existed before this change. No action.
- **Interaction with indexes.** This change makes things better: before it, an UPDATE on a stale machine erased a value that the other machine's index over that column still had an entry for. After it, the value and the index entry stay consistent. INSERT OR REPLACE on a stale machine still erases the column and leaves the other machine's index entry behind it. That case belongs to a broader class that the implement ticket `bug-optimystic-a-machine-keeps-acting-on-a-table-description-another-machine-replaced` already covers: it refuses any write made under an out-of-date description. No new ticket.
- **Rename (refused today).** When renames are allowed, a stale machine's update would leave both the old and the new key in a row. This is already in backlog `feat-optimystic-rename-column`, as the handoff says. No action.
- **Type safety / hygiene.** `parseStored` casts the result of `JSON.parse` to a record, which matches the existing decode. A column literally named `__proto__` would be mishandled by both the old `{}` accumulator and the new one. The ticket did not introduce that, it is contrived, and no action was taken. `row-codec.ts` stays small.
- **Performance.** One extra `JSON.parse` of the stored row per UPDATE. This is negligible next to the decode `requirePreWriteRow` already does. No tripwire needed.
- **Tests.** The one new test is the bug's reproduction, at the lowest layer that shows it (two sessions over shared storage). It pays for itself. Nothing cut or added.
- **Docs.** README's paragraph on stored rows and the internals paragraph match the code. `SchemaManager.viewOverRecord`'s `NOTE:` is about index maintenance only and is still accurate.
- **Validation.** `stale-hydrated-table.spec.ts` passes (15). `yarn lint` and `yarn lint:docs` are clean. The implementer's full package run (1386 passing) and the upgrade-check run (323 passing) stand. This review made no source changes, so I did not re-run those.
