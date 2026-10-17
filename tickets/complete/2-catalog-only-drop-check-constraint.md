description: Let an Optimystic table drop a named CHECK rule with `alter table … drop constraint`, saved in the table's stored description, and make the CHECK changes safe when two machines of one network apply the same schema upgrade at about the same time. First of two tickets that let Sereus upgrade a party's shared control database in place.
prereq: bug-optimystic-table-tag-changes-lost-on-restart
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`alterTable`, `addCheckConstraint`, `dropCheckConstraint`, `alterCatalogOnly`, `saveCatalogOnly`, `CatalogOnlyAlter`, `withCheck` / `withoutCheck`, `underBatchCheckpoint`, `recordBatchEffect`, `OptimysticVirtualTable.applyCatalogOnlyEdit`), packages/quereus-plugin-optimystic/src/schema/catalog-only-change.ts (new: `classifyCheckChange`, `AdoptedChanges`, `sameCatalogObject`, `findNamed`), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`checkConstraintToStored`, `withCheckConstraint`, `withoutCheckConstraint`), packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts, packages/quereus-plugin-optimystic/test/catalog-only-change.spec.ts, packages/quereus-plugin-optimystic/README.md, .release-notes.pending.md, tickets/backlog/bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record.md, tickets/backlog/bug-optimystic-failed-apply-on-a-second-machine-reverts-saved-tags.md
----

# Catalog-only ALTER, part 1: DROP CONSTRAINT of a CHECK, and the two-machine rule

