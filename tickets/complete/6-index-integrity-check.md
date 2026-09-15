description: Added a check that compares each secondary index against its table in both directions, so an index entry left pointing at a row that is gone, or at a value the row no longer holds, is reported instead of going unnoticed; every existing index test now runs it through the shared assertion.
files: packages/quereus-plugin-optimystic/src/schema/index-integrity.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/query-helpers.spec.ts, packages/quereus-plugin-optimystic/test/index-integrity-check.spec.ts, packages/quereus-plugin-optimystic/test/index-staging-patch.ts, docs/debugging.md
difficulty: medium
----

## What landed

**One formula for an index entry's tree key.** `indexEntryKey(indexKey, primaryKey)` in `src/schema/index-manager.ts` is the only place the key `indexKey ‖ primaryKey` is spelled. Every site routes through it: insert, delete and update staging, `backfillIndexTrees`, `ensureUniquePopulated` and the new check. The row walk that backfill and the unique populate each wrote inline is now one generator, `walkDecodedRows` in `src/optimystic-module.ts`, and the check shares it. `hasNullIndexValue` is the shared "row holds NULL in an indexed column" predicate.

**The comparison is a pure function.** `compareIndexToRows` in `src/schema/index-integrity.ts` takes one index, every row (keyed by framed primary key) and every tree entry. It returns an `IndexIntegrityReport`:
- `missing` lists rows whose implied tree key the tree lacks.
- `orphaned` lists entries no row implies, each with a `reason`:
  - `no-row`: no row has that primary key.
  - `stale-value`: the row exists but its values imply a different key; `currentRow` is attached.
  - `malformed`: the stored primary key is not its own tree key's primary-key half.
- Every discrepancy carries the decoded `indexPayloads` and `primaryKeyPayloads`.

A NULL-bearing row's entry in a unique-enforcement tree is optional: live writes stage one, but the one-time populate for rows an older build wrote does not. The function carries `NOTE:`s on the ignored partial-index predicate and on memory use for large tables.

**Entry points.**
- `OptimysticVirtualTable.verifyIndexes()` reads the live trees: it refreshes the main collection and each index tree, walks the rows, then scans each tree whole via `IndexManager.allEntriesIn`.
- `OptimysticModule.verifyIndexes(db, table, schema = 'main')` resolves the table the way `connect` does. It refuses a catalog table another module owns.
- `plugin.verifyIndexes(db, table, schema?)` is the public form. The report types are exported from `src/index.ts`.
- The check is detection only; it repairs nothing.

**Test oracle** (`test/query-helpers.ts`).
- `readIndexIntegrity(db, table)` returns the reports.
- `expectIndexesIntact(db, table)` fails with `index entries must correspond one-to-one with rows` plus one block per bad index.
- `expectIndexAgreesWithScan` runs that structural check first, before its empty-table early return. All existing callers gained orphan detection unchanged, and none went red.

**Docs.** `docs/debugging.md` has a new section, "Does an index agree with its table?". The `keepExisting` `NOTE:` in the vtab's `update` now cites `refuse-concurrent-row-change-loser`.

Test support: `test/index-staging-patch.ts` swaps one `IndexManager` staging method for one statement and restores it in `finally`, to leave an exact, known discrepancy.

## Review findings

**Read first:** the implement diff (`6897710c`), then the handoff.

**Correctness, checked and sound:**
- The five converted staging sites produce the same bytes as the old inline concatenation.
- `walkDecodedRows` is statement-for-statement the two loops it replaced.
- The staging-method signatures `stageNewEntryOnly` destructures match `IndexManager`.
- `splitKeyTuple` (`src/schema/key-encoding.ts`) never throws and tolerates truncated or mis-tagged elements, and `encodeKeyTuple` is canonical. So a badly framed key comes back as `malformed` rather than crashing the check, and a well-framed key re-encodes exactly.
- The NULL exemption applies only to `unique-enforcement` trees, which matches `ensureUniquePopulated`. Declared indexes get entries for NULL rows on every path.
- The foreign-module guard in `OptimysticModule.verifyIndexes` holds.
- `resolveConnectedTable`'s connection registration for a newly built table is the same one `connect` does.

