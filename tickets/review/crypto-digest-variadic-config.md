description: Review the reworked crypto-plugin `digest` — it now hashes several fields at once with collision-safe framing, and picks its hash algorithm/output format from load-time config instead of per-call arguments.
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/src/plugin.ts, packages/quereus-plugin-crypto/src/index.ts, packages/quereus-plugin-crypto/test/crypto.spec.ts, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/package.json
difficulty: medium
----
## What was built

`digest` was reworked from `digest(data, algorithm?, inputEncoding?, outputEncoding?)` into a
**variadic, injective, multi-field** digest, with algorithm + output encoding moved to **load-time
plugin config**. No backward-compat shim (VoteTorrent is the only consumer).

- `crypto.ts`
  - `encodeFields(fields)` — canonical injective framing: `version(0x01) ‖ (tag ‖ varint(len) ‖ payload)*`,
    NULL is a bare tag. Type tags NULL/INT/REAL/TEXT/BOOL/BLOB/JSON. INTEGER unifies `number`-integer
    and `bigint`; REAL uses `Number::toString`; JSON native objects canonicalized with sorted keys.
  - `resolveHasher(algorithm)` / `resolveOutputEncoder(encoding)` — keyed lookups (no `switch`), meant
    to be resolved once and captured.
  - `digestFields(fields, hasher, encode)` — low-level core; `digest(fields, algorithm?, encoding?)` —
    JS convenience.
  - `hashMod` reimplemented on `resolveHasher(...)(toBytes(...))` (single-blob sharding hash; no longer
    routes through `digest`).
- `plugin.ts` — `register(db, config)` reads `config.algorithm`/`config.encoding`, validates (throws at
  registration on unknown algorithm / non-text encoding), resolves once, registers `digest` as
  `numArgs: -1`, `replicable: true`, variadic over fields.
- `index.ts` — exports `encodeFields`, `digestFields`, `resolveHasher`, `resolveOutputEncoder`, and new
  types (`OutputEncoding`, `DigestField`, `DigestHasher`, `OutputEncoder`).
- `package.json` — `quereus.settings` documents `algorithm` + `encoding`.
- `README.md` — variadic usage, "Digest configuration" section (load-time + the `replicable` rationale),
  updated JS API reference and examples.

## Verification done

- `npm run build`, `npm run typecheck`, `npm test` all green (54 passing).
- Tests cover: variadic basics; injectivity vectors (`['a','bc']` vs `['ab','c']`; `|`-in-string; NULL vs
  `''` vs absent; `123` vs `'123'`; `true` vs `'true'` vs `1`; `123` == `123n`; arity; order; JSON
  key-order canonicalization); `encodeFields` framing bytes; plugin load-time config (defaults,
  non-default honored, `replicable: true`, fail-fast on bad config).

## What the reviewer should scrutinize (treat tests as a floor)

- **Injectivity / replicability of the encoding** — the security-critical property. Any way two distinct
  field tuples collide? Any value type whose encoding is non-deterministic across JS engines (focus:
  REAL formatting, JSON canonicalization of nested/`undefined`/array holes, `-0`, large numbers losing
  precision as `number` vs exact as `bigint`)?
- **SQL-boundary value space** — confirm Quereus actually delivers integers as `number`/`bigint`,
  booleans as JS `boolean`, JSON columns as TEXT (opaque) vs native objects. If a type arrives in an
  unexpected JS form, does `encodeField` still frame it injectively (or throw cleanly)?
- **`replicable: true` correctness** — output must depend only on (args + load-time config). Verify the
  schema-object shape (not `createScalarFunction`) is honored by `registerFunction` and the
  `requiresReplicableDerivations` gate.
- **`hashMod` change** — confirm shard distribution/back-compat is acceptable (it now hashes raw decoded
  bytes directly; previously routed through the old `digest`).

## Known gaps / follow-ups (do not fix here unless trivial)

- **Downstream, separate repo:** VoteTorrent `vote-engine/src/database/initialize.ts` still defines a
  local non-injective `Digest` (`String().join('|')`) used in signed authorization constraints. It
  should adopt this plugin's `digest` (or `encodeFields`) and pass config at `registerPlugin(...)`
  (initialize.ts:102). File against the votetorrent repo.
- **Version bump:** this is a breaking API change; `package.json` version was left at `0.13.5`. Decide on
  a bump at publish time.
- **No full end-to-end SQL test** (register + `db.exec("SELECT digest(...)")`); the plugin test calls the
  registered `implementation` directly. A real-DB test would also exercise the type marshalling above.
