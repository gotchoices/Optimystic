description: Let an Optimystic table drop a named CHECK rule with `alter table … drop constraint`, saved in the table's stored description, and make every catalog-only table change safe when two machines of one network apply the same schema upgrade at about the same time. First of two tickets that let Sereus upgrade a party's shared control database in place.
prereq: bug-optimystic-table-tag-changes-lost-on-restart
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`alterTable`, `addCheckConstraint` on the module and on `OptimysticVirtualTable`, `schemaBatch`, `underBatchCheckpoint`, `followTableTags` for the manager-without-instance pattern), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`withCheckConstraint`, `checkConstraintToStored`, `storeStoredSchema`, `getSchemaFresh`), packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts, packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts, packages/quereus-plugin-optimystic/test/schema-batch.spec.ts, packages/quereus-plugin-optimystic/README.md (the ALTER paragraph under the hydrate section), .release-notes.pending.md, ../quereus/packages/quereus/src/runtime/emit/alter-table.ts (`runDropConstraint`), ../quereus/packages/quereus/src/schema/schema-differ.ts (`readdConstraint`, `dropAddedConstraint`), ../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts (`runStepsWithUndoJournal`, `unwindJournal`)
----

# Catalog-only ALTER, part 1: DROP CONSTRAINT of a CHECK, and the two-machine rule

