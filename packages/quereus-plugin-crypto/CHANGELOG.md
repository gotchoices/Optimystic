# Changelog

## 0.14.0 — BREAKING: `digest` API rework

### What changed

The exported `digest()` function signature changed from:

```ts
// OLD (≤ 0.13.x)
digest(data: string | Uint8Array, algorithm?, inputEncoding?, outputEncoding?)
```

to:

```ts
// NEW (≥ 0.14.0)
digest(fields: readonly DigestField[], algorithm?, encoding?)
```

Key differences:

| | Old | New |
|---|---|---|
| First argument | A single scalar value (`string` \| `Uint8Array`) | An **array** of values |
| `inputEncoding` | 3rd positional arg | **Removed** (the new API frames values by type, no string-decoding step) |
| Output encoding | 4th positional arg | 2nd `encoding` arg (shifted left by one) |
| Algorithm | 2nd positional arg | 2nd `algorithm` arg (unchanged position) |
| Result | Bare hash of the decoded bytes | **Framed** injective digest — `digest(['hello'])` ≠ `sha256("hello")` |
| Algorithm + encoding | Per-call | **Bound at plugin load time** for the SQL function |

### Migration: JS/TypeScript callers

```ts
// OLD
const hashBytes     = digest(payload, 'sha256', 'utf8', 'bytes')    as Uint8Array;
const payloadDigest = digest(payload, 'sha256', 'utf8', 'base64url') as string;

// NEW — wrap the value in an array, drop inputEncoding
const hashBytes     = digest([payload], 'sha256', 'bytes')    as Uint8Array;
const payloadDigest = digest([payload], 'sha256', 'base64url') as string;
```

> **The result value changes.** The new digest is *framed* (version byte + type tag +
> length-prefixed payload per field), so `digest(['hello'])` is **not** the same bytes
> as `sha256(utf8("hello"))`. If you need to match an externally-computed bare hash,
> see the open question below.

### Migration: SQL callers

The SQL `digest(field1, field2, ...)` function is **variadic over data fields** — every
argument is a field to hash, not a config option — so the signature is unchanged from the
SQL perspective.

However, if you were passing extra positional arguments to mimic `algo`/`inputEncoding`/`outputEncoding`
(e.g. `digest(data, 'sha256', 'utf8', 'bytes')`), those are now treated as **additional
data fields** and hashed into the result silently rather than interpreted as config. There
is **no error** on the SQL path for this; it just hashes more fields. Check any SQL call
sites that pass more than pure data arguments.

Algorithm and encoding are now set via the plugin config at load time (see the
[Digest configuration](README.md#digest-configuration) section of the README).

### Why no compatibility shim?

The old and new calling conventions cannot be cleanly disambiguated: the new first argument
is always an array; the old's was always a scalar. Adding a scalar → old-API detection
shim would silently re-enable the broken `inputEncoding` positional footgun and make the
result value unpredictable. The clean break stays; instead, old-style JS calls now throw
a clear, actionable error message naming this migration note.

### Error message for old-style calls

If you pass a non-array as the first argument to `digest()` in JS/TypeScript, you will now
see:

```
digest(fields, algorithm?, encoding?): 'fields' must be an array of values.
The digest API changed in v0.14: it is now variadic/injective over fields,
the per-call inputEncoding was removed, and algorithm + output encoding are bound at plugin load time.
Migrate digest(value, algo, inputEncoding, outputEncoding) → digest([value], algo, outputEncoding) —
note the result is now a *framed* digest, not a bare hash of the bytes.
```

### Open question: bare hash helper

The new `digest` has no function that returns a bare (un-framed) hash of a single value's
bytes in a chosen encoding — what the old `digest(x, algo, inEnc, outEnc)` did. If you
need bare-hash semantics (e.g. to match a hash stored before v0.14, or computed by an
external system), there is currently no drop-in. File a separate issue/ticket if a
`hash(data, algorithm, inputEncoding, outputEncoding)` helper is needed.
