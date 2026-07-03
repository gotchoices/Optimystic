description: Secondary-index bookkeeping keys are built from raw values whose data type differs between insert and later update/delete, so index entries are orphaned and stale rows resurface in query results.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts
difficulty: medium
----

## Bug (confirmed)

An index entry's key is serialized directly from the raw incoming value, whose
JavaScript type changes across a row's lifecycle:

- **INSERT** stages index entries from the *raw* Quereus row (`optimystic-module.ts:1011`
  → `insertIndexEntries(values, ...)`). Integers arrive as `bigint`, so the index
  serializer's **bigint** branch runs: `5n` → `"5"`.
- The stored row is normalized to a JS `number` on encode (`row-codec.ts:189-197`,
  small bigint → `Number`).
- **UPDATE/DELETE** recompute the *old* index key from the *decoded* stored row
  (`optimystic-module.ts:968,1100-1146,1177`), where the integer is now a `number`,
  so the serializer's **number** branch runs: `5` → `"5.000000000000000e+0"`.

The two strings differ, so the delete-of-old-key misses and a **stale index entry**
survives. Index scans then resurrect the deleted/old row. The same type mismatch
makes an index seek whose argument arrives as a differently-typed value miss valid
rows.

## Why the primary key does NOT have this bug

`RowCodec.serializeKeyPart` (`row-codec.ts:155-184`) serializes both `bigint` and
`number` integers with `.toString()` → identical `"5"`. The index serializer instead
uses `.toExponential(15)` for numbers but `.toString()` for bigints — that asymmetry
is the whole bug. So PK-keyed point lookups work while index lookups orphan.

## Three duplicated copies of the serializer (all must agree)

1. `IndexManager.serializeValue` — `index-manager.ts:285-306` (used by `createIndexKey`,
   which feeds insert/update/delete index staging).
2. `OptimysticVTab.serializeValueForIndex` — `optimystic-module.ts:665-682` (used by
   `executeIndexScan` for equality seeks **and** by `uniqueKeyFor` at
   `optimystic-module.ts:812` for secondary-UNIQUE probes).

They are byte-for-byte identical today with comments admitting the two must stay in
sync — a second place the mismatch can silently re-diverge.

## Relationship to prior work

The completed ticket `optimystic-index-orphan-on-update-delete` fixed a *different*
orphan cause (old indexed values read at the wrong schema position → a NULL-marker
key) by fetching the real old row before staging. This is a **distinct, still-live**
root cause: even with the correct old row, the value's JS type (`bigint` vs `number`)
makes the recomputed key differ from the stored key. That earlier fix's regression
tests (`index-support.spec.ts:315-406`) all use a **TEXT** `cat` column, so they never
exercised the numeric-type path — this is the gap they left, not a regression of them.

## Expected behavior

An index key for the same logical value is byte-identical regardless of whether the
value arrived as `bigint` or `number`, on insert, seek, update, and delete.

## Chosen fix direction (and why NOT the naive alternatives)

Consolidate the three copies into **one exported** `serializeIndexValue(value)` and
make it **type-insensitive for numeric equality** by unifying integers **onto the
existing `toExponential(15)` form** — i.e. change only the `bigint` branch to emit the
same string the `number` branch already does:

```ts
export function serializeIndexValue(value: SqlValue): string {
  if (value === null || value === undefined) return '\x01';   // NULL marker (unchanged)
  if (typeof value === 'string') return value;
  // Unify bigint onto the number branch so 5n and 5 serialize identically.
  if (typeof value === 'bigint') return Number(value).toExponential(15);
  if (typeof value === 'number') return value.toExponential(15);
  if (value instanceof Uint8Array) return btoa(String.fromCharCode(...value));
  return String(value);
}
```

Two alternatives were considered and **rejected** — record the rationale so a future
reader does not "simplify" back into a regression:

- **Canonicalize via `RowCodec.normalizeValue` before serializing** (the literal
  suggestion in the fix ticket): breaks on large bigints, which `normalizeValue` maps
  to a tagged `{ $bigint }` **object**. The serializer has no object branch → both
  sides fall to `String(value)` = `"[object Object]"`, collapsing every large integer
  to one key. Do not use `normalizeValue` here.