Origin: Sereus `../sereus/tickets/blocked/optimystic-catalog-only-alter-table.md` (gotchoices/sereus#46). On a warm start Sereus runs `apply schema CadreControl` on every machine of a party, one phone at a time, and the Quereus differ emits only `create table`, `create index`, `drop index`, `add constraint … check`, `set tags`, `add column … null`, `drop column`, and `drop constraint` (for a CHECK; a changed CHECK body is emitted as `drop constraint x` then `add constraint x check (…)`). This ticket adds DROP CONSTRAINT and puts the existing ADD CONSTRAINT CHECK arm on the same footing; `catalog-only-add-and-drop-column` adds the two column arms on top of the helper built here.

## Background the implementer needs

- The table's catalog record (`StoredTableSchema`, persisted name-keyed as `PersistedTableSchema`) lives in the replicated tree `tree://optimystic/schema`. A record write replaces the whole record except `indexes`/`orphanedIndexes`, which `mergePersistedSchemas` unions with what the catalog holds. So writing a record without a CHECK removes it; nothing unions CHECKs back.
- Inside `apply schema`, record writes stage into the module's catalog batch (`beginSchemaBatch` … `endSchemaBatch`) and land in one commit. `endSchemaBatch` commits even when the apply failed — by then the engine has either unwound the landed steps (each step's undo DDL runs through this module's hooks, inside the batch) or reported the schema partially migrated; either way the overlay and the engine's catalog agree.
- Undo DDL Quereus 4.20 renders for the arms that matter here (`schema-differ.ts`): undo of `add constraint x check` is `drop constraint x` (`dropAddedConstraint`); undo of `drop constraint x` is `add constraint x check (<pre-apply body>)` (`readdConstraint`). After unwinding, the engine compares its catalog against the pre-apply rendering and reports "partially migrated" on any difference.

## The two-machine problem, and the rule that settles it

Machine A finishes the upgrade and commits the new record. Machine B hydrated before A's commit, so B's engine still holds the old schema, and B now runs the same apply. B's statements meet a record that is already in (part of) the target state.

Two options were open (from the ticket): (a) the arm finds the record already matching and writes nothing, or (b) it fails with a retryable error and a re-run succeeds. **(a) is chosen.** (b) does not converge: B's engine catalog is the input to the differ, and nothing in the plugin can refresh it, so the re-run emits the same statement and fails again until the host re-opens the `Database` and re-hydrates. (a) converges in the same apply.

(a) alone is not enough, because of undo. If a later step of B's apply fails, the engine unwinds B's earlier steps — and the undo of an "add" that B found already present is a "drop" that would delete A's committed change from the shared record. Likewise the undo of a "drop" that B found already gone would re-add the old CHECK body over A's new one. So:

**An arm that finds the record already in its target state writes nothing and records the target as *adopted* in the open batch. A later arm in the same batch that would reverse an adopted target changes this machine's engine catalog and instance only, never the record, and clears the mark.** Within one apply the differ never adds and drops the same object, so a reversal of an adopted target inside one batch is always an undo. Outside a batch (direct DDL) no undo follows, so the arm just writes nothing on a match and marks nothing.

Per arm, judged against the record read fresh (`getSchemaFresh`, which reads through the batch overlay when one is open), comparing CHECKs on the persisted form of every field except `tags` (`checkConstraintToStored` then `structuralEquals` with `tags` removed — tags converge through the `set tags` statements the same apply emits, and comparing them would refuse an honest second machine):

| arm | record holds | outcome |
| --- | --- | --- |
| DROP CONSTRAINT x (a CHECK) | x, body equal to this engine's x | owned: remove x from the record |
| | no x | adopted: no write |
| | x, body different from this engine's x | adopted: no write (another machine replaced it; the `add constraint x` that follows in a changed-body pair then finds it equal) |
| ADD CONSTRAINT x CHECK | no x | owned: add (today's behaviour) |
| | x, body equal | adopted: no write |
| | x, body different | owned: replace (today's "local DDL wins" rule in `withCheckConstraint`, kept) |
| either, target adopted earlier in this batch | — | engine and instance only; no record write; clear the mark |

Adopted marks are keyed per table and object (`<schema>.<table>` lower-cased, kind `check`, name lower-cased) and live on `schemaBatch`; they die with the batch. Record the mark only after the arm's work succeeded.

NOTE to record at the CHECK arm: the third ADD row means a machine applying an *older* body over a newer one still overwrites it, and that write's undo removes the CHECK from the record. Reaching it takes two different upgrades racing on one table; accepted.

## What to build

**One shared path for catalog-only arms.** A private helper on `OptimysticModule` that every catalog-only arm (these two now, the column arms next ticket) goes through:

- Resolve the table's `SchemaManager` the way `followTableTags` does — the existing instance's `catalogManager`, else `createSchemaManager(parseTableSchema(tableSchema))`. **Do not instantiate a table that has no instance.** Instantiating a hydrated table builds it from this machine's engine catalog, and its first initialize compares that against the record and rewrites the record on any difference (`doInitialize`'s DDL-wins arm) — on machine B that writes B's stale schema over A's committed change, defeating the adopted rule. (That hazard exists for every hydrated table today; it is filed as `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record`.) An instance that exists but is not initialized is initialized first, as `OptimysticVirtualTable.addCheckConstraint` does today, so a record that never landed (`markSchemaUnpersisted`) is re-persisted before it is extended.
- Read the record fresh; a missing live record is an error naming the table (as today).
- Classify (pure function over the record, this engine's pre-state and the change; unit-testable without a database): owned edit, adopted, or refused.
- Owned: write through `storeStoredSchema` inside `underBatchCheckpoint(table-or-manager, 'written', …)` so a throw withdraws it and a failed batch commit marks the table unpersisted. `underBatchCheckpoint` takes a table today; widen it to take the manager plus an optional table (the `written` set is keyed by manager, and `markSchemaUnpersisted` needs the instance only when one exists), as `followTableTags` already registers a manager-only write.
- Every outcome that succeeds updates an existing instance's own `tableSchema` with the same edit (instance first only after the record write staged, as today), and returns the engine's `tableSchema` with the edit applied (built from the engine's object, never the instance's — they differ on purpose, see `followSchemaTags`).
- Inside a batch, record or consume the adopted mark as above.

**DROP CONSTRAINT.** Resolve the name case-insensitively against the engine's `tableSchema.checkConstraints` (Quereus has already resolved the class and raised NOTFOUND/ambiguity before calling). A CHECK goes through the helper; a UNIQUE or FOREIGN KEY name stays refused with today's text, `Module for table '<t>' does not support ALTER TABLE DROP CONSTRAINT`, `UNSUPPORTED`. New `SchemaManager.withoutCheckConstraint(stored, name)` beside `withCheckConstraint`, same name rule. The engine's returned schema filters `checkConstraints` by name; an unnamed CHECK is dropped by its minted name (`_check_<col>`), which is the name both the engine and the record carry.

**ADD CONSTRAINT CHECK** moves onto the helper with the table above. Its existing behaviour (build with `buildCheckConstraintSchema`, enforced at once, rows not re-checked, local-DDL-wins on a different body) is otherwise unchanged.

## Edge cases & interactions

- **Changed CHECK body (drop x, add x) on machine B after A migrated.** DROP finds x with A's new body ≠ B's old → adopted; ADD finds x equal to the new body → adopted. Record untouched. If a later step fails, both undos are engine-only and the record keeps A's body. Test.
- **Failed apply on one machine, undo path.** `apply schema` with `drop constraint pos` followed by a step that fails (the storage-adoption guard refusal `schema-batch.spec.ts` already uses works): the apply must report a verified restore (message does not match `/partially migrated|could not be restored/`), the CHECK is enforced again in the session, and after a restart that only hydrates it is still in the record. Same for `add constraint` followed by a failure. Test both.
- **Undo after an adopted step.** Two sessions over shared storage (harness: `shared-local-transactor.ts`): both hydrate; A applies a schema that drops `pos`; B (still holding `pos` in its engine) applies the same schema plus a failing step. B's apply restores B's engine; the record still lacks `pos` (A's change). Test.
- **Concurrent apply.** A and B apply the same schema at once (`Promise.all`); both succeed, the record holds the target exactly once. Test (can share the setup with the case above).
- **Hydrated table no statement has touched.** Both arms work with no instance and create none; the table then works and the record survives a restart. The existing `'ADD CHECK on a hydrated table no statement has touched yet …'` spec covers ADD; add the DROP counterpart only if it is not a near-copy — otherwise fold DROP into that spec.
- **Instance whose record never landed** (`markSchemaUnpersisted` after a failed batch commit): initialized first, then the arm extends the re-persisted record. Existing coverage in `alter-table-arms.spec.ts` ("a CHECK added to a table this session already wrote through …"); keep it green.
- **Tags on the dropped CHECK.** Gone with it. A later `followTableTags` save for the same `table_modified` finds nothing to overlay. Verify by inspection.
- **The tag listener.** Quereus fires `table_modified` after this arm returns; `followTableTags` overlays tags onto the instance and record and must find the record already consistent. Verify by inspection (structural events already hit it).
- **DROP of a UNIQUE / FOREIGN KEY constraint** stays refused with today's text. The `REFUSED` table in `alter-table-arms.spec.ts` keeps a DROP CONSTRAINT row, switched to a UNIQUE or FK constraint name; remove the CHECK row.
- **Old builds.** A machine still on the previous release that runs `apply schema` with its older declaration over a catalog a newer machine extended will now *succeed* at undoing the newer change (its differ emits `drop constraint` for a CHECK only the new release declares). Today the refusal blocks that by accident. The plugin cannot tell an older declaration from a deliberate change; the host must not apply a declaration older than the stored one (Sereus keeps its control-schema version in a table tag for this). Say so in the README.

## Docs

- README, the ALTER paragraph: DROP CONSTRAINT of a CHECK is saved; the two-machine rule in one or two sentences (a change already in the stored description is adopted, not rewritten, and an undo never removes what this machine's apply did not put there); the caller obligation about older declarations. Keep the list of refused arms accurate.
- `docs/internals.md` needs nothing unless the helper ends up with a name worth citing; do not add a section.
- `.release-notes.pending.md`: one entry under "Unreleased", combined with the column arms if `catalog-only-add-and-drop-column` lands in the same release (that ticket finishes it).

## TODO

- Shared catalog-only helper on `OptimysticModule` (manager resolution without instantiation, fresh read, pure classification, owned write under a widened `underBatchCheckpoint`, instance update, adopted marks on `schemaBatch`).
- `SchemaManager.withoutCheckConstraint`; persisted-form CHECK comparison ignoring tags.
- DROP CONSTRAINT arm for CHECKs; UNIQUE/FK stay refused.
- Move ADD CONSTRAINT CHECK onto the helper; keep the "local DDL wins" overwrite and add the NOTE above.
- Unit test for the classification function (the table above, one case per row).
- Specs: DROP CONSTRAINT enforced off at once and survives a hydrate-only restart; undo of drop and of add through a deliberately failed apply; two-session adopted undo; concurrent apply; changed-body pair on the second machine. Update the `REFUSED` table.
- README and release note.
- `yarn workspace @optimystic/quereus-plugin-optimystic build`, then its `test` and `typecheck`; `yarn lint:docs`.
