description: Added a check that compares each secondary index against its table in both directions, so an index entry left pointing at a row that is gone, or at a value the row no longer holds, is reported instead of going unnoticed; every existing index test now runs it through the shared assertion.
files: packages/quereus-plugin-optimystic/src/schema/index-integrity.ts (new), packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/query-helpers.spec.ts, packages/quereus-plugin-optimystic/test/index-integrity-check.spec.ts (new), packages/quereus-plugin-optimystic/test/index-staging-patch.ts (new), docs/debugging.md
difficulty: medium
----

## What landed

**One formula for an index entry's tree key.** `indexEntryKey(indexKey, primaryKey)` in `src/schema/index-manager.ts`. Insert, delete and update staging, `backfillIndexTrees`, `ensureUniquePopulated` and the new check all route through it. The row walk that backfill and the unique populate each spelled inline is now one module-level generator, `walkDecodedRows` in `src/optimystic-module.ts`, which the check shares.

**The comparison is a pure function**, `compareIndexToRows` in `src/schema/index-integrity.ts`. It takes one index, every row (keyed by framed primary key) and every tree entry, and returns an `IndexIntegrityReport`:
- `missing`: rows whose implied tree key is absent from the tree.
- `orphaned`: entries no row implies, each with a `reason`.
  - `no-row`: the primary key matches no row.
  - `stale-value`: the row exists but implies a different key; `currentRow` is attached.
  - `malformed`: the stored primary key is not its own tree key's primary-key half.
- Both kinds carry `indexPayloads` and `primaryKeyPayloads`, the key decoded back into values.

The function has no I/O. It carries two `NOTE:`s, on the ignored partial-index predicate and on memory use for large tables.

**Entry points:**
- `OptimysticVirtualTable.verifyIndexes()` produces one report per `getAllMaintainedIndexes()` entry, with kind `declared` or `unique-enforcement`. It reads the live trees: `update()` main and each index tree, walk main, then scan each index tree over its whole key range through the new `IndexManager.allEntriesIn`.
- `OptimysticModule.verifyIndexes(db, table, schema = 'main')` resolves the table through `resolveConnectedTable`.
- `plugin.verifyIndexes(db, table, schema?)` is the public form.
- The report types are exported from `src/index.ts`.
- Nothing is repaired; the doc comments say so.

**Test oracle** (`test/query-helpers.ts`):
- `readIndexIntegrity(db, table)` returns the reports without asserting.
- `expectIndexesIntact(db, table)` fails with `<table>: index entries must correspond one-to-one with rows`, followed by one block per bad index: `<index> (<kind>): N rows, M entries`, then `orphaned (<reason>): value [...] pk [...]` and `missing: ...` lines.
- `expectIndexAgreesWithScan` calls it first, before the empty-table early return. Its docstring was rewritten.
- Helper signatures did not change, so all 34 existing call sites in 8 specs gained orphan detection with no edits.

**Docs.** Added `docs/debugging.md` §"Does an index agree with its table?". The `NOTE:` beside the `keepExisting` guard now cites `refuse-concurrent-row-change-loser`.

## Validation

- Build, `typecheck`, `yarn lint` and `yarn lint:docs` are all clean.
- **New and changed specs:** from `packages/quereus-plugin-optimystic`, run `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/index-integrity-check.spec.ts test/query-helpers.spec.ts --reporter spec --exit`. 18 passing.
- **Full package suite:** 814 passing, 13 pending, 0 failing (baseline was 800 / 13). **No existing caller went red**, so the red-caller protocol was not triggered.
- **Wall-clock:** 197 s before and 113 s after, back to back on one machine. The later run being faster means this pair is dominated by noise (the libp2p mesh specs) and does not isolate the new scan's cost. A better number: the heaviest caller, `two-node-index-interleaving-sweep.spec.ts` (150 tests, each closing on the oracle on both nodes), ran in 11 s with the new check, against about 12 s recorded in AGENTS.md.

