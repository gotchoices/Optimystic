description: After the crypto plugin changed how `digest` is called, old-style calls now fail with a confusing message (or silently produce a wrong result). Add a clear, actionable error for old-style calls and write a short migration note, so downstream projects that missed the change get told exactly what to fix.
prereq:
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/src/plugin.ts, packages/quereus-plugin-crypto/test/crypto.spec.ts, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/package.json
difficulty: easy
----

## Background

The `crypto-digest-variadic-config` change (now in `tickets/complete/`, commits
`8cea904` / `f10094c`) reworked the exported `digest()` of
`@optimystic/quereus-plugin-crypto`:

- **Old:** `digest(data: string | Uint8Array, algorithm?, inputEncoding?, outputEncoding?)`
  — a *bare* hash of one value's bytes, decoded via `inputEncoding`, encoded via `outputEncoding`.
- **New:** `digest(fields: readonly DigestField[], algorithm?, encoding?)`
  — a *framed, injective* multi-field digest; there is **no** `inputEncoding`, and the
  output encoding/algorithm are bound once at plugin-load time.

That complete-ticket explicitly noted "**no backward-compat shim — VoteTorrent is the
only consumer**." **That assumption was wrong.** A second downstream consumer in the
**sereus** repo (`packages/cadre-core/src/strand-membership-writer.ts`, lines ~50 and ~71)
still calls the old 4-argument form, e.g.:

```ts
const hashBytes     = digest(payload, 'sha256', 'utf8', 'bytes')   as Uint8Array;
const payloadDigest = digest(payload, 'sha256', 'utf8', 'base64url') as string;
```

With the new signature the old third positional argument (`'utf8'`, the input encoding)
lands in the **output-encoding** slot, so `resolveOutputEncoder('utf8')` throws
`Unsupported output encoding: utf8` (`crypto.ts:129`, reached from `digest` at
`crypto.ts:324`). This breaks 10 of 14 tests in sereus's
`test/strand-membership-peer-rotation.spec.ts`.

## Scope of this ticket (read first)

This ticket does **NOT** fix the failing sereus test — that is a downstream migration in a
**separate repo** and cannot be done from optimystic. The breaking change was deliberate
and reviewed; **do not revert it** and **do not add a same-named compatibility shim**.

What this ticket *does* is make optimystic's side of the breaking change safe and
self-explaining for the *next* consumer that missed it (sereus proved the "sole consumer"
assumption false, so treat further unknown callers as likely):

1. Turn the two bad failure modes into one clear, actionable error.
2. Ship a short, discoverable migration note.

### Two failure modes to fix

