description: Deleting a row from an Optimystic table now reports the row it removed, so `on delete cascade` and the other foreign-key actions, `returning` and change events behave as they do on a Quereus memory table.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (the `case 'delete'` arm of `update`, `removedEarlierInTransaction`, and the note beside its DML catch), packages/quereus-plugin-optimystic/test/delete-reports-removed-row.spec.ts, packages/quereus-plugin-optimystic/README.md (known limitations, the pre-write row bullet), docs/internals.md (§Conflict replay re-makes the uniqueness decision)
----

## What was built

- The `case 'delete'` arm of `update` returns `{ status: 'ok', row: oldRow }`. `processDeleteRow` in `@quereus/quereus/src/runtime/emit/dml-executor.ts` returns as soon as `row` is missing, which skipped foreign-key actions, change tracking, the data event and `returning`. The five other `{ status: 'ok' }` sites are conflicts resolved as IGNORE and stay without a row.
- Added in review: a delete whose row this transaction's delete arm already removed answers `ok` with no row (`removedEarlierInTransaction`). A self-referencing cascade can remove a row the source scan has already yielded for the same statement. Any other miss still fails with `could not find the pre-write row`.
- The note beside the DML catch is a `NOTE:` accepted tradeoff: a delete a rival already applied at initial staging still reports the row and runs the engine's steps. Revisit if a client needs to know that its own delete removed the row.
- docs/internals.md records both behaviours, and that racing parent deletes commit twice under `on delete cascade` but refuse the second writer under `on delete set null`, because a cascade's child update has no write description and carries plain `unchanged`.

## Tests (`test/delete-reports-removed-row.spec.ts`)

Each of the first six runs on a memory table and on Optimystic and expects the same result: cascade, set null, `returning`, one data event per row removed, a delete selecting both ends of a self-referencing cascade, and restrict. The seventh runs on Optimystic only, with two handles over one directory: racing parent deletes under `on delete cascade` both commit, both `returning` give the row, and no rows remain.

## Review findings

**Checked, reading the diff first:** the delete arm against `processDeleteRow` and the `update` contract in `@quereus/quereus/src/vtab/table.ts`; the other `{ status: 'ok' }` sites; lane and commit-outlook handling of a cascade's undescribed child writes; the plugin README and docs/internals.md.

**Major, fixed here: the change introduced a regression.** A delete that selects both a parent and its child through a self-referencing cascade worked before this ticket, because no cascade ran. With the row returned, the parent's cascade removed the child, then the main loop reached the child and `requirePreWriteRow` threw `could not find the pre-write row`, rolling the whole statement back. Reproduced with `delete from T` and `delete from T where id in (1, 2)`; the memory table succeeded on both. The ticket's measurements named only one row, so they did not reach it.

My first fix answered "not found" on every delete miss, and I withdrew it before running it. The plugin README says that failure exists partly to catch a transient read miss on a networked transactor, and answering "not found" there would lose the delete silently. So the delete arm records the keys it removed per open transaction, and treats a miss as "not found" only for those keys. The pinned throw in `test/oldkeyvalues-compact-shape.spec.ts` is unchanged. A key put back later in the transaction reads as present and is deleted as usual, and a key left stale by a savepoint rollback only matters on a miss. Added one regression case per backend, and updated the README bullet and docs/internals.md.

**Measured against a memory table in a throwaway spec, now deleted, with the same result on both after the fix:**

- self-referencing cascade over a whole table, with the child scanned first and with the parent scanned first
- self-referencing set null over a whole table
- a diamond of cascades
- 40 parents with 80 children under an indexed foreign key
- self-referencing restrict, refused with both rows kept
- cascade undone by `rollback to` a savepoint
- delete, re-insert, then delete of one key in one transaction
- self-referencing cascade with a secondary index, where a lookup and a later re-insert agree

`update` with a self-referencing `on update cascade` was refused the same way on both. `update or replace` could not be measured because Quereus rejects that syntax.

**Lanes and outlook: no change needed.** `laneOf` in `src/optimystic-adapter/lane.ts` and `noteWriteDescription` in `src/optimystic-adapter/txn-bridge.ts` already treat a write with no description as `serializable` and as an incomplete outlook, and a parent delete is `serializable` anyway. That path was already written for cascades; this fix makes a plain parent delete reach it.

**Tests under review:** none cut. Running each case on a memory table is what the ticket asked for, and it is what exposes a difference between the two. The racing case pins a decision of this ticket.

**Not measured, recorded and not ticketed:**

- A member re-executing a replicated transaction may see a cascade twice, once from the parent statement and once from the child's own recorded statement. I did not confirm that child statements are recorded or measure the effect. It only matters if a deployment supplies a transaction checker, and none does (backlog `feat-no-deployment-validates-transactions-at-pend`).
- The implementer's measurements of session mode, offline mode, set default and reopen used a throwaway wrapper and were not repeated against the final code. Their handoff said so. Rollback was re-measured above through a savepoint.

**Tripwires parked:** none new. The removed-key set costs one string per deleted row until the transaction ends, far less than the staged delete it sits beside, so it needs no note.

**Accepted tradeoff, left as decided:** `returning` and the data event can report a row a rival removed first (the `NOTE:` beside the DML catch).

**Validation:**

- Plugin `yarn test`: 1296 passing, 14 pending, 0 failing, and the smoke check passed.
- The first full run, before the review fix, had one failure: `should match the installed @quereus/quereus version` could not find the sibling's `dist/src/index.js`. The file was present when I checked afterwards and the test passed on the final run. Most likely the sibling Quereus repository was being rebuilt at that moment, though I did not confirm it. It does not touch this ticket's code and did not recur, so I did not report it as pre-existing.
- Plugin `yarn typecheck` printed no errors, root `yarn lint:docs` passed, and eslint passed on the changed source file and spec (the repo-wide `yarn lint` was not run).
- `OPTIMYSTIC_SKIP_BUILD_CHECK` was not used. `yarn test:integration` was not run.