Use cases pinned in `test/index-integrity-check.spec.ts`. Discrepancies are made on purpose with `withIndexStagingPatched` from `test/index-staging-patch.ts`, which patches one `IndexManager` staging method on its prototype and restores it in `finally`:
- **Clean table:** shared values, a NULL, a numeric column, and a BigInt-bound insert (`7n` staged, `7` decoded). Every report is empty and entries equal rows.
- **Insert staging skipped:** exactly one `missing` entry.
- **Delete staging skipped:** exactly one `no-row` orphan. The live sibling entry under the same value is not reported and does not mask it.
- **Update staging skipped:** one `stale-value` orphan with `currentRow`, plus one `missing` entry for the new value.
- **Every row deleted with delete staging skipped:** 0 rows, 4 entries, and four `no-row` orphans in tree-key order, the NULL one first.
- **Composite index over a composite primary key:** clean, then one orphan whose payloads split at the index width.
- **`unique` column with no declared index:** kind `unique-enforcement`, named by `uniqueEnforcementTreeName`, with an orphan detected.
- **`malformed`:** an entry staged straight into the tree with the wrong stored primary key.
- **Open transaction:** clean with the staged row counted, and clean again after rollback.
- **Refused tables:** an unknown table throws, and so does a `using memory` table.

`test/query-helpers.spec.ts` adds two cases:
- An update that adds the new entry but never removes the old one leaves a stale-value orphan for a value no row holds. The spec shows both lookups still return correct rows, and the oracle fails structurally, not with `the index-routed row set must equal`.
- An emptied table carrying `no-row` orphans fails, which pins the early-return ordering.

## Deviations from the plan, and calls the reviewer should check

- **NULL-bearing rows in unique-enforcement trees are exempt.** The plan said such a tree is "checked like any other", but the two maintenance paths disagree. Live DML stages an entry for a NULL-bearing row. `ensureUniquePopulated`, which fills the tree for rows an older build wrote, deliberately skips such rows. So an absent entry for a row with NULL in the tree's columns is not reported; a present one is still checked. The shared predicate is `hasNullIndexValue` in `index-manager.ts`, and `isEntryOptional` in `index-integrity.ts` applies it. The alternative, having the populate stage NULL rows too so the exemption can go, changes populate behaviour and was not taken.
- **`MissingIndexEntry` also carries decoded payloads** (the shared `DecodedIndexTreeKey`), so a failure message, or ticket `two-node-index-mutation-sweep`'s model, can name a missing entry by value.
- **`malformed` is stricter than a suffix test.** It re-frames the decoded index half and requires `treeKey === indexEntryKey(thatHalf, storedPk)`. That also catches a stored key that is only a trailing sub-tuple of a composite primary key.
- **`OptimysticModule.verifyIndexes` refuses a catalog table another module owns.** Without the guard, `lookupOrInstantiate` would build and cache an Optimystic instance over, say, a memory table. This was not in the plan.
- **The `keepExisting` NOTE cites `refuse-concurrent-row-change-loser`**, not `concurrent-row-changes-leave-orphaned-index-entries` as the plan said. The fix stage had already consumed that ticket into `tree-entry-unchanged-guard` and `refuse-concurrent-row-change-loser`. No file exists under the old slug, and `refuse-concurrent-row-change-loser` requires the old slug to be absent from `packages/` and deletes this NOTE anyway.
- **Behaviour to know:**
  - On a table not yet in this module's cache, the check registers a connection, exactly as `connect` does.
  - A unique-enforcement tree that has not yet been filled for an older build's rows reports those rows missing until the first write probes the constraint. This is documented in the vtab doc comment and in `docs/debugging.md`.

## Known gaps

- **Untested paths for the check itself:**
  - A table hydrated into a fresh `Database` over shared storage and not yet touched. The code path exists; there is no dedicated test.
  - Session (coordinator) commit mode.
  - Running on both nodes of a mesh. Only indirectly covered: the two-node specs call the oracle.
- **`compareIndexToRows` is not exported from the package** and has no tree-free unit test. Every branch (missing, the three orphan reasons, the optional exemption) is reached through `verifyIndexes`.
- **Old-slug references still to clean up.** `debt-index-sweep-misses-update-delete-and-orphans` still appears in comments in `test/two-node-shared-index-key.spec.ts` and `test/two-node-index-interleaving-sweep.spec.ts`. Ticket `two-node-index-mutation-sweep` owns those edits, so they were left.
- **For the downstream tickets** (`two-node-index-mutation-sweep`, `refuse-concurrent-row-change-loser`):
  - `readIndexIntegrity` is available.
  - Orphans come in ascending tree-key order; missing entries come in primary-key walk order.
  - A text value's index payload is the text itself; an integer's is its `toExponential(15)` form. An integer primary key's payload is plain digits (`'100'`).