Origin: Sereus `../sereus/tickets/blocked/optimystic-catalog-only-alter-table.md` (gotchoices/sereus#46). The follow-on `catalog-only-add-and-drop-column` (still in `implement/`) adds the column arms on the helper built here.

## What changed

- **DROP CONSTRAINT of a CHECK** is now accepted on an Optimystic table and saved in the catalog record (`alterTable` → `dropCheckConstraint`). The CHECK is found in the engine's `tableSchema.checkConstraints` by name, case-insensitively; a UNIQUE or FOREIGN KEY name is still refused with `Module for table '<t>' does not support ALTER TABLE DROP CONSTRAINT`, `UNSUPPORTED`.
- **ADD CONSTRAINT CHECK** moved onto the same path. Behaviour otherwise unchanged (Quereus's builder, same minted names, "local DDL wins" over a same-named CHECK with another body — now with the accepted-tradeoff `NOTE:` the plan asked for).
- **One shared path, `OptimysticModule.alterCatalogOnly`**, driven by a `CatalogOnlyAlter` description (object `kind` + `name`, the engine's object `before` / `after` in record form, `classify`, `editRecord`, `editSchema`). It resolves the table's `SchemaManager` the way `followTableTags` does and **never instantiates a table**; an existing uninitialized instance is initialized first, inside the batch checkpoint. It reads the record fresh, classifies, writes an owned change through `storeStoredSchema` under `underBatchCheckpoint`, applies the edit to an existing instance (`applyCatalogOnlyEdit`) and returns the engine's schema with the edit applied.
- **`underBatchCheckpoint` takes the manager** (not a table; the table was only used to reach its manager). The written/dropped bookkeeping is one helper, `recordBatchEffect`, which `followTableTags` now uses too.
- **Two-machine rule.** `classifyCheckChange` (pure, `catalog-only-change.ts`) implements the plan's table: drop of the same CHECK → owned; drop of an absent or differently-bodied CHECK → adopted; add over absent → owned; add of the same CHECK → adopted; add over a different body → owned (replace). CHECKs compare on their record form, ignoring tags and the case of the name (`sameCatalogObject`). Inside `apply schema`, adopted changes are recorded on the batch (`schemaBatch.adopted`, an `AdoptedChanges`), and a later change that undoes one touches only this machine's engine catalog and instance.
- `checkConstraintToStored`, `withCheckConstraint` and the new `withoutCheckConstraint` are **exported free functions** in `schema-manager.ts`, beside `withoutIndex` (the plan said "`SchemaManager.withoutCheckConstraint` beside `withCheckConstraint`"); they are pure, and the module needs them before it has a manager.

## Deviation from the plan: how an undo is recognised

The plan's rule — "a later arm that would reverse an adopted target is engine-only", justified by "within one apply the differ never adds and drops the same object" — does not hold for a changed CHECK body: the differ emits `drop constraint x` then `add constraint x` for one object in one apply. Under the literal rule the forward add would be taken as the drop's undo, and the real unwind would then write the old body over the other machine's new one.

Implemented instead (`AdoptedChanges`): each adopted change is recorded, per `(table, kind, name)`, as **what this machine's engine held for the object before the change** (a CHECK body, or nothing), on a stack. A change *undoes* the newest entry when it puts the object back to exactly that state. Quereus's undo of a step always restores the pre-step state; the forward add of a changed-body pair carries a different body, so it never matches. The unwind of a doubly-adopted pair then pops the add's entry, then the drop's. Owned changes record nothing: their undo is judged against the record like any change and finds what this machine wrote. The unit spec walks this sequence.

## Use cases to validate

- `alter table t drop constraint pos` on a live table: the CHECK stops being enforced at once and is gone after a hydrate-only restart.
- Same on a hydrated table no statement has touched: no table instance is built by the DROP (asserted), the record loses the CHECK.
- `apply schema` dropping (or adding) a CHECK, followed by a step that fails: the error is the step's own (not "partially migrated"), the CHECK is back (or gone) in the session, and in the record after a restart.
- Two machines over one store, both hydrated at v1:
  - A applies v2 (drops `pos`); B applies v2 plus a failing step: B's drop is adopted, the unwind re-adds `pos` on B only, the record keeps A's drop.
  - A and B apply the same v2 (adds `small`) concurrently: both succeed, the record holds `small` once.
  - A changes `pos`'s body; B (holding a live instance) applies the same plus a failing step: both halves adopted, both undos engine-only, the record keeps A's body, B enforces its old body.

## Tests added or changed

- `test/catalog-only-change.spec.ts` (new): one case per row of the classification table, and the adopted-change stack through a changed-body pair and its unwind.
- `test/alter-table-arms.spec.ts`:
  - `REFUSED`: the DROP CONSTRAINT row now drops a UNIQUE (`one_a`, added to `TABLES`).
  - New: DROP CONSTRAINT of a CHECK is enforced off at once and survives a hydrate-only restart.
  - Changed: the hydrated-untouched spec now does DROP then ADD, asserts the DROP builds no instance, and checks the record holds exactly `['small']`.
  - New `describe('inside apply schema, on one machine and on two')`: undo of DROP, undo of ADD, concurrent apply, second machine adopting a DROP then failing, second machine adopting both halves of a changed body then failing. The failing step is a declared `constraint one_c unique (c)` (the module refuses it); it is declared last so its step runs after the CHECK steps (constraint adds run in declaration order).

`yarn workspace @optimystic/quereus-plugin-optimystic build`, `test` (1031 passing, 14 pending as before), `typecheck`, `yarn lint:docs`, and eslint on the touched files: all green.

## Known gaps — please weigh these

- **A machine that only hydrated can still lose another machine's CHECK.** Quereus checks stored rows against an added CHECK with a `select` before calling the module (`rejectCheckViolatedByExistingRows`); on a hydrated table no statement has touched, that builds the instance, whose first initialize writes this machine's older description into the open batch (the existing backlog bug `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record`). Verified: B hydrated, A changed `pos`'s body, B applies the same plus a failing step → the record ends with **no `pos`**. Without the failing step the record ends right. The changed-body spec has B read the table first to stay clear of this, and says why. I appended this trigger, with the repro, to that backlog ticket (now `repro: verified`, and its tradeoffs line no longer claims the ALTER arms avoid the trigger), added a README Limitations bullet and a release-note line, and left `NOTE:`s at `addCheckConstraint` and `resolveConnectedTable`. A reviewer may judge the backlog bug should be promoted ahead of the column ticket — ADD COLUMN reads rows before dispatch for a NOT NULL column too.
- **Tags have no adopted rule.** Filed `tickets/backlog/bug-optimystic-failed-apply-on-a-second-machine-reverts-saved-tags.md` (verified): on a second machine whose apply fails after its `set tags` step, the undo is saved over the other machine's record — Sereus's version tag goes back from 2 to 1. The tag listener overlays every tag on every event, so it needs its own design; out of this ticket's scope.
- **`written` is recorded for adopted and undone outcomes too**, as `followTableTags` already does for every tag event. If the end-of-batch catalog commit then fails, the table is marked unpersisted and its next touch re-persists this machine's description — after an engine-only undo that is the older one. Needs a failed apply *and* a failed catalog commit; noted on the stale-hydrated backlog ticket as a second path.
- **Not tested:** an apply that renames a column and drops a CHECK naming it in one go. The unwind's re-added body passes through Quereus's `forwardRenamedConstraint`; if it no longer equals the dropped body, the undo is judged against the record like an owned change (correct on one machine; on a second machine it would re-add the old body to the record). RENAME COLUMN is not saved at all today (`bug-optimystic-rename-column-lost-on-restart`).
- README correction made in passing: it said rows already stored are not re-checked against an added CHECK; Quereus does check them now (and refuses the ALTER when one fails). Verified by experiment.

## For the column ticket

`CatalogObjectKind` is `'check'` only; add `'column'`. `CatalogOnlyVerdict` already has a `refused` arm, which `saveCatalogOnly` raises as `ERROR` — nothing produces it yet. `sameCatalogObject` ignores tags and name case, which matches that ticket's column comparison. ADD COLUMN's undo (DROP COLUMN, `after` absent) matches an adopted ADD's entry (`before` absent) under the stack rule unchanged. The `.release-notes.pending.md` entry ("Optimystic tables accept catalog-only ALTER TABLE") is written for this ticket; that ticket finishes it.

## Review findings

Read the diff of `ticket(implement): catalog-only-drop-check-constraint` first, then the handoff above. Ran the package build, `typecheck`, eslint on the touched sources, `yarn lint:docs`, and the full package `test` (1031 passing, 14 pending, as before).

**Checked, no change needed**
- Correctness of `classifyCheckChange` against every row of the table, and of the `AdoptedChanges` stack (the deviation from the plan) by walking the owned pair, the doubly-adopted changed-body pair and its unwind, and mixed owned/adopted sequences: each undo restores the pre-step state and lands where it should (record or engine only).
- `createSchemaManager` is cached per binding fingerprint and a manager created mid-apply joins the open batch, so the instance-less path of `alterCatalogOnly` writes into the same batch as everything else.
- `underBatchCheckpoint` no longer short-circuits outside a batch; `checkpointBatch` returns undefined there and `recordBatchEffect` is a no-op, so behaviour outside `apply schema` is unchanged.
- Docs: README (the CHECK paragraph, the refused-arms list, the corrected "stored rows are checked" sentence, the new Limitations bullet) and the pending release note match the code. `docs/internals.md` does not describe the ALTER hook and needs nothing.
- Tests: the classification cases pin the specification's table on branching logic and the stack test pins the one non-obvious rule; the arm specs cover each use case in the handoff. None restate the implementation; none cut.

**Fixed in this pass**
- *Latent defect:* an adopted or undone change recorded the table as `written` in the batch, so a failed end-of-batch catalog commit would mark the table unpersisted and its next touch would re-persist this machine's (after an engine-only undo, older) description over the record. `underBatchCheckpoint` now takes an optional `staged` predicate, and `alterCatalogOnly` records `written` only for an owned change or when it ran the instance's first initialize (which can stage a write). New `OptimysticVirtualTable.initialized` getter for that. No test: the specs have no way to make the catalog commit fail. Updated the "second, narrower path" paragraph of `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record` — the path stays open through the tag listener, which still marks every table whose tags an apply touched.
- *DRY:* the case-insensitive "without the object named X" rule was written out in `withoutCheck` (module) and `withoutCheckConstraint` (schema-manager) beside `findNamed`; both now use one `withoutNamed` in `catalog-only-change.ts`.

**Tripwires parked**
- A direct (imperative, outside `apply schema`) `drop constraint` over a record whose CHECK another machine re-bodied is adopted, so the record keeps that CHECK and a restart brings it back — `NOTE:` on `classifyCheckChange`.

**Major / filed** — none new. The handoff's own gaps stand as filed: `bug-optimystic-stale-hydrated-table-rewrites-the-shared-catalog-record` (now `repro: verified`, with the ADD CHECK row-check trigger) and `bug-optimystic-failed-apply-on-a-second-machine-reverts-saved-tags`. The implementer suggested promoting the first ahead of `catalog-only-add-and-drop-column`, since ADD COLUMN of a NOT NULL column also reads rows before dispatch; that is a human triage call and is left in backlog.

**Not examined further** — RENAME COLUMN plus a CHECK drop in one apply (handoff gap; RENAME COLUMN persistence is its own backlog bug). File size of `optimystic-module.ts` (5364 lines, `wc -l`) is already tracked by `debt-optimystic-vtab-class-is-too-big-to-review`.
