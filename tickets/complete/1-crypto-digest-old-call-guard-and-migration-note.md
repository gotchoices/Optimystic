description: Added a clear error and migration docs for code still calling the crypto plugin's old-style digest function; this reviews and accepts that work.
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/test/crypto.spec.ts, packages/quereus-plugin-crypto/CHANGELOG.md, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/src/plugin.ts
----

## Summary

The v0.14 `digest` rework changed the JS-exported `digest()` from `digest(scalar, algo, inputEncoding, outputEncoding)` to a variadic, injective `digest(fields[], algorithm?, encoding?)`. Old-style callers either hit a cryptic `Unsupported output encoding: utf8` error (third arg landing in the `encoding` slot) or, worse, silently corrupted: `digest('hello')` iterated the string into 5 single-char fields and returned a wrong-but-plausible digest.

The implementation added a runtime `Array.isArray(fields)` guard at the top of `digest()` that throws an actionable migration error for any non-array first argument, plus a `CHANGELOG.md`, a README migration cross-link, and three unit tests.

This ticket is the adversarial review of that work.

## Review findings

### Scope of checks
Read the implement diff (`6634e8f`) with fresh eyes, then the live `crypto.ts`, `plugin.ts`, `test/crypto.spec.ts`, `CHANGELOG.md`, and `README.md`. Ran `npm test`, `npm run typecheck`, `npm run build`.

### Validation — PASS
- **Tests:** `npm test` → **125 passing**.
- **Typecheck:** `npm run typecheck` → clean.
- **Build:** `npm run build` → success (ESM + DTS).

### Correctness / safety — PASS
- The guard `if (!Array.isArray(fields))` correctly covers every non-array first arg: old-style `string`, `Uint8Array`, and also `null`/`undefined` (both throw the migration error rather than a downstream `TypeError`). Typed `readonly DigestField[]` callers are unaffected (`Array.isArray` is true for readonly arrays).
- **SQL path is independent and not regressed.** `plugin.ts:133-134` calls `digestFields(...)` directly with a rest-parameter array (`(...fields)`), never the public `digest()`. The guard cannot affect the SQL surface. This independently confirms the implementer's decision to *not* add a guard to the low-level `digestFields`/`encodeFields` — the public guard sits exactly on the one surface that takes untyped input.
- **No in-repo breakage.** Swept all `.ts` callers of the plugin `digest()` across the monorepo: every call site passes an array literal. (The `sha256.digest(...)` hits in `db-core`/`db-p2p` are the multiformats hasher method, unrelated.)

### Test coverage — ADEQUATE
Three new cases cover old-style string (3-arg), bare string (silent char-iteration), and `Uint8Array` (silent byte-iteration). The pre-existing suite exercises the positive array path extensively (injectivity, cross-type, algorithm/encoding selection, SQL `impl` parity), so the guard is proven not to break valid calls. Edge inputs `null`/`undefined` are covered transitively by the same `Array.isArray` predicate the tests already assert on; no additional case warranted.

### Docs — ACCURATE
- README documents the new variadic signature consistently throughout (`### digest(field1, ..., fieldN)` at line 80; `### digest(fields, algorithm?, encoding?)` at line 415). No stale old-signature references remain. The added migration section (line ~305) links to `CHANGELOG.md`; the `#digest-configuration` anchor it references exists.
- `CHANGELOG.md` 0.14.0 BREAKING entry is thorough: old/new signature table, JS + SQL migration examples, the framed-≠-bare-hash warning, the silent-SQL-extra-args warning, and the no-shim rationale.

### Minor findings
1. **Error-message wording nuance (noted, not changed).** The message states "algorithm + output encoding are bound at plugin load time" and then directs the JS caller to `digest([value], algo, outputEncoding)`. The load-time binding is true of the *SQL* function; the *JS* `digest()` (the surface this error is thrown from) still accepts `algorithm`/`encoding` args. The text is mildly self-contradictory for a JS migrator, but the concrete migration line is correct and actionable — the stated goal. Left as-is deliberately: the exact string is mirrored verbatim in `CHANGELOG.md`, so churning it would mean editing both for a cosmetic gain, and the test (`/digest API changed in v0\.14/`) is wording-agnostic.
2. **CHANGELOG version vs package version (noted, not changed).** `package.json` is `0.14.1`; the CHANGELOG entry headlines `0.14.0` (where the breaking rework shipped). The guard itself is a follow-up that will ship in the next publish. Documenting the breaking change under the version that introduced it is reasonable; no version bump applied. A human should confirm the next publish carries the guard so CHANGELOG readers actually have the new error.

### Deferred (correctly out of scope — no new ticket filed)
- **Downstream sereus migration** (`cadre-core/src/strand-membership-writer.ts` still uses the 4-arg form) lives in a separate repo and cannot be done here. With this guard landed, those callers now get an actionable error.
- **Downstream-consumer sweep** before the next npm publish: the original "VoteTorrent is the sole consumer" assumption was already disproven by sereus. A grep of dependent repos for `digest(` with 3–4 positional args is prudent, but is release hygiene, not code in this repo.
- **Bare-hash helper** (`hash(data, algo, inEnc, outEnc)`): the new API has no drop-in for a bare un-framed single-value hash. `hashMod` is the nearest existing function but returns an integer mod 2^bits, not an encoded digest, so it is not a substitute. This is a feature decision for a separate backlog ticket if a real need surfaces — not filing one speculatively.

### Disposition
No major findings; no new fix/plan/backlog tickets required. The two minor findings are documentation/cosmetic and explicitly left as-is with rationale above. Implementation is correct, well-tested, and the docs reflect the new reality. Accepted.
