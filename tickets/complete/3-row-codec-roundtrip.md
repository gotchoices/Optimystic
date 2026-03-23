# Row Codec Round-Trip Fixes — Complete

description: Bigint precision and Uint8Array round-trip fixes in row-codec
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/schema/row-codec.ts
  - packages/quereus-plugin-optimystic/test/row-codec.spec.ts
----

## What Was Built

Two round-trip bugs in `RowCodec` were fixed:

### Bug 1: Bigint Precision Loss
`normalizeValue()` encodes large bigints (outside safe integer range) as `{ $bigint: "stringValue" }` tagged objects. Small bigints convert to `Number`. `denormalizeValue()` restores the original `BigInt` on decode.

### Bug 2: Uint8Array Round-Trip Failure
`denormalizeValue()` converts base64 strings back to `Uint8Array` for columns with BLOB affinity during `decodeRow()`.

## Key Files
- `row-codec.ts:189-204` — `normalizeValue()`: bigint tagging + Uint8Array→base64
- `row-codec.ts:209-223` — `denormalizeValue()`: tagged bigint restore + base64→Uint8Array for BLOB columns
- `row-codec.ts:63-82` — `decodeRow()`: routes values through `denormalizeValue()` with column schema

## Testing

33/33 row-codec tests pass. Key coverage:
- `"should preserve precision for bigints > 2^53"` — large bigint round-trip
- `"should encode small bigints without precision loss"` — small bigint → Number
- `"should round-trip Uint8Array values via base64 encoding"` — full encode/decode cycle
- `"should encode Uint8Array to base64 string"` — encoding format verification
- Edge case tests document known bugs in key serialization (separator collision, numeric-looking TEXT keys) as out-of-scope

## Review Notes

- Code is clean, symmetric (`normalizeValue`/`denormalizeValue`), and well-scoped
- Schema-aware decode (column affinity drives BLOB restoration) is the correct design
- No duplication, no over-engineering
- Tagged bigint encoding (`$bigint`) is a pragmatic choice for JSON serialization

## Usage
```ts
const codec = new RowCodec(schema);
const encoded = codec.encodeRow([BigInt('9007199254740993'), new Uint8Array([1,2,3])]);
const decoded = codec.decodeRow(encoded); // bigint and Uint8Array restored
```
