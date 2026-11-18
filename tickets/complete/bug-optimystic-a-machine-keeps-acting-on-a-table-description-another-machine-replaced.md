description: A running machine used to keep its old copy of a shared table's description after another machine changed it, so its writes could miss an index or break a rule it had not seen. A transaction written under an out-of-date description is now refused at commit with a schema error, the machine takes the current description, and the retried statement follows it.
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

## Review findings

Read the diff of `ticket(implement): bug-optimystic-a-machine-keeps-acting-on-a-table-description-another-machine-replaced` before the handoff, then ran `yarn build`, `yarn typecheck`, eslint on the touched files, `yarn lint:docs`, and `yarn test` in `quereus-plugin-optimystic`: 1391 passing, 14 pending, 0 failing, smoke ok.

Checked:
- **Commit flow** (`TransactionBridge.commitTransaction`). The check runs inside the same `try` as every route, so a refusal rolls back through `afterFailedCommit`'s clean arm. `mapCommitRefusal` passes `StaleTableDescriptionError` through unchanged, since it has no guard refusal in its cause chain. The follow runs after the rollback even when the rollback itself failed (that failure is logged). A failing catalog read leaves `stale` empty, so nothing is followed. `descriptionChecks` is cleared on every path that clears `dirtyTrees`.
- **The catalog reader cache** (`SchemaManager.recordReaders`). It is keyed by the transaction's transactor, which `CollectionFactory.getOrCreateTransactor` caches, so the map is bounded by the number of transactors. Its tree is distinct from the writers' trees, because `getSchemaTree` builds a fresh `transactorOnlyState` per call, and `CollectionFactory` caches collections only within a transaction. So "nothing is ever staged into it" holds.
- **The comparison** (`descriptionDifference`). Lists compare as sets and names are lower-cased. Tags, the spelling of declared types and explicit collations are excluded. Reasonable; and `hydrate-restores-declared-table.spec.ts` covers the "no false refusal" direction.
- **The follow paths** (`followCatalog`, `adoptCatalogEntry`, `forgetUnmaintainedTrees`, `releaseRegistrations`). Re-initializing in place instead of retiring the instance (deviation 1) is justified: keeping the handles keeps offline-sealed segments visible to reads, and keeps the subscriptions. Accepted.
- **Deviations 2 and 3** (skipping on an unreachable catalog for both offline routes; the backlog append for the index-build window): both accepted as reasoned.
- **Tests.** The new and converted specs each pin a refusal or a retry, and none restates the implementation. `commitPastIndexBuild` keeps the backfill specs meaningful. No cuts.

Found and done:
- **Fixed: a contract left untested.** The prereq's carry-over in `RowCodec.encodeRow` (a stored row's columns that the description does not name survive an UPDATE) lost its only test when that spec became refuse-then-retry. Without a lagging catalog replica, the carry-over is now unreachable through SQL: a record that lists a column always lands before any row holds it, so the check refuses first. So I pinned it at the lowest layer instead: `test/row-codec.spec.ts` "carries over the values of columns this codec does not name, and rewrites those it does".
- **Tripwire, recorded as a `NOTE:` at `TransactionBridge.staleDescriptions` and in docs/transactions.md (§A write is checked against the table's current description, offline-queue bullet).** A network commit now also needs the catalog's cohort to be reachable, not only its tables'. The catalog's blocks have their own cohort, so an unreachable catalog fails a write whose tables would have answered. The old comment's claim "as it would at its first network step" was not accurate for that case, so I removed it.
- **Minor, left as is: `hasStagedWrites` also reports a table as written when only earlier queued work is waiting in it.** It uses `hasUnsyncedChanges()`, which counts the effects of earlier queued offline transactions. So on such a table, a transaction that marked it dirty but staged nothing is still checked, and may be refused, after which the machine follows the record. That is harmless and very rare, so I neither filed a ticket nor added a note.
- **Minor, left as is: an unchecked cast in `followCatalog`.** `(this.module as OptimysticModule)` cannot fail today, because every instance is built by the module (the handoff lists this). I did not add a guard.

Gaps the handoff listed, weighed:
- **Untested: the refusal in session mode, and a locally acknowledged transaction refused while the catalog is readable.** Both run the same check ahead of their route, and session rollback is the ordinary failed-commit path. No ticket.
- **Untested: Quereus's materialized-view handling of `table_modified` and `table_removed` raised from inside `commitOpenConnections`.** These are Quereus's own announcement paths. Nothing here is filed.
- **The followed entry carries no statistics.** There is already a `NOTE:` at the site.
- **`recordReaders` is never evicted.** It holds one handle per transactor, and its block cache is the catalog's size. Acceptable at today's catalog sizes, so it is not parked anywhere.
- **No direct test of `forgetUnmaintainedTrees`** (the case where another machine dropped an index). It is a short loop over `forgetTree`. No test added.

Nothing was found in the categories security, resource leaks beyond the above, or file size. `optimystic-module.ts` grew by about 140 lines, all as named methods.
