# Row Codec Round-Trip Bugs

description: bigint values lose precision via Number() cast; Uint8Array values encode as base64 but never decode back, breaking binary round-trip
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/schema/row-codec.ts
  - packages/quereus-plugin-optimystic/test/row-codec.spec.ts
----

## Bug 1: Bigint Precision Loss

`row-codec.ts` line 190 casts `bigint` to `Number()`, which silently loses precision for values outside the safe integer range (> 2^53 - 1).

## Bug 2: Uint8Array Round-Trip Failure

`row-codec.ts` line 76 encodes `Uint8Array` as base64 during `encodeRow()`, but `decodeRow()` does not convert the base64 string back to `Uint8Array`. Consumers receive a string where they expect binary data.

## Expected Behavior

- Bigint values should be preserved without precision loss (e.g., remain as bigint or use string encoding).
- Uint8Array values should round-trip: encode as base64, decode back to Uint8Array.

## Reproducing Tests

Already exist in `packages/quereus-plugin-optimystic/test/row-codec.spec.ts` (TEST-7.4.2 from system-review.md) as bug-documenting test cases.
