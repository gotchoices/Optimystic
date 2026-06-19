description: The crypto plugin's `digest` now hashes several fields at once with collision-safe framing and picks its hash algorithm/output format once at load time instead of on every call.
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/src/plugin.ts, packages/quereus-plugin-crypto/src/index.ts, packages/quereus-plugin-crypto/test/crypto.spec.ts, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/package.json
----
## What was built

`digest` was reworked from `digest(data, algorithm?, inputEncoding?, outputEncoding?)` into a
**variadic, injective, multi-field** digest whose algorithm + output encoding are bound once at
**plugin-load time** (no backward-compat shim — VoteTorrent is the only consumer).

- **Variadic data:** `digest(f1, f2, …, fN)` — every argument is a field, not config.
- **Injective framing (`encodeFields`):** `version(0x01) ‖ (tag ‖ varint(len) ‖ payload)*`, NULL is a
  bare tag. Type tags NULL/INT/REAL/TEXT/BOOL/BLOB/JSON. Distinct tuples never collide; NULL ≠ `''`;
  `123` ≠ `'123'`; a separator inside a string is just payload. Integer `number` and `bigint` of equal
  value unify (both via `BigInt(...).toString()`). Native JSON objects are canonicalized with sorted
  keys; non-JSON contents throw.
- **Load-time config (Option A):** `register(db, config)` reads `config.algorithm` (default `sha256`) and
  `config.encoding` (default `base64url`), validates fail-fast, and resolves a hasher + encoder **once**
  — the per-call path has no `switch`/branch on algorithm or encoding (`resolveHasher` /
  `resolveOutputEncoder` are keyed lookups).
- **`replicable: true`:** the digest is registered replicable because these digests are signed and
  persisted; output depends only on (args + load-time config). This is *why* config is load-time-fixed
  rather than per-connection mutable.
- **Building blocks exported:** `encodeFields`, `digestFields`, `resolveHasher`, `resolveOutputEncoder`
  (+ types). `hashMod` reimplemented directly on the resolved hasher (single-blob sharding).
- **Docs/manifest:** README "Digest configuration" section + updated examples; `quereus.settings`
  documents `algorithm`/`encoding`.

## Key files

- `packages/quereus-plugin-crypto/src/crypto.ts` — encoder, resolvers, `digest`/`digestFields`, `hashMod`.
- `packages/quereus-plugin-crypto/src/plugin.ts` — load-time config + variadic/replicable `digest`.
- `packages/quereus-plugin-crypto/src/index.ts` — exports.
- `packages/quereus-plugin-crypto/test/crypto.spec.ts` — 61 tests.

## Testing notes

`npm run build`, `npm run typecheck`, `npm test` all green (**61 passing**). Coverage: variadic basics;
injectivity vectors (`['a','bc']` vs `['ab','c']`, `|`-in-string, NULL vs `''` vs absent, `123` vs
`'123'`, bool vs text vs 1, arity, order, JSON key-order); cross-type (REAL vs text, blob vs JSON array,
`123`==`123n`, `1e21`==`10n**21n`, `2.0`==`2`, `-0`==`0`); strict-JSON throws (`undefined`, `NaN`,
`bigint`, `Date`); **golden known-answer vectors** (sha256/hex + `encodeFields` byte layout) to lock the
wire format; plugin load-time config (defaults, non-default honored, `replicable:true`, fail-fast).

## Usage

```ts
import { registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
await registerPlugin(db, cryptoPlugin, { algorithm: 'sha256', encoding: 'base64url' });
// SQL:  SELECT digest(Tid, Name, ImageRef, NumberRequiredTSAs) AS commitment;
```

## Review findings

Fresh-eyes adversarial review (independent agent) over the implement diff. Disposition below.

**Checked:** injectivity (tag/varint/null/arity/order/cross-type collisions), replicability across JS
engines (REAL formatting, JSON canonicalization, key sort), `writeVarint` LEB128 correctness, `encodeField`
type coverage, `plugin.ts` config validation + schema shape (`replicable`/`numArgs`), `hashMod`
reimplementation, test gaps.

**Found & fixed inline (minor/contained, security-relevant so fixed not deferred):**
- *Large-integer `number` vs `bigint` mismatch* — `(1e21).toString()` → `"1e+21"` differed from the
  bigint's full digits, breaking the documented equal-value invariant. Fixed: integer-valued numbers
  encode via `BigInt(field).toString()`. (test added)
- *Silent JSON mis-encoding* — `stableStringify` collapsed `undefined`→`null`, non-finite→`null`,
  `Date`/exotic→`{}`, and threw raw `TypeError` on nested `bigint` — all injectivity hazards. Replaced
  with a **strict `canonicalJson`** that throws on `undefined`/non-finite/`bigint`/non-plain-object and
  sorts keys. (tests added)
- *Missing known-answer vectors* — every digest test was self-referential, so a silent format change
  would pass. Added golden sha256/hex vectors + an `encodeFields` byte-layout vector.

**Found & accepted (documented, not a bug):**
- *INTEGER vs REAL collision* — an integer-valued REAL (`2.0` → JS number 2) encodes as INTEGER, so
  `digest([2.0]) == digest([2])`. A scalar function does not receive SQL affinity, so it cannot
  distinguish them; behavior is replicable (every peer sees the same JS value). Documented honestly in
  code/JSDoc and pinned with a test. VoteTorrent commits no REAL columns.

**Clean (verified):** `writeVarint`/`framed` LEB128 (checked against a bigint reference incl. > 2^32);
`hashMod` (all algorithms emit ≥ 8 bytes; big-endian/modulo correct; strict improvement over the prior
base64url round-trip); output encoders (noble/uint8arrays, engine-stable); `replicable`/`numArgs:-1`
schema fields recognized by the engine.

## Follow-ups (out of scope here)

- **VoteTorrent (separate repo):** `vote-engine/src/database/initialize.ts` still defines a local
  non-injective `Digest` (`args.map(String).join('|')`) used in signed authorization constraints — a
  live injectivity/security bug (delimiter collision, NULL/`''` conflation, type confusion). It should
  adopt this plugin's `digest`/`encodeFields` and pass config at `registerPlugin(...)` (initialize.ts:102).
  File against the votetorrent repo.
- **Version bump:** breaking API change; `package.json` left at `0.13.5` — decide a bump at publish time.
- **End-to-end SQL test:** the plugin test calls the registered `implementation` directly; a real
  `db.exec("SELECT digest(...)")` test would also exercise Quereus's value marshalling (int as
  number/bigint, JSON columns as TEXT).
