description: Deleting a row from an Optimystic table now reports the row it removed, so `on delete cascade` and the other foreign-key actions, `returning` and change events behave as they do on a Quereus memory table.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (the `case 'delete'` arm of `update`, and the note beside its DML catch), packages/quereus-plugin-optimystic/test/delete-reports-removed-row.spec.ts, docs/internals.md (§Conflict replay re-makes the uniqueness decision)
----

## What changed

- The `case 'delete'` arm of `update` returns `{ status: 'ok', row: oldRow }`. `processDeleteRow` in `@quereus/quereus/src/runtime/emit/dml-executor.ts` returns as soon as `row` is missing, which skipped foreign-key actions, change tracking, the data event and `returning`. The five other `{ status: 'ok' }` sites are conflicts resolved as IGNORE and stay without a row.
- The note beside the DML catch is now a `NOTE:` accepted tradeoff: a delete a rival already applied at initial staging still reports the row and runs the engine's steps. Revisit if a client needs to know that its own delete removed the row.
- docs/internals.md §Conflict replay re-makes the uniqueness decision says the same, and records that racing parent deletes commit twice under `on delete cascade` but refuse the second writer under `on delete set null`, because a cascade's child update has no write description and carries plain `unchanged`.

## Tests added (`test/delete-reports-removed-row.spec.ts`)

Each of the first five runs on a memory table and on Optimystic and expects the same result.

- `on delete cascade` removes the child.
- `on delete set null` clears the reference.
- `returning` gives the removed row.
- One data event per row removed, the child included.
- `on delete restrict` refuses the delete and keeps both rows.
- Optimystic only, two handles over one directory: racing parent deletes under `on delete cascade` both commit, both `returning` give the row, and no rows remain.

Before the fix, the spec's run numbered six failures. My captured output was cut off, so I read only failures 3 to 6: set null, `returning`, the data event and restrict on Optimystic. Failures 1 and 2 are presumably the racing case and the Optimystic cascade, since the six memory-independent cases are the only ones expected to fail, but I did not read them. All 11 cases pass with the fix.

## Validation

- Plugin `yarn test`: 1294 passing, 14 pending, 0 failing, and the smoke check passed. The plugin `yarn typecheck` printed no errors, and root `yarn lint:docs` passed.
- `OPTIMYSTIC_SKIP_BUILD_CHECK` was not used.

## Differences from the ticket

- The sibling Quereus change the ticket described as uncommitted is now committed at its HEAD (2ab156735): restricted keys are collected after the `result.row` check. So the restrict case fails without this fix on the current build, rather than only on a future one, and the test's comment says so. It was not re-run against an older engine.
- The ticket's measurements for session mode, offline mode, set default, self-referencing cascades, rollback and reopen were made with its throwaway wrapper. The ticket's TODO did not ask for tests on them, so none were added and they were not re-measured against the real change.
- The refusal under racing `on delete set null` is documented, not tested here.

## Worth checking

- `returning` and the data event can report a row a rival removed first. This is the accepted tradeoff above, decided in the ticket.
