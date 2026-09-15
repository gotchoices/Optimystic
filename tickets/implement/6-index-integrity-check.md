description: Add a check that compares each secondary index against its table in both directions, so an index entry left pointing at a row that is gone, or at a value the row no longer holds, is reported instead of going unnoticed. Then make the shared test assertion use it, so every existing index test gains that detection.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/index-integrity.ts (new), packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/query-helpers.spec.ts, packages/quereus-plugin-optimystic/test/index-integrity-check.spec.ts (new), docs/debugging.md
difficulty: medium
----

## Why

Every secondary-index test in this package closes on `expectIndexAgreesWithScan` (`test/query-helpers.ts`, ~40 call sites across 10 specs). It scans the table, collects the values present in the indexed column, and checks that an index-routed lookup for each value returns the same rows. By construction it can only look up values the table still holds. An index entry left behind for a value no row has any more is never looked up, so it is never seen. That helper's own docstring admits this, while also claiming "orphaned entries left by an UPDATE" as part of what it catches.

It is worse than a missed lookup. Even an orphan whose value IS still looked up is invisible to the helper. `executeIndexScan` (`src/optimystic-module.ts`, the `NOTE:` above its `findByIndexIn` loop) fetches each entry's row by primary key and yields it. It skips an entry whose row is gone, and Quereus re-applies the predicate to a row whose value moved. So the lookup's row set still agrees with the scan, and the helper structurally cannot fail on any orphan.

Orphans are not hypothetical. A plan-stage probe (two-node mock mesh, index tree read directly) produced three, all persisting on both nodes. Details and output are in `fix/concurrent-row-changes-leave-orphaned-index-entries`.

## Design

### One formula for an index entry's tree key

An index tree entry is `[treeKey, primaryKey]`, where `treeKey = indexKey ‖ primaryKey`: `indexKey` comes from `IndexManager.createIndexKey(descriptor, row)` and `primaryKey` from `RowCodec.extractPrimaryKey(row)`. The concatenation is currently spelled inline at five sites: `insertIndexEntries`, `deleteIndexEntries` and `updateIndexEntries` in `index-manager.ts`; `backfillIndexTrees` (~line 2948); and the unique-tree populate (~line 1904) in `optimystic-module.ts`.

Add `export function indexEntryKey(indexKey: IndexKey, primaryKey: PrimaryKey): string` to `index-manager.ts` and route all five sites through it, plus the new check. The file's own doctrine is that index keys come from one definition, not hand-kept copies (see `indexKeyFromValues`). A check that recomputed the key its own way could agree with itself while disagreeing with maintenance.

### Pure comparison — `src/schema/index-integrity.ts` (new)

Keep the logic out of the 4,300-line vtab class (see backlog `debt-optimystic-vtab-class-is-too-big-to-review`). A pure function takes the rows and entries and returns a report. It performs no I/O, so it can be unit-tested without trees if wanted.

```ts
export type IndexKind = 'declared' | 'unique-enforcement';

export interface MissingIndexEntry {
  /** The tree key the row's values imply, absent from the tree. */
  expectedTreeKey: string;
  primaryKey: string;
  row: Row;
}

export type OrphanReason =
  | 'no-row'        // the entry's primary key resolves to no row
  | 'stale-value'   // it resolves to a row whose values imply a DIFFERENT tree key
  | 'malformed';    // the entry's stored primary key is not the suffix of its own tree key

export interface OrphanedIndexEntry {
  treeKey: string;
  primaryKey: string;           // the entry's stored value, entry[1]
  reason: OrphanReason;
  /** Decoded (splitKeyTuple) payloads: the first index.columns.length elements of the tree
   *  key, then the primary-key elements — enough for a message or a test to name the entry
   *  by value and id without re-implementing the key encoding. */
  indexPayloads: (string | null)[];
  primaryKeyPayloads: (string | null)[];
  /** The row the primary key resolves to, for 'stale-value'. */
  currentRow?: Row;
}

export interface IndexIntegrityReport {
  table: string;
  index: string;
  kind: IndexKind;
  rowCount: number;
  entryCount: number;
  missing: MissingIndexEntry[];
  orphaned: OrphanedIndexEntry[];
}
```

The comparison is a two-way set difference over tree keys. The expected set is `{ indexEntryKey(createIndexKey(index,row), pk(row)) }` over every row; the actual set is every valid entry's key. Entries in expected but not actual are `missing`. Entries in actual but not expected are orphans, classified by looking up `entry[1]` in the row map. An entry whose key IS expected but whose stored `entry[1]` differs from that row's primary key is `malformed`.

### Production entry points

