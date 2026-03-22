# Row Codec Round-Trip Fixes

description: Fix bigint precision loss and Uint8Array round-trip failure in row-codec
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/schema/row-codec.ts
  - packages/quereus-plugin-optimystic/test/row-codec.spec.ts
----

## Summary

Two round-trip bugs in `RowCodec` have been fixed:

### Bug 1: Bigint Precision Loss (line 190)

**Root cause**: `normalizeValue()` unconditionally cast all `bigint` values to `Number()`, which silently truncates values outside the safe integer range (> 2^53 - 1).

**Fix**: In `normalizeValue()`, bigints within `Number.MIN_SAFE_INTEGER..MAX_SAFE_INTEGER` continue converting to `Number` (preserving existing behavior for small values). Large bigints are encoded as a tagged object `{ $bigint: "stringValue" }`. The new `denormalizeValue()` method detects this tag during decode and restores the original `BigInt`.

### Bug 2: Uint8Array Round-Trip Failure (line 76)

**Root cause**: `encodeRow()` converts `Uint8Array` to base64 via `normalizeValue()`, but `decodeRow()` returned the raw base64 string without converting back.

**Fix**: Added `denormalizeValue()` method called during `decodeRow()`. For columns with BLOB affinity, base64 strings are converted back to `Uint8Array` using `uint8FromString(value, 'base64')`.

### Key Changes

- `normalizeValue()`: Large bigints → `{ $bigint: "..." }` tagged encoding
- New `denormalizeValue(value, col)`: Restores tagged bigints and base64 BLOB values
- `decodeRow()`: Routes values through `denormalizeValue()` using column schema
- Added import: `fromString` from `uint8arrays/from-string`
- Added import: `StoredColumnSchema` from `./schema-manager.js`

### Test Changes

- "should lose precision for bigints > 2^53 (known bug)" → "should preserve precision for bigints > 2^53" — now expects `BigInt('9007199254740993')`
- "should not restore Uint8Array on decode (known bug)" → "should round-trip Uint8Array values via base64 encoding" — now expects `Uint8Array` instance with correct bytes

## TODO

- [x] Fix `normalizeValue()` for large bigints
- [x] Add `denormalizeValue()` method
- [x] Wire `denormalizeValue()` into `decodeRow()`
- [x] Update bug-documenting tests to verify correct behavior
- [x] Build passes
- [x] All 33 row-codec tests pass