- **Serialize integers as a plain integer string** (`BigInt(value).toString()` for
  both branches): this *does* fix equality, but it changes the serialized form of
  integer *range bounds* against REAL columns. The existing range test
  (`index-support.spec.ts:145-148`, `price >= 20 AND price <= 50`) relies on the
  `toExponential` lexicographic form; a plain `"20"` sorts wrong against a stored
  `"2.999…e+1"` and drops `29.99` from the result. Unifying **onto** `toExponential`
  keeps all number/real/bound behavior byte-identical to today.

Precision note (tripwire, not a task): `Number(bigint).toExponential(15)` is lossy for
integers beyond `Number.MAX_SAFE_INTEGER`. It stays **self-consistent** (insert and the
decoded old row round-trip to the same lossy string), so it does not orphan; but two
distinct huge integers can collide into one index key — the same precision ceiling
reals already have. Add a `// NOTE:` at the serializer site so the ceiling is greppable,
and mention it in the review handoff. Do not file a separate ticket.

## Consumers to re-point at the shared function

- `IndexManager.createIndexKey` (`index-manager.ts:78-89`) → call `serializeIndexValue`;
  delete the private `serializeValue`.
- `OptimysticVTab.executeIndexScan` (`optimystic-module.ts:640`) → call the shared
  `serializeIndexValue`; delete the private `serializeValueForIndex`.
- `OptimysticVTab.uniqueKeyFor` (`optimystic-module.ts:812`) → same shared function
  (it currently references `serializeValueForIndex`); verify the secondary-UNIQUE
  tests still pass (`test/secondary-unique.spec.ts`, `test/insert-pk-uniqueness.spec.ts`,
  `test/update-pk-move-uniqueness.spec.ts`).

Export it from `index-manager.ts` (alongside the `IndexKey` types) so both files share
one definition; `optimystic-module.ts` already imports from `./schema/index-manager.js`.

## Test to add

Extend the existing `Index orphan regression` block in
`test/index-support.spec.ts:315`. The suite imports the **compiled** plugin
(`../dist/plugin.js`), so `npm run build` must precede `npm test`. Reuse the
`scanIndexKeys` helper (scans the raw index tree, bypassing the vtab tracker).

New case — bigint round-trip on an **INTEGER** indexed column (the currently-untested
path):

- `CREATE TABLE ... (id INTEGER PRIMARY KEY, n INTEGER)`, `CREATE INDEX ... ON t(n)`.
- `INSERT` rows with integer `n` values.
- `UPDATE` one row's `n` to a new integer, and `DELETE` another row.
- Assert via `scanIndexKeys` that the index tree holds exactly the live composite keys
  — no stale entry for the old/deleted `n` survives (this is what fails today).
- Add a seek assertion: `SELECT * FROM t WHERE n = <value>` returns exactly the live
  matching rows (guards the seek-side of the same mismatch).

## TODO

- [ ] Add `export function serializeIndexValue(value: SqlValue): string` to
      `index-manager.ts` with the bigint branch unified onto `toExponential(15)`; add a
      `// NOTE:` on the large-integer precision ceiling.
- [ ] Repoint `IndexManager.createIndexKey` to it; delete `IndexManager.serializeValue`.
- [ ] Repoint `executeIndexScan` and `uniqueKeyFor` to the shared function; delete
      `OptimysticVTab.serializeValueForIndex`.
- [ ] Add the bigint round-trip orphan + seek test to `test/index-support.spec.ts`.
- [ ] `npm run build` then `npm run typecheck` in
      `packages/quereus-plugin-optimystic` (stream output with `2>&1 | tee`).
- [ ] Run the affected specs streamed:
      `npm test 2>&1 | tee /tmp/idx.log` (or narrow to index/unique specs first via
      `test:verbose` with a `--grep`), confirm the new test fails before the source
      change and passes after, and that index/unique/orphan specs stay green.
- [ ] Write the review/ handoff: note the precision-ceiling tripwire and the pre-fix
      duplication that was consolidated.