**Found and fixed in this pass:**
- **Undocumented behavior.** A malformed entry sitting at a row's own tree key hides that row from lookups, yet it counts as present, so it is reported once as `malformed` and not also as `missing`. Now documented on `OrphanReason` in `index-integrity.ts` and in the `debugging.md` reason table, and pinned by a new test.
- **Plan edge case with no test.** The plan listed an index tree that has never been written as an edge case, and nothing tested it. Added a test: a table with no indexes returns no reports, and an index declared over an empty table reports clean with counts 0/0. The same test resolves the table name in lower case, pinning case-insensitive lookup.
- **Duplicated reach into the module.** The malformed test and `index-staging-patch.ts` each reached into the module's private table cache with their own inline casts. Extracted `liveIndexManager(plugin, table)` in `index-staging-patch.ts`; both now use it, and the spec gained a small `stageRawEntry` helper.
- **Stale pointer in a downstream ticket.** `implement/6.3-refuse-concurrent-row-change-loser` told its implementer to delete the `keepExisting` NOTE "that cites `6-debt-index-sweep-misses-update-delete-and-orphans`". This change rewrote that NOTE, so searching for the old slug would find nothing. Corrected the ticket text.

**Checked, no change:**
- **Deviations from the plan.** The implementer changed three things; all are justified and consistent with the code:
  - the NULL exemption in unique-enforcement trees (the plan said to check them like any other tree);
  - the stricter malformed test (it re-encodes the index half rather than testing a suffix);
  - the NOTE citing `refuse-concurrent-row-change-loser` instead of the consumed `concurrent-row-changes-leave-orphaned-index-entries`.
- **Row walk left as is.** `scanUniqueConstraint` (`optimystic-module.ts`, the defensive full-scan fallback) still walks rows inline. It skips excluded keys on the raw stored key *before* decoding, so moving it to `walkDecodedRows` would decode rows it discards. It is a fallback that should never run.
- **Docs verified against code:**
  - `_uniq_5.email` matches `uniqueEnforcementTreeName`.
  - The `5.000000000000000e+0` index payload matches `serializeIndexValue`.
  - The `debugging.md` claims match `verifyIndexes`.
  - AGENTS.md does not describe the helper, so it needed no edit.
  - The "explicit repair entry point" NOTEs on `reconcileMaintainedIndexes` and `hasNoRowsToBackfill` are still accurate, because this check does not repair.
- **Old-slug comments** in `test/two-node-shared-index-key.spec.ts` and `test/two-node-index-interleaving-sweep.spec.ts`. They are owned by `implement/6.1-two-node-index-mutation-sweep`, which lists both sites and says a search of `packages/` for the old slug must come back empty when it is done. Left.
- **Resource cleanup.** Prototype patches restore in `finally`. The check opens nothing it does not already share with `connect`.
- **Error handling.** An unknown table, a table owned by another module, and an index with no tree all throw, never return an empty list. The first two are tested.
- **Type safety.** The only casts are in test code reaching private module state, now confined to one helper.
- **Source size.** `optimystic-module.ts` grew by about 90 lines, which is the vtab method and the shared walk. The comparison itself was kept in its own file. The oversized class is already tracked by `backlog/debt-optimystic-vtab-class-is-too-big-to-review`, so nothing new was filed.

**Observed, not filed:**
- Five specs each keep a small "count valid entries in a tree" helper: `index-maintenance-invariant`, `index-backfill-cost`, `legacy-commit-atomicity`, `deferred-constraint-rollback` and `session-mode-commit`. That duplication predates this change. Specs cannot reach `IndexManager.allEntriesIn`, since the package ships as one bundle without that class, and each copy is four lines. Not worth a ticket.

**Tripwires.** None new. The existing `NOTE:`s on `compareIndexToRows` cover the two conditional concerns: partial-index predicates, and memory on large tables.

**Known gaps, carried from the handoff:**
- `verifyIndexes` is not tested directly in session (coordinator) commit mode. `refuse-concurrent-row-change-loser` requires a session-mode test that closes on the oracle, which will exercise it.
- `compareIndexToRows` has no tree-free unit test; its branches are all reached through `verifyIndexes`.

**Validation:**
- Package `typecheck`, `yarn lint` and `yarn lint:docs` are clean.
- `test/index-integrity-check.spec.ts` plus `test/query-helpers.spec.ts`: 20 passing.
- Full package suite (`yarn workspace @optimystic/quereus-plugin-optimystic test`): 816 passing, 13 pending, 0 failing, in about 2 minutes. That is the handoff's 814 plus the two new tests.
