# Row Codec Round-Trip Fixes — Review

description: Review bigint precision and Uint8Array round-trip fixes in row-codec
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/schema/row-codec.ts
  - packages/quereus-plugin-optimystic/test/row-codec.spec.ts
----

## What Was Built

Two round-trip bugs in `RowCodec` were fixed:

### Bug 1: Bigint Precision Loss
`normalizeValue()` now encodes large bigints (outside safe integer range) as `{ $bigint: "stringValue" }` tagged objects. Small bigints still convert to `Number`. `denormalizeValue()` restores the original `BigInt` on decode.

### Bug 2: Uint8Array Round-Trip Failure
`denormalizeValue()` converts base64 strings back to `Uint8Array` for columns with BLOB affinity during `decodeRow()`.

### Key Interface Points
- `normalizeValue(value)` — encode-side, handles bigint tagging and Uint8Array→base64
- `denormalizeValue(value, col)` — decode-side, restores tagged bigints and base64→Uint8Array for BLOB columns
- `decodeRow()` now routes each value through `denormalizeValue()` with the column schema

## Testing / Validation

All 33 row-codec tests pass. Key test cases to review:

- **Bigint round-trip**: `"should preserve precision for bigints > 2^53"` — encodes `BigInt('9007199254740993')`, decodes back to same value
- **Small bigint**: `"should encode small bigints without precision loss"` — `BigInt(42)` round-trips to `42` (Number)
- **Uint8Array round-trip**: `"should round-trip Uint8Array values via base64 encoding"` — `Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])` survives encode/decode
- **Uint8Array encoding**: `"should encode Uint8Array to base64 string"` — verifies JSON contains base64 string

## Usage
```ts
const codec = new RowCodec(schema);
const encoded = codec.encodeRow([BigInt('9007199254740993'), new Uint8Array([1,2,3])]);
const decoded = codec.decodeRow(encoded); // bigint and Uint8Array restored
```
