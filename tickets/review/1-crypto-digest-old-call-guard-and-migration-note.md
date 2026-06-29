description: Review the old-style `digest()` call guard and v0.14 migration documentation added to the crypto plugin.
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/test/crypto.spec.ts, packages/quereus-plugin-crypto/CHANGELOG.md, packages/quereus-plugin-crypto/README.md
----

## What was implemented

### 1. Non-array guard in `digest()` (`src/crypto.ts:319`)

Added an `Array.isArray(fields)` guard at the top of the exported `digest()` function.
When the first argument is not an array (covering both the old-style scalar `string`/`Uint8Array`
call and any other non-array), it throws a clear, actionable error:

```
digest(fields, algorithm?, encoding?): 'fields' must be an array of values.
The digest API changed in v0.14: it is now variadic/injective over fields,
the per-call inputEncoding was removed, and algorithm + output encoding are bound at plugin load time.
Migrate digest(value, algo, inputEncoding, outputEncoding) → digest([value], algo, outputEncoding) —
note the result is now a *framed* digest, not a bare hash of the bytes.
```

This single guard covers both documented failure modes:
- **Cryptic error** (sereus case): `digest(payload, 'sha256', 'utf8', 'bytes')` — old third arg
  `'utf8'` lands in `encoding` slot, `resolveOutputEncoder('utf8')` threw `Unsupported output encoding: utf8`.
  Now throws the migration error before reaching `resolveOutputEncoder`.
- **Silent corruption**: `digest('hello')` would iterate `['h','e','l','l','o']` and return a
  5-field digest. Now throws instead.

**Decision on `digestFields`/`encodeFields`:** no guard added to these low-level functions.
The SQL plugin path always passes a real array (constructed from variadic SQL args), and these
are internal building blocks, not the public-facing surface. Defense-in-depth guard was deemed
unnecessary complexity for this ticket.

### 2. New unit tests (`test/crypto.spec.ts`)

Three new `it()` cases inserted inside the existing `describe('digest() — variadic multi-field')` block:

- `old-style string arg throws migration error (not "Unsupported output encoding")` — asserts the
  stable substring `digest API changed in v0.14` against `digest('hello' as any, 'sha256', 'utf8' as any)`.
- `bare-string arg throws (guards silent char-iteration corruption)` — asserts same substring against
  `digest('hello' as any)`.
- `Uint8Array arg throws (guards silent byte-iteration corruption)` — asserts same substring against
  `digest(new Uint8Array([1,2,3]) as any)`.

All 125 tests pass (`npm test`); typecheck passes (`npm run typecheck`); build passes (`npm run build`).

### 3. CHANGELOG.md (new file)

`packages/quereus-plugin-crypto/CHANGELOG.md` — a `0.14.0` entry headed **BREAKING** covering:
- Old vs new JS signature table
- Migration examples (old → new for both `bytes` and `base64url` output)
- Warning that **result value changes** (framed ≠ bare hash)
- SQL caller warning (extra positional args are silently treated as data fields; no error)
- Why no compat shim
- What the new error message says
- Open question: bare-hash helper (see below)

### 4. README.md cross-link

Added a short `## Migration (v0.14 breaking change)` section above `## Digest configuration` in the
README, pointing to `CHANGELOG.md`.

## Known gaps / handoff notes

**Does not fix the sereus test.** `packages/cadre-core/src/strand-membership-writer.ts` in the
**sereus** repo still calls the old 4-arg form. That is a downstream migration in a separate repo
and cannot be done from optimystic. With this ticket landed, the error message those callers receive
is now actionable rather than cryptic.

**"Sole consumer" assumption already proved wrong.** The original complete-ticket assumed VoteTorrent
was the only consumer; sereus showed that was incorrect. Other external consumers may exist. A sweep
of downstream repos (grep for `digest(` with 3–4 positional args) is prudent before the next npm
publish.

**Open: bare-hash helper.** The new `digest` provides no function for a bare (un-framed) hash of a
single value's bytes — exactly what `digest(x, algo, inEnc, outEnc)` did. A caller needing to match
an externally-computed hash or reproduce pre-v0.14 values has no drop-in. If a
`hash(data, algorithm, inputEncoding, outputEncoding)` helper is needed, file a separate backlog
ticket — it is a feature decision, not part of this fix.

**Version:** `package.json` is at `0.14.1`; the CHANGELOG entry is under `0.14.0` (the breaking
change shipped in that version). No version bump was applied in this ticket.

## Test cases for validation

```bash
cd packages/quereus-plugin-crypto
npm run build
npm run typecheck
npm test   # all 125 must pass
```

Spot-check the three new guards manually if desired:
```ts
import { digest } from '@optimystic/quereus-plugin-crypto';
digest('hello' as any);                          // must throw with "digest API changed in v0.14"
digest('hello' as any, 'sha256', 'utf8' as any); // must throw same (not "Unsupported output encoding")
digest(['hello']);                                // must succeed
```