- **Cryptic error (sereus's case):** an old call routes `inputEncoding` into the output
  slot → `Unsupported output encoding: utf8`, which says nothing about the real cause (the
  signature changed).
- **Silent corruption (worse, latent):** the new `digest(fields, …)` expects an array. A
  JS string is iterable, so `digest('hello', …)` would iterate `['h','e','l','l','o']` and
  silently return a digest of five single-char fields instead of throwing. A `Uint8Array`
  first arg iterates its bytes as numeric fields. No current test catches this.

A single guard at the top of `digest()` — *reject a non-array `fields`* — catches **both**:
the old call's first arg is a bare `string`/`Uint8Array`, so `Array.isArray(fields)` is
false and the guard fires *before* `resolveOutputEncoder`, with a message that names the
migration.

## Decisions (made here; documented so the implementer doesn't re-litigate)

- **Decline a deprecation shim / dual-dispatch under the name `digest`.** It would
  reintroduce the exact positional-`inputEncoding` footgun the change removed, and old-vs-new
  cannot be disambiguated cleanly (the new API's first arg is an array, the old's a scalar;
  a "detect a scalar → treat as old" heuristic is fragile and silently re-enables the
  hazard). The clean break stays; we make it *loud*, not *compatible*.
- **No SQL-side guard.** The SQL `digest(...)` is variadic over fields, so an old SQL call
  like `digest(data, 'sha256', 'utf8', 'bytes')` is indistinguishable from a legitimate
  4-field digest — it silently hashes the 4-tuple. This cannot be auto-detected; it is
  **documented loudly** in the migration note instead. (The reported sereus break is on the
  JS API path, which the guard *does* cover.)

## Open question (do NOT implement here — note for the human / a possible backlog ticket)

The new `digest` is *framed*, so there is **no longer any plugin function that returns a
bare (un-framed) hash of a single value's bytes** in a chosen encoding — exactly what the
old `digest(x, algo, inEnc, outEnc)` did. A downstream caller that needs bare-hash
semantics (e.g. to match an externally-computed hash, or to keep already-persisted hashes
stable) has **no drop-in**: `digest([x], algo, enc)` is a *different value* (it carries the
`version ‖ tag ‖ len` framing). sereus will most likely just adopt the framed digest, but
if a bare-hash helper (e.g. an exported `hash(data, algorithm, inputEncoding, outputEncoding)`)
turns out to be wanted, file a separate `backlog/` ticket for it — it is a feature decision,
not part of this fix.

## Reproduction (mechanism, confirmed by code reading)

Cross-repo (the real one), from a sereus checkout:

```
cd C:/projects/sereus/packages/cadre-core
yarn vitest run test/strand-membership-peer-rotation.spec.ts   # 10/14 fail: Unsupported output encoding: utf8
```

In-repo (the mechanism, for the new unit test): with the *current* code,
`digest('hello' as any, 'sha256', 'utf8' as any)` throws `Unsupported output encoding:
utf8`, and `digest('hello' as any)` silently returns a 5-field digest instead of throwing.
After this ticket both should throw the new, explicit migration error.

## TODO

- [ ] In `packages/quereus-plugin-crypto/src/crypto.ts`, at the top of the exported
      `digest(fields, …)` (around line 319), reject a non-array `fields` with `Array.isArray`:
      throw a clear, actionable error, e.g.
      `digest(fields, algorithm?, encoding?): 'fields' must be an array of values. The digest API changed in v0.14: it is now variadic/injective over fields, the per-call inputEncoding was removed, and algorithm + output encoding are bound at plugin load time. Migrate digest(value, algo, inputEncoding, outputEncoding) → digest([value], algo, outputEncoding) — note the result is now a *framed* digest, not a bare hash of the bytes.`
      (Keep the message single-source so the test can assert a stable substring like
      `digest API changed in v0.14`.)
- [ ] Decide whether to mirror the guard in the exported low-level `digestFields` /
      `encodeFields` (also accept `readonly DigestField[]`). The SQL plugin path always
      passes a real array, so this is optional defense-in-depth for advanced JS callers; if
      added, keep it cheap (one `Array.isArray` check, not per-field). Document the choice in
      the review handoff.
- [ ] Add unit tests in `packages/quereus-plugin-crypto/test/crypto.spec.ts`:
      - old-style call `digest('hello' as any, 'sha256', 'utf8' as any)` now throws the new
        migration error (assert the stable substring), **not** `Unsupported output encoding`.
      - bare-string `digest('hello' as any)` throws (guards the silent char-iteration
        corruption) rather than returning a 5-field digest.
      - a normal `digest(['hello'], …)` still works unchanged (regression guard).
- [ ] Add a migration note. Prefer a new `packages/quereus-plugin-crypto/CHANGELOG.md` with a
      `0.14.0` entry headed **BREAKING** that shows old → new for both the JS API and the SQL
      function, states the input-encoding removal + load-time algorithm/encoding config, and
      **explicitly warns** that (a) the digest is now *framed* (not a bare hash, so values
      change) and (b) old SQL `digest(data, algo, enc, …)` calls do **not** error — they
      silently hash extra fields. Cross-link the README "Digest configuration" section.
      (If a CHANGELOG file is undesirable for this repo's conventions, add the same content as
      a short "## Migration (v0.14 breaking change)" section near the top of the README
      instead — but a CHANGELOG is preferred because npm surfaces it.)
- [ ] Confirm the `package.json` version (`0.14.1`) and the CHANGELOG heading agree; the
      breaking change shipped in the `0.13.5 → 0.14.x` bump, so document it under `0.14.0`. Do
      not bump the version in this ticket unless the build/publish flow requires it — note the
      state in the review handoff.
- [ ] Validate from the package dir: `npm run build`, `npm run typecheck`, `npm test`
      (stream output, e.g. `npm test 2>&1 | tee /tmp/crypto-test.log`). All must stay green
      (was 61 passing + the new tests).
- [ ] Review handoff must be honest that this ticket does **not** fix the sereus test (a
      downstream migration), and must restate the open bare-hash-helper question above so the
      reviewer/human can decide whether to file the backlog ticket. Mention that any other
      external consumers (the "sole consumer" assumption already failed once) should be swept.
