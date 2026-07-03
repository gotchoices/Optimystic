description: A secondary-index helper used to serialize different data types (whole numbers as BigInt vs plain number) inconsistently, which could orphan stale index rows; the three duplicate copies of that helper were merged into one type-insensitive function.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-serialize-value.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts
difficulty: medium
----

## What was done

Consolidated the three byte-identical secondary-index value serializers into ONE
exported function and made it type-insensitive for numeric equality:

- Added `export function serializeIndexValue(value: SqlValue): string` in
  `src/schema/index-manager.ts`. Its **only** behavioral change vs. the old copies:
  the `bigint` branch now returns `Number(value).toExponential(15)` (was
  `value.toString()`), so a `bigint` and the equal `number` serialize to a
  byte-identical key.
- Deleted the three private copies and re-pointed every caller at the shared function:
  - `IndexManager.createIndexKey` (feeds insert/update/delete index staging).
  - `OptimysticVTab.executeIndexScan` (equality seek key builder).
  - `OptimysticVTab.uniqueKeyFor` (secondary-UNIQUE probe key; now
    `serializeIndexValue(row[ci] ?? null)` — the `?? null` guards the
    `SqlValue | undefined` element type the old `unknown`-typed helper tolerated).
- Added a `NOTE:` at the serializer documenting the large-integer precision ceiling
  (see tripwire below).

Build (`tsup`), typecheck (`tsc --noEmit`), and the full package test suite
(**262 passing, 11 pending, 0 failing**, ~3 min incl. the 3-node libp2p integration
mesh) all pass.

## IMPORTANT — the ticket's core premise was wrong; read before reviewing the test

The implement ticket asserted as *confirmed fact* that on INSERT "integers arrive as
`bigint`" and only become `number` after a storage round-trip, so an integer UPDATE
would orphan a stale index entry. **That is not true for the pinned
`@quereus/quereus`.** I instrumented `serializeIndexValue` and drove real SQL: an
`INSERT ... VALUES (…, 20)` and the subsequent `UPDATE`/`DELETE` **both** hand the
serializer a JS `number` (`"number:20"`), and the stored index key is already the
`toExponential` form (`"2.000000000000000e+1\x00…"`), i.e. the number branch — never
the bigint branch. So the described orphan is **not reachable through SQL integer
literals in this version.**

Consequences the reviewer should weigh:

- The bug is **latent, not live**: it only trips if a `bigint` (small enough to store
  as `number`) actually flows into the serializer — e.g. a bound `BigInt` parameter,
  or a future Quereus that emits integer literals as `bigint`. The fix is therefore
  correct and defensive hardening + a genuine de-duplication, not a fix for a
  currently-reproducible data-corruption bug. Grade it accordingly.
- Because of this, the **integration** test (`index-support.spec.ts`, the
  `orphan_int` case) does **not** fail on the old code — with numbers on both sides
  there was never a mismatch. I kept it as an honest **black-box behavioral guard**
  (no orphan + correct seek for an INTEGER indexed column, a path no prior orphan
  test covered — all used TEXT) and commented it as such; it is NOT the reproduction.
- The **real fail-before/pass-after guard** is the new unit spec
  `test/index-serialize-value.spec.ts`. It imports `serializeIndexValue` directly
  from source (ts-node resolves the `.ts`) and asserts `serializeIndexValue(5n) ===
  serializeIndexValue(5)` etc. **Verified**: 3 of its cases FAIL on the old
  `.toString()` bigint branch (`'5'` ≠ `'5.000000000000000e+0'`) and all PASS on the
  unified function.

If the reviewer wants a *live* end-to-end reproduction, the open question is whether
any public Quereus surface can push a small `bigint` into this table's write/seek
path (bound parameters were not exercised here). If yes, that path deserves an
integration test; if no, the unit guard is the correct level and the fix stands as
hardening.

## Why the chosen encoding (and rejected alternatives)

Unifying **onto** `toExponential(15)` (rather than a plain integer string) keeps every
number/REAL/range-bound key byte-identical to before — the existing range test
(`price >= 20 AND price <= 50`) depends on that lexicographic form. Canonicalizing via
`RowCodec.normalizeValue` was rejected because it maps large bigints to a tagged
`{ $bigint }` object with no serializer branch, collapsing all large integers to
`"[object Object]"`. Both rationales are recorded in the serializer's doc comment so a
future reader does not "simplify" into a regression.

## Tripwire (parked, not a ticket)

`Number(bigint).toExponential(15)` is **lossy** for integers beyond
`Number.MAX_SAFE_INTEGER` (2^53−1). It stays **self-consistent** — insert and the
decoded old row both round-trip to the same lossy string, so it never orphans — but
two *distinct* huge integers can collide onto one index key (a false-positive index
match). This is the same precision ceiling REAL columns already have. Parked as a
`NOTE:` at the serializer site in `src/schema/index-manager.ts` (greppable) and in the
doc comment; not filed as a ticket.

## Validation / use cases for the reviewer

- **Type parity (the invariant):** `test/index-serialize-value.spec.ts` — bigint↔number
  parity, NULL/undefined → `'\x01'`, string passthrough, and that the number branch
  stays on `toExponential(15)` (guards range-bound behavior). This is the spec to run
  first; revert the bigint branch to `value.toString()` to watch it fail.
- **Integer index end-to-end:** `index-support.spec.ts` → "UPDATE/DELETE on an
  INTEGER-typed indexed column leaves no orphan and seeks correctly" — scans the raw
  index tree via `scanIndexKeys` (bypasses the vtab tracker) after an UPDATE + DELETE,
  asserts exactly the live composite keys survive, plus equality-seek assertions.
- **Consolidation didn't regress the UNIQUE path:** `secondary-unique.spec.ts`,
  `insert-pk-uniqueness.spec.ts`, `update-pk-move-uniqueness.spec.ts` (they route
  through `uniqueKeyFor` → the shared serializer). All green.
- **Existing index/range/composite behavior:** the rest of `index-support.spec.ts`
  (equality, range `toExponential`, composite, ORDER BY, NULL/empty-string, addIndex
  population) all green — the encoding is unchanged for every non-bigint type.

Commands (from `packages/quereus-plugin-optimystic`):
`npm run build` → `npm run typecheck` → `npm test` (build must precede test — the
integration specs import the compiled `dist/plugin.js`; the unit spec imports source).

## Known gaps / things to poke at

- Bound-parameter path (`?`/named params carrying a JS `BigInt`) into INSERT/seek was
  not exercised — this is the most likely *live* trigger of the latent bug and the
  best candidate for an added integration test if reachable.
- The seek argument's JS type was not separately instrumented (only insert/update/
  delete were); the unified serializer makes seek consistent regardless, but a
  reviewer wanting certainty could instrument `executeIndexScan`'s `args`.
- No BLOB-indexed-column test exists for the shared serializer's `Uint8Array` branch
  (unchanged by this work, but also untested end-to-end).
