description: Fix orphaned secondary-index entries after committed UPDATE or DELETE by fetching the actual old row before staging, so index key computation uses the real old values rather than the PK-only snapshot the query engine passes.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
----

## What was done

### Root cause (as diagnosed in fix stage)
`UpdateArgs.oldKeyValues` is a PK-only compact array (length = number of PK columns, positionally keyed by PK order). `IndexManager.createIndexKey` reads `row[indexCol.index]` where `indexCol.index` is the column's position in the **full** table schema. For any non-PK indexed column (e.g. `cat` at schema position 1 on a single-INTEGER-PK table), `oldKeyValues[1]` is `undefined` → index key becomes `'\x01\x00<pk>'` (NULL marker), which never matches the real entry → delete-of-old-entry is a no-op → orphan survives.

### Fix applied (`optimystic-module.ts`)

Three call sites in `OptimysticVirtualTable.update()`:

1. **UPDATE (simple + key-change path, non-collision)**: Added a `collection.get(oldKey)` fetch + `rowCodec.decodeRow()` immediately after computing `oldKey`/`newKey`/`encodedRow`, before the `if (oldKey !== newKey)` staging block. The decoded full row replaces `oldKeyValues` in the final `updateIndexEntries(oldRow, ...)` call.

2. **UPDATE OR REPLACE collision path**: Same `oldRow` variable (computed above) now replaces `oldKeyValues` in the `updateIndexEntries(oldRow, ...)` call inside the REPLACE branch. The displaced-row `deleteIndexEntries(existingRow, ...)` already used the correctly-decoded `existingRow` and was not changed.

3. **DELETE path**: Added `collection.get(deleteKey)` + `rowCodec.decodeRow()` immediately after computing `deleteKey`, before `markDirtyTrees()` and `collection.stage(...)`. The decoded full row replaces `oldKeyValues` in `deleteIndexEntries(oldRow, ...)`.

All three fetches include a defensive fallback to `oldKeyValues as Row` if the row is unexpectedly absent (so valid DML is never broken by index maintenance).

**Critical ordering constraint respected**: all fetches occur before any `collection.stage(...)` call, since staging clears/overwrites the slot and a fetch-after would return nothing or the new value.

### Tests added/tightened

**`index-support.spec.ts`**:
- Added `scanIndexKeys(plugin, uri)` helper that opens a fresh tree on the same cached transactor and collects all composite tree keys from a range scan.
- Added `describe('Index orphan regression')` with two new tests:
  - *UPDATE*: insert 3 rows, update one's indexed column, assert the index has exactly 3 entries and the old entry (stale value + PK) is absent.
  - *DELETE*: insert 3 rows, delete one, assert the index has exactly 2 entries and the deleted entry is absent.

**`session-mode-commit.spec.ts`** (test #2):
- Removed the stale deferral comment ("`tracked by backlog optimystic-index-orphan-on-update-delete`") and replaced with a direct comment.
- Added `countTreeEntries(plugin, '${uri}/index/idx_mut_cat') === 2` assertion after update + delete, confirming the index tree has exactly 2 live entries (no orphans).

### Test results
`npm run build && npm run typecheck && npm test` — **243 passing, 4 pending, 0 failing**.

## Use cases for testing / validation

- UPDATE that changes an indexed column: index should have exactly N live entries (old value gone, new value present).
- DELETE: index should have N-1 entries (deleted row's index entry gone).
- UPDATE OR REPLACE where moving row hits occupied key: moving row's OLD index entries must be deleted (not the displaced row's).
- Chained updates within a single transaction: each update sees the prior staged value as its old image (verified by `collection.get` before staging).
- Rollback: staged index mutations are still discarded correctly (the fetch is read-only; no change to the rollback path).

## Known gaps / reviewer notes

- The orphan fix falls out naturally without any change to `IndexManager.updateIndexEntries`'s early-return (when `oldTreeKey === newTreeKey`). UPDATEs that don't touch an indexed column now correctly skip that index's staging entirely — this is a correct behaviour improvement, not a gap.
- `INSERT OR REPLACE` path was already correct (used `existingRow` from a pre-fetch); left unchanged.
- `UPDATE OR IGNORE` and `UPDATE OR ABORT` paths stage nothing on conflict and return early before any index call; left unchanged.
- The `scanIndexKeys` helper in `index-support.spec.ts` is duplicated from `countTreeEntries` in `session-mode-commit.spec.ts` (different file, different return type). Could be extracted to a shared test utility, but that's out of scope.
