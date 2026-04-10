description: Fixed addIndex() entry tuple destructuring — correctly extracts value from [key, value] tuple before decoding
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (line 671)
  - packages/quereus-plugin-optimystic/test/index-support.spec.ts (addIndex with existing data block)
----

## What was built

Fixed a bug in `OptimysticVirtualTable.addIndex()` where the raw `[key, value]` entry tuple from `collection.at(path)` was passed directly to `rowCodec.decodeRow()`, causing a JSON parse crash when creating an index on a table that already has data.

The fix extracts `entry[1]` (the encoded row) before decoding, matching the identical pattern used at lines 340, 391, and 452 in the same file.

## Key change

`optimystic-module.ts` line 671:
```typescript
const entry = this.collection.at(path) as [string, EncodedRow] | undefined;
if (entry && entry.length >= 2) {
  const encodedRow = entry[1];
  const row = this.rowCodec.decodeRow(encodedRow);
```

## Testing

- New test in `index-support.spec.ts` "addIndex with existing data" block: creates table, inserts 3 rows, then creates an index (triggering the population loop), and verifies queries work against the index.
- All 181 tests pass (16 index-specific).
- Build passes.

## Review notes

- Fix follows the strongest typing pattern (line 340: `as [string, EncodedRow] | undefined`)
- Pre-existing `any` at line 391 is a minor inconsistency but out of scope for this ticket
