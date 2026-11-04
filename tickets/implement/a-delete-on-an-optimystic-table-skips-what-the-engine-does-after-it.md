description: Deleting a row from an Optimystic table removes the row, but Quereus treats the row as not found, so `on delete cascade` never runs, child rows are left behind, and `returning` and change events report nothing. Make a delete report the row it removed, so it behaves as it does on a Quereus memory table.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (the `case 'delete'` arm of `update`, and the note beside its DML catch), docs/internals.md (§Conflict replay re-makes the uniqueness decision), new spec under packages/quereus-plugin-optimystic/test/, @quereus/quereus/src/runtime/emit/dml-executor.ts (`processDeleteRow`, read only), @quereus/quereus/src/vtab/table.ts (the `VirtualTable.update` contract, read only)
difficulty: easy
repro: verified
----

## Cause

The `case 'delete'` arm of `update` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` ends with `return { status: 'ok' }`. The `update` contract in `@quereus/quereus/src/vtab/table.ts` says the presence of `row` is how a module reports that a row was written or removed, and that a module must return it on a real write. `processDeleteRow` in `@quereus/quereus/src/runtime/emit/dml-executor.ts` returns as soon as `row` is missing, which skips:

- change tracking for watchers (`_recordDelete`)
- row-time structure maintenance
- foreign-key actions: cascade, set null and set default
- the automatic data event
- the row that `returning` projects

For a delete, the engine checks only whether `row` is present and never reads its contents.

## The fix

Return the row the arm already holds: `return { status: 'ok', row: oldRow }`.

`requirePreWriteRow` throws when no row exists, so by the time this arm returns it has always staged a delete. No case in this arm should answer without a row.

The other `return { status: 'ok' }` sites in `update` are correct and stay as they are. All five report a conflict resolved as IGNORE, one on each of these paths: insert at an occupied key, insert or replace meeting a secondary unique constraint, fresh insert, primary-key move, and update. The contract says to omit `row` for these.

## Measured

Each row below ran on a memory table, on Optimystic as it is, and on Optimystic with `update` wrapped in a throwaway spec so that a delete answering `ok` also returned a row. That wrapper did not change `src`; the spec and wrapper have been deleted. Setup: `pragma foreign_keys = true`, parent table and child table, one or two machines' handles over one directory.

| after deleting the parent row | memory | Optimystic now | Optimystic with a row returned |
|---|---|---|---|
| `on delete cascade` | child gone | child still there, naming a missing parent | child gone |
| `on delete set null` | `pid` null | `pid` still names the missing parent | `pid` null |
| `on delete set default` | default value | `pid` still names the missing parent | default value |
| `delete … returning` | the row | no rows | the row |
| `db.onDataChange` | 1 event per row, child included | none | 1 event per row, child included |
| cascade through a self-reference and into an indexed child | all gone | only the named row gone | all gone, and an index lookup agrees |
| `rollback` after a cascade | parent and child back | child was never removed | parent and child back |
| restrict below a cascade (statement refused) | nothing removed | nothing removed | nothing removed |
| cascade, then close and reopen | not applicable | child still there | both gone |
| cascade in session (coordinator) mode | not applicable | not run | both trees commit, and both stay gone on reopen |
| cascade in offline mode | not applicable | not run | entry queued over both tables, drains, both gone |

The whole plugin suite passes with that wrapper applied: 1306 passing, 0 failing, 14 pending, counting the 23 scratch cases, on the Quereus build described below. An earlier run on the build before that one gave 1304 passing, 0 failing. No existing spec relied on the old answer.

`Database.watch` wakes twice on Optimystic and once on a memory table. That is the redundant self-wakeup already accepted in docs/internals.md §Reactive Watch Bridge, so tests must not assert equal wake counts.

## A restrict that is about to stop working

The batched parent-side restrict check runs at the end of a statement, over keys collected during the row loop. When every foreign key pointing at a parent is `restrict` and not self-referencing, that check is the only enforcement (`getBatchableRestrictFks` in `@quereus/quereus/src/planner/building/foreign-key-builder.ts`).

- At the Quereus commit on disk (HEAD 25c7d0521), the keys are collected before `vtab.update`, so `restrict` is still refused on Optimystic today.
- Uncommitted work in the sibling Quereus checkout moves the collection to after the `result.row` check. On a build of that work, measured here, a restricted delete on an Optimystic parent is **not refused**, while the same case on a memory table is. That run stopped at the missing refusal, so the row's fate was not read back. The arm stages the delete regardless, so the expected result is a removed parent and a child left naming it; the new test should assert the row stays.

So this fix also keeps `restrict` working once that Quereus change lands. Returning the row gives the correct refusal on both builds.

## Decided: a delete a rival already applied also returns the row

The ticket left this open. On a mesh, `unchangedOrAbsent` can skip the delete at initial staging, because the tracker it scans fetched a rival's commit that the pre-write read had not seen. The arm still returns `row: oldRow`, and the engine's steps all run. Reasons:

- The same acceptance is more often met later, at commit-time replay, by which point the statement has already reported the row and run every step. Skipping only at initial staging would make the answer depend on timing, with nothing a client could use to tell the two apart.
- This statement did see the row. The source scan and `requirePreWriteRow` both found it.
- The rival's commit says nothing about the children. It may have run with foreign keys off, so skipping could leave orphans.
- The vtab cannot tell anyway: `collection.stage` does not report what its guard accepted, and plumbing that through would serve only the worse behaviour above.

The cost is that `returning` and the data event can report a row a rival removed first, which is the same over-report commit-time replay already makes. The final state is the statement's intent.

**Racing parent deletes**, measured with the row returned, two handles, both inside `begin` … `commit`:

- `on delete cascade`: both commit and no rows remain, because the child delete carries `unchangedOrAbsent` too.
- `on delete set null`: the second commit is refused with `ConcurrentModificationError` naming the child row. Both handles then show the first writer's outcome. A cascade's child update has no write description, so `rewriteGuard` gives it plain `unchanged`, even though the rival wrote an equal row. A sequential retry then affects no rows. This refusal is loud and safe, so leave it, and record it in the docs (TODO below).

Without the fix, both commits succeed and the child is left naming a missing parent.

## Testing notes

- Specs import `dist`, so rebuild the plugin after editing `src`: `yarn workspace @optimystic/quereus-plugin-optimystic build`.
- During this work another process was editing and rebuilding the sibling Quereus repository, so `register.mjs` refused some runs as a stale build, and the engine build changed between runs. Do not rebuild or change that repository from this ticket. If it is still mid-edit, `OPTIMYSTIC_SKIP_BUILD_CHECK=1` runs against whatever is built there; say so in the handoff if you use it.
- `createDb` in `packages/quereus-plugin-optimystic/test/concurrent-row-change-refusal.spec.ts` shows the two-handles-over-one-`FileRawStorage` setup. Quereus columns default to not null, so a foreign-key column for set null needs `text null`.

## TODO

- Change the `case 'delete'` arm of `update` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` to return `row: oldRow`. Add a one-line comment that the engine skips its post-delete steps when `row` is absent.
- Reword the note beside the DML catch in the same file ("the statement returns ok for a row the sequential execution would not have found"). It should say the statement reports the row and the engine's steps run, and give the reason, as a `NOTE:` accepted tradeoff with the revisit condition: a client needing to know that its own delete removed the row.
- Add a spec under `packages/quereus-plugin-optimystic/test/` that runs the same cases on a memory table and on Optimystic and expects the same result: cascade, set null, `returning` and the data event (one event per row, child included), plus a restricted delete being refused. The restrict case passes without the fix on a Quereus build from HEAD, and fails without it on a build of the sibling's uncommitted work; note that in the test's comment. Confirm the other cases fail before the fix.
- Add one test on two handles over one directory: racing parent deletes under `on delete cascade` both commit and leave no rows, and `returning` gives the row on both.
- Update docs/internals.md §Conflict replay re-makes the uniqueness decision. In the paragraph after the guard table, the sentence on acceptance at initial staging should say the statement reports the row and runs the engine's steps. Add that a cascade's child update has no write description, so it carries plain `unchanged`, and racing parent deletes under `on delete set null` therefore refuse the second writer. Keep the existing claim that a cascade child delete carries `unchangedOrAbsent`, which is now reachable from a plain parent delete.
- Run `yarn test` in the plugin package and `yarn lint:docs` from the root.