- `OptimysticVirtualTable.verifyIndexes(): Promise<IndexIntegrityReport[]>`: one report per index in `IndexManager.getAllMaintainedIndexes()`. That covers declared indexes (`kind: 'declared'`) AND synthesized unique-enforcement trees (`kind: 'unique-enforcement'`); an orphan in a unique tree occupies a value prefix, so it matters most there. Read source is the **live** trees: `update()` the main collection and each index tree, then scan the main collection the way `backfillIndexTrees` does (`collection.ascending(first())`, `decodeRow`, `extractPrimaryKey`). Then range-scan each index tree over the full range. This is the view a live seek descends; the live query arm also `update()`s both trees immediately before scanning. Snapshot-pinned committed state is not the target: the downstream report concerns what one node's own seek sees, and `blocked/secondary-index-repro-exhausted-upstream` records one collection id with two lineages, where a fresh `Tree` could see a different lineage than the instance the vtab holds.
- `OptimysticModule.verifyIndexes(db: Database, tableName: string, schemaName = 'main')`: resolves the table through `resolveConnectedTable(db, schemaName, tableName, false)` (the same path `connect` uses, so a hydrated-but-untouched table initializes) and delegates. It throws the existing "table definition not found" error for an unknown table.
- `plugin.ts`: expose `verifyIndexes: (db, table, schema?) => optimysticModule.verifyIndexes(db, table, schema)` beside `hydrate`, with a doc comment. `src/index.ts`: export the report types.

Why a production method rather than a test-only reach-into-private-fields helper:
- It keeps the key format inside the module that owns it.
- A downstream host can call it on the machine that misbehaves. That is exactly the evidence the blocked downstream investigation lacks.
- The `NOTE:`s on `reconcileMaintainedIndexes` and `hasNoRowsToBackfill` already anticipate "an explicit repair entry point" for orphans, and a check is the first half of that.

Repair is **not** in scope. Say so in the method's doc comment.

### Test helper — `test/query-helpers.ts`

- `readIndexIntegrity(db, table)`: find the module with `db.schemaManager.getModule('optimystic')?.module`, check it is an `OptimysticModule` (imported from `../dist/index.js`), call `verifyIndexes`. Throw a clear error if the module is not registered.
- `expectIndexesIntact(db, table)`: fail if any report has a missing or orphaned entry. The message names the table, index, kind, each discrepancy's reason, decoded index payloads, primary-key payloads, and the current row for `stale-value`, plus the row and entry counts. Use one stable phrase such as `index entries must correspond one-to-one with rows` so self-tests can match it.
- `expectIndexAgreesWithScan(db, table, column)`: call `expectIndexesIntact(db, table)` **first**, before the existing `if (scanned.length === 0) return;` early return. A table emptied by DELETEs is exactly where a no-row orphan lives, and the early return would skip it. Keep the seek arm unchanged: it still proves the lookup routes through the index and that the read path agrees. Rewrite the docstring to claim what the result covers: both directions for every maintained index of the table, plus routing and read-path agreement for the column's index. Drop the paragraph that says the companion check "does not exist yet", and the reference to this ticket's old slug.

Signatures of existing helpers do not change, so all ~40 existing call sites gain orphan detection with no edits.

### If strengthening the oracle turns an existing caller red

The plan-stage probe covered only two-node racing shapes, so the prediction is that every existing caller stays green. They are all sequential, single-writer or insert-only. If one goes red anyway, it has found a real, verified orphan producer. Do **not** weaken the oracle, skip the test, or drop the call. Instead:
1. Confirm the discrepancy the report names.
2. Append it as an arm to `fix/concurrent-row-changes-leave-orphaned-index-entries` if it is the same root cause (an index delta replaying independently of its row), or file a new `fix/` ticket with `repro: verified` if not.
3. Replace that one call with an explicit assertion of the exact discrepancy the report shows, carrying a `NOTE:` that names the ticket, so the test flips red when the defect is fixed.

Say so in the review handoff.

## Edge cases & interactions

