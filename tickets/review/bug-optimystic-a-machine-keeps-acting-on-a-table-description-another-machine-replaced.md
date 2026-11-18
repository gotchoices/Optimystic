description: A machine that is already running used to keep its old description of a shared table after another machine changed it, so its writes could leave rows out of an index or break a rule it had not seen. Now a transaction that wrote under an out-of-date description is refused at commit with a schema error, the machine takes the new description, and the retried statement follows it. Review the implementation.
prereq: optimystic-an-update-keeps-values-of-columns-its-description-does-not-name
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/table-description-check.ts (new: `judgeTableDescriptions`, `StaleTableDescriptionError`, `followStaleDescriptions`), packages/quereus-plugin-optimystic/src/schema/description-difference.ts (new: `descriptionDifference`), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitTransaction`, `staleDescriptions`, `noteTableWrite`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`markDirtyTrees`, `buildDescriptionCheck`, `judgeDescription`, `writtenDescription`, `adoptCatalogEntry`, `handlesToKeep`, `forgetUnmaintainedTrees`, `releaseRegistrations`, `OptimysticModule.followCatalog`), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`readRecordsFresh`, `recordReader`, `CatalogRecordState`), packages/quereus-plugin-optimystic/test/stale-hydrated-table.spec.ts, packages/quereus-plugin-optimystic/test/commit-gate.ts (`commitPastIndexBuild`), docs/transactions.md, docs/internals.md, packages/quereus-plugin-optimystic/README.md
difficulty: hard
----

## What landed

Before any commit route runs (session, offline seal, legacy), `TransactionBridge.commitTransaction` judges every table the transaction staged into against one fresh read of the catalog (`judgeTableDescriptions`). Each table registers its check with the bridge from `markDirtyTrees` (`noteTableWrite`), kept and cleared with the dirty trees.

- **Compared** (`descriptionDifference`): the instance's description is `tableSchemaToStored(this.tableSchema)` with `indexes` replaced by the indexes its `IndexManager` maintains (descriptor and open tree). It is compared with the record in persisted, name-keyed form, names lower-cased, on: columns (tags, `declaredType` and `collationExplicit` stripped), primary key plus its conflict action, indexes (tags stripped), CHECKs, UNIQUE constraints and foreign keys. Lists compare as sets through `canonicalJson`. Tags, `with context`, `orphanedIndexes` and vtab args are not compared.
- **Verdicts:** an instance that owes its record is current. Absent (no live record and no gravestone) is `unknown`, and the commit proceeds. A live record that differs is `replaced`; a gravestone is `dropped`. Either refuses with `StaleTableDescriptionError` (`QuereusError`, `StatusCode.SCHEMA`, `tables: [{ table, kind, difference? }]`). It is exported from both entries, and `entry-identity.spec.ts` lists it.
- **Follow:** this runs after `afterFailedCommit` has rolled back, inside the same commit call (`followStaleDescriptions`, which logs failures and never throws). `OptimysticModule.followCatalog` handles the two verdicts:
  - **replaced:** the module rebuilds the engine entry with `storedToTableSchema(record, entry.vtabModule ?? module, entry.vtabAuxData, entry.vtabArgs)`, registers it with `schema.addTable`, and calls `table.adoptCatalogEntry(registered)`. It then announces `table_modified` with the registered object.
  - **dropped:** the module removes the instance from its map, calls `releaseRegistrations()`, removes the engine entry with `schema.removeTable`, and announces `table_removed`. Nothing is written to the catalog.
- **Cost:** `SchemaManager.readRecordsFresh` reads every table through one catalog handle per transactor, which it keeps open between commits (`recordReader`). That handle is only read through, never staged into. Measured with `countingTransactor` (scratch spec, since deleted):
  - On `local`, a warm insert went from 1 to 2 transactor `get`s with no index, and from 0 to 1 with an index.
  - On a two-node mock mesh, an insert costs 2 `get`s.
  - Before the handle was kept, it cost 4 extra `get`s per commit, because each check opened the catalog anew.
  - `two-node-write-request-count.spec.ts` counts cluster deliveries, which a read is not, so its count stays at 3 and was left unchanged. The docs say so.

## Deviations from the ticket (judge these)

- **Re-initialized in place instead of retiring the instance.** The ticket asked to retire the instance and let a new one be built. I kept the instance instead: `adoptCatalogEntry` swaps `tableSchema` to the registered entry and marks the instance uninitialized, and the next `doInitialize` rebuilds the codec and `IndexManager` from the record.
  - That pass reuses the instance's open collection handles (`handlesToKeep`: the main tree, plus index trees by name). It then calls `forgetTree` on any kept index tree the new description no longer maintains.
  - Why: a retired instance would lose the change subscription and network watch, the materialized-view follower's pending signals (`unfollowTable` drops them), the offline policy and the commit-report names. A new instance would also open new collection handles, and an offline-queued transaction's sealed segments live on the old ones, so queued rows would disappear from this machine's reads until they drained.
  - The teardown the ticket asked to factor exists anyway, as `releaseRegistrations()` (used by DROP, a refused CREATE, and the drop-follow). `teardownChangeSubscription`, `forgetInCommitReports` and `withdrawOfflinePolicy` are now private.
- **The skip on an unreachable catalog covers both offline-queue routes,** `local` and `behind-queue`, not just `local`. A behind-queue commit can end as a local acknowledgement on timeout, so throwing on an unreachable catalog there would turn that into a hard failure. Every other route lets the read's error propagate, and the commit then rolls back through `afterFailedCommit`.
- **The window note** (at `judgeTableDescriptions`, and in transactions.md): outside `apply schema`, `addIndex` writes the record before `backfillIndexTrees` reads the rows. That contradicts the backlog ticket's "build then record". I appended this, plus a verified reproduction, to `tickets/backlog/bug-optimystic-a-write-during-another-machines-index-build-can-miss-the-index.md`.

## Tests

New, in `test/stale-hydrated-table.spec.ts` (`describe('a write committed under a description the other machine replaced')`):
- **An index the other machine created** (A also changes a tag): B's insert is refused with `SCHEMA`. Neither the refusal nor the follow sends a pend or commit (`countingTransactor`, after `whenCatalogPersisted`, so the tag listener's no-op save is covered too). B's retry commits. A's `where a = 7` finds the row, B's does so through exactly one index scan (`countIndexScans`), and `verifyIndexes` on a third session is clean.
- **A CHECK added:** the insert of `a = 200` is refused with `SCHEMA`, and its retry fails with a `ConstraintError` naming `small`.
- **The table dropped:** the insert is refused. A third hydrated session has no table, and B's next attempt fails with the same message that third session gets.
- **A tag change only:** B's write commits, and the record keeps A's tags.

Changed, because they wrote under an out-of-date description and are now refused:
- `stale-hydrated-table.spec.ts`:
  - "keeps the value of a column it does not know…": the update is refused, then retried.
  - "indexes the column it asked for…": the insert is refused, then retried.
  - The two "after a refused commit" cases: the insert after the refresh is refused, then retried.
- `index-backfill-cost.spec.ts` "rows committed while detached…" and `index-maintenance-invariant.spec.ts` "re-attaching to an index backfills…": the detached row is now produced through the remaining window (`commitPastIndexBuild`: the writer's pend is parked after its check while the other session builds the index). This keeps the backfill coverage, and it reproduces the backlog bug.
- `distributed-transaction-validation.spec.ts` (real libp2p, runs in plain `yarn test`):
  - The table+index test retries once on `StaleTableDescriptionError` (`execUnderCurrentDescription`), because whether node 2 or 3 sees node 1's index at its check is timing-dependent.
  - The column-visibility test now declares the narrower table first and the wider one last, so the writer's description is the record's.

The no-false-refusal guarantee across every declaration feature rests on `hydrate-restores-declared-table.spec.ts`, which writes to a hydrated every-feature table. No new test was added for that.

## Validation run

- `yarn build`, `yarn typecheck`, eslint on every touched file, and `yarn lint:docs`: all clean.
- `yarn test` in `quereus-plugin-optimystic`: 1390 passing, 14 pending, 0 failing, smoke ok.
- Integration specs (`OPTIMYSTIC_INTEGRATION=1`): 6 passing.
- `packages/upgrade-check` `yarn test`: 323 passing.
- `yarn check:rn`: passed.
- Not run: `yarn test` of other workspaces, since only `upgrade-check` and `rn-bundle-check` depend on the plugin.

## Known gaps, for the reviewer to weigh

- **No dedicated session-mode test of the refusal.** The check runs before `commitSession`, and the rollback goes through `session.rollback()`, as any failed session commit does.
- **No test of a locally acknowledged transaction refused while the catalog is readable.** The unreachable-skip arm is exercised by the existing offline specs (seen as `commit:description-unchecked` under `DEBUG`), but nothing asserts it.
- **The follow runs inside Quereus's `commitOpenConnections`,** and announces `table_modified` / `table_removed` there. Quereus's materialized-view handling of those events over a followed table is untested.
- **The followed engine entry carries no statistics** (`NOTE:` at `followCatalog`).
- **`recordReaders` keeps one catalog handle per transactor for the manager's life, never evicted.** Its block cache grows with the catalog.
- **`forgetUnmaintainedTrees`** (an index another machine dropped, followed with kept handles) has no direct test.
- **A table instance whose `module` is not an `OptimysticModule`** would break `followCatalog`'s cast. Every instance is built by the module today.
- **The prereq's `RowCodec.encodeRow` carry-over** is now reachable only through the race window. Its SQL test was converted to the refuse-then-retry shape, and after the refresh B knows column `y`, so that test no longer exercises the carry-over. `test/row-codec.spec.ts` has no case for it either, so nothing pins it now. `commitPastIndexBuild`'s parking pattern, with an `add column` in place of the index build, would reach it.