- **Emptied table**: every row deleted, orphan entries remain. Must report and fail. Guards the early-return ordering above.
- **Never-committed index tree**: `CREATE INDEX` on an empty table in a session that has not flushed, so the tree was invented locally. `update()` and range scan must yield zero entries without throwing, giving a clean report with counts 0/0.
- **NULL indexed value**: framed with the bare NULL tag. It must round-trip as expected with no false orphan, and `indexPayloads` shows `null`.
- **Numeric column, bigint vs number**: the key comes from `createIndexKey` over the DECODED row, the same as backfill and UPDATE/DELETE maintenance. `serializeIndexValue` unifies `5n` and `5`.
- **Composite index and composite primary key**: payload splitting must place the boundary at `index.columns.length`. A multi-column index on a multi-column-PK table needs a clean case and one orphan case.
- **Several rows sharing one indexed value**: an orphan for one primary key must not mask, or be masked by, a live sibling entry under the same value prefix.
- **Unique-enforcement tree** (`col unique` with no declared index): reported with `kind: 'unique-enforcement'` under its synthesized name (`uniqueEnforcementTreeName`), and checked like any other.
- **Open transaction**: the live trees include this connection's staged writes. Row and index halves are staged together, so a clean table stays clean mid-transaction. Test `begin; insert; verify → clean; rollback; verify → clean`. Document that the check is not snapshot-pinned.
- **Partial-index predicate**: maintenance ignores `predicate` (the `NOTE:` on `backfillIndexTrees`), so the check must ignore it too, or it would report every excluded row as missing. Put a `NOTE:` at the comparison saying the two must change together.
- **Catalog index the manager does not maintain**: out of scope for the check. The seek arm of `expectIndexAgreesWithScan` already hits the plan-time `assertIndexMaintained` guard, so do not duplicate it.
- **Unknown table name**: throws; does not return an empty report list.
- **Prototype patches in self-tests** must be undone in `finally`, or they leak onto every later spec sharing the prototype. Use the same discipline as `dropOneEntryPerIndexScan`.
- **Memory**: the check holds every row's expected key in memory. Add a tripwire `NOTE:` saying that if it is ever run on large tables, the comparison should stream per index (for example, sort the expected keys and merge against the tree's ascending scan).

## Key tests

`test/index-integrity-check.spec.ts` (new, single-node, `default_transactor: 'test'`). Produce discrepancies deterministically by patching the `IndexManager` prototype, reached through a live instance: `module.tables.get('main.<t>').indexManager` → `Object.getPrototypeOf(...)`. Restore in `finally`. These are synthetic on purpose: the real producers are defects that will be fixed, and an oracle's self-test must not depend on a bug surviving.
- A clean table with shared values, a NULL value and a numeric column: every report has empty `missing` and `orphaned`, and `entryCount === rowCount`.
- `insertIndexEntries` patched to a no-op, then insert: exactly one `missing` entry naming that row.
- `deleteIndexEntries` patched to a no-op, then delete: exactly one orphan, `reason: 'no-row'`.
- `updateIndexEntries` patched to a no-op, then change the indexed value: one orphan `'stale-value'` whose `currentRow` carries the new value, plus one `missing` for the new value.
- Delete every row with deletes patched out: orphans reported on an empty table.
- Composite index over a composite primary key: clean, then one orphan with correctly split payloads.
- A `unique` column with no declared index: a report with `kind: 'unique-enforcement'`.
- Mid-transaction clean, then rollback clean.
- Unknown table throws.

`test/query-helpers.spec.ts` additions:
- Fails with the one-to-one message when an index holds a `stale-value` orphan whose old value no row holds any more. Also assert that the old seek arm alone would have passed; for example, the failure message does not contain `the index-routed row set must equal`.
- Fails on an emptied table carrying a `no-row` orphan, which pins the early-return ordering.
- The existing four cases stay green and unchanged.

## TODO

- Add `indexEntryKey` to `index-manager.ts`; route insert, delete, update, backfill and the unique populate through it. Existing specs must stay green, with no behaviour change.
- Create `src/schema/index-integrity.ts`: report types plus the pure comparison.
- Add `OptimysticVirtualTable.verifyIndexes`, `OptimysticModule.verifyIndexes`, `plugin.verifyIndexes`; export the types from `src/index.ts`.
- Add `readIndexIntegrity` and `expectIndexesIntact` to `test/query-helpers.ts`; wire `expectIndexAgreesWithScan` to run the structural arm before its early return; rewrite its docstring.
- Write `test/index-integrity-check.spec.ts` and the `query-helpers.spec.ts` additions listed above.
- Update the `NOTE:` beside the `keepExisting` guard in the vtab's `update` method (it cites this ticket's old slug `6-debt-index-sweep-misses-update-delete-and-orphans`). It should cite `concurrent-row-changes-leave-orphaned-index-entries` instead.
- Add a short subsection to `docs/debugging.md`, "Does an index agree with its table?", saying what `plugin.verifyIndexes` reports and what each orphan reason means.
- Build (`yarn workspace @optimystic/quereus-plugin-optimystic build`; the test runner refuses a stale `dist`, including a stale upstream `@optimystic/db-p2p`, which it names along with the rebuild command) and run the full package suite in the foreground. If an existing caller goes red, follow the protocol above. Report the suite's wall-clock before and after in the handoff: the structural arm adds a scan per helper call.
