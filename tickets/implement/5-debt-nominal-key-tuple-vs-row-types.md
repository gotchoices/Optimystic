description: Two different kinds of value list — a whole table row, and a short list holding just the key columns — are both plain arrays today, so passing one where the other is expected compiles cleanly and silently computes the wrong storage key. Give the key-column list its own distinct type so the mix-up becomes a compile error.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/key-tuples.ts (new), packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/key-tuple-types.spec.ts (new), packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts, package.json
difficulty: medium
----

## What this is

The Optimystic virtual table turns column values into the string it uses as a tree key.
Two differently-shaped value lists arrive at that machinery:

- a **full row** — one cell per table column, addressed by *column position*
  (`row[pkDef[i].index]`), and
- a **key tuple** — one cell per primary-key column in *key order*, nothing else
  (`values[i]`). This is what quereus's `UpdateArgs.oldKeyValues` carries, and what a
  point-lookup's seek arguments are.

`RowCodec` has one method for each shape (`extractPrimaryKey(row)` /
`createPrimaryKey(values)`), and today both parameters are plain `SqlValue` arrays.
Handing either method the other's input compiles, runs, and returns a *wrong* key. The
two shapes agree only when the primary-key columns happen to be the table's leading
columns in key order — the common case, which is why the mistake hides in most tests.

Two shipped bugs came from exactly this confusion (composite-PK point lookups returning
nothing; a same-key UPDATE reported as colliding with itself, a DELETE removing nothing,
and a key-moving UPDATE leaving the original row behind). Both were found only from
downstream symptoms, because a wrong key is still a perfectly valid key.

This ticket makes the two shapes distinct **types**, so the substitution is a compile
error rather than silent corruption.

## Why the existing length assertions are not enough

`createPrimaryKey` already rejects a value list whose length differs from the number of
primary-key columns, and `extractPrimaryKey` already rejects anything that is not exactly
`schema.columns.length` long. Those two guards turn most mis-calls into a loud error —
but they are blind whenever the two shapes happen to be the *same length*, i.e. whenever
every table column is part of the primary key:

```sql
create table R (a text, b text, primary key (b, a));
```

Here a full row is `[a, b]` (length 2) and the key tuple is `[b, a]` (length 2). Passing
the tuple to `extractPrimaryKey` sails past the length check and reads
`tuple[pkDef[0].index] = tuple[1] = a`, `tuple[pkDef[1].index] = tuple[0] = b` — producing
`frame(a, b)` where the correct key is `frame(b, a)`. Same class of silent wrong key as
the two shipped bugs, same silence. That residual hole is the reason to do the type work
rather than stop at the assertions.

## The design (settled — verified to type-check)

A branded (nominal) `readonly` array type per tuple kind. `Row` in quereus is a
**mutable** `SqlValue[]`, so making the tuples `readonly` already blocks a tuple from
reaching any `Row` parameter; the brand closes the other direction (a full row reaching a
tuple parameter) and keeps the two tuple kinds apart from each other.

New file `packages/quereus-plugin-optimystic/src/schema/key-tuples.ts`:

```ts
import type { SqlValue } from '@quereus/quereus';

/**
 * One cell per primaryKeyDefinition entry, in key order. NOT a row: it is addressed
 * positionally (tuple[i]), never by column position (row[pkDef[i].index]).
 * Construct only via RowCodec.asPrimaryKeyTuple, which checks the arity.
 */
export type PrimaryKeyTuple = readonly SqlValue[] & { readonly __tupleBrand: 'PrimaryKeyTuple' };

/**
 * One cell per index column, in index order; may be a leading PREFIX of the index's
 * columns (a partial seek key). NOT a row.
 * Construct only via IndexManager.asIndexColumnTuple, which checks the arity.
 */
export type IndexColumnTuple = readonly SqlValue[] & { readonly __tupleBrand: 'IndexColumnTuple' };
```

A probe compiled with this repo's `tsc` under the same flags
(`--strict --noUncheckedIndexedAccess --target ES2022`) confirms all five intended
substitutions are rejected and all five intended calls compile:

| call | result |
|---|---|
| `extractPrimaryKey(row)` | ok |
| `createPrimaryKey(pkTuple)` | ok |
| `createIndexKeyFromTuple(idxTuple)` | ok |
| `extractPrimaryKey(pkTuple)` | **error** (readonly → mutable `Row`) |
| `createPrimaryKey(row)` | **error** (unbranded) |
| `createPrimaryKey(idxTuple)` | **error** (wrong brand) |
| `createIndexKeyFromTuple(pkTuple)` | **error** (wrong brand) |
| `createPrimaryKey(['a','b'])` | **error** (must go through the checked constructor) |

Ordinary array methods (`.map`, `.length`, indexing) still work on a branded readonly
array, so the bodies of `createPrimaryKey` / the index-key builders need no change.

### Resolved scope questions

- **Should `Row` itself become nominal?** **No.** `Row` is quereus's own exported type
  (`SqlValue[]`), crossing the vtab boundary in both directions; branding it would demand
  a cast at every engine call site and in every test, for no extra safety — its
  *mutability* already rejects the readonly tuples.
- **Does `index-manager.ts` carry the same ambiguity?** **Yes, and it gets the same
  treatment.** `createIndexKey(indexSchema, row)` is row-shaped, while the point-seek
  path in `optimystic-module.ts:939-948` builds an index key from positional constraint
  values by *inlining* `serializeIndexValue` + `encodeKeyTuple` — a second copy of the
  framing that must stay byte-identical to the first by hand. Fold that into
  `IndexManager` as a tuple-shaped entry point over the same core.
- **What about `uniqueKeyFor(columns, row)` in `optimystic-module.ts:1097`?** It is a
  third copy of the same framing formula, row-shaped. Consolidate it onto the shared core
  too, so exactly one function frames an index-style key.

### Target shape

`RowCodec` (row-codec.ts):

```ts
/** Checked constructor: the only way to obtain a PrimaryKeyTuple. */
asPrimaryKeyTuple(values: readonly SqlValue[]): PrimaryKeyTuple;   // throws on wrong arity

createPrimaryKey(values: PrimaryKeyTuple): PrimaryKeyValue;        // was: SqlValue[]
extractPrimaryKey(row: Row): PrimaryKeyValue;                      // unchanged signature
```

`extractPrimaryKey` keeps its existing `row.length !== columns.length` runtime guard —
the compile-time guard covers in-repo callers, the runtime guard still covers anything
reaching it through a cast or from JavaScript.

`IndexManager` (index-manager.ts):

```ts
/** Shared framing core — the ONLY place an index-style key is assembled. */
export function indexKeyFromPayloads(payloads: Array<string | null>): IndexKey;

asIndexColumnTuple(indexSchema: StoredIndexSchema, values: readonly SqlValue[]): IndexColumnTuple;
createIndexKeyFromTuple(tuple: IndexColumnTuple): IndexKey;
createIndexKey(indexSchema: StoredIndexSchema, row: Row): IndexKey;   // unchanged signature
```

`asIndexColumnTuple` accepts a **prefix**: it validates
`0 < values.length <= indexSchema.columns.length` (the seek path deliberately builds a
partial key so the framed prefix range in `findByIndexIn` brackets it).

`optimystic-module.ts` call sites:

- `executePointLookup` (`:899`) — `createPrimaryKey(this.rowCodec.asPrimaryKeyTuple(args as SqlValue[]))`.
- `executeIndexScan` (`:943-948`) — replace the inline payload loop with
  `asIndexColumnTuple(index.schema, args.slice(0, index.schema.columns.length) as SqlValue[])`
  then `createIndexKeyFromTuple(...)`. Preserve the existing `min(args.length,
  columns.length)` truncation exactly.
- `update()` UPDATE (`:1728`) and DELETE (`:1822`) — stop destructuring `oldKeyValues`
  out of `args` entirely. Read `args.oldKeyValues` in the existing "requires old key
  values" guards, and inside each case bind **only** the branded tuple:
  `const oldKeyTuple = this.rowCodec.asPrimaryKeyTuple(args.oldKeyValues);`. That way no
  unbranded binding of the compact tuple survives in scope to be misused, and the arity
  check still runs *after* the existing guard and after `addStatement` (do not hoist the
  conversion above the switch — it would change error ordering that
  `oldkeyvalues-compact-shape.spec.ts` exercises).
- `requirePreWriteRow` (`:1556`) — change `keyValues: readonly SqlValue[]` to
  `keyValues: PrimaryKeyTuple`. `formatKeyValues` (`:148`) keeps
  `readonly SqlValue[]` (a branded tuple is assignable to it — it only reads).

### Byte-compatibility constraint

**No stored key bytes may change.** This is a typing/refactor change only:
`serializeKeyPart`, `serializeIndexValue`, `encodeKeyTuple`, and the composite tree-key
concatenation must all produce byte-identical output. A change here would silently break
every already-persisted database and collide with the open decision in
`debt-optimystic-key-format-migration`. The existing `row-codec.spec.ts` /
`key-encoding.spec.ts` assertions are the guard — they must pass unmodified.

### Making the compile-time guard actually enforced

`yarn build` in this package runs **tsup** (esbuild), which does *not* type-check, and
the root `check` script is `lint && build && test && test:integration` — so today a type
error in `src` or `test` reaches nobody until someone runs `yarn typecheck` by hand.
Without fixing that, the entire nominal-type guard is decorative in CI.

Both packages that define a `typecheck` script (`quereus-plugin-optimystic`,
`quereus-plugin-crypto`) currently type-check **clean** (verified: `tsc --noEmit`, 0
errors in each). So add a root `typecheck` script that fans out over the workspaces and
put it in the `check` chain ahead of `test`. Yarn 4's `workspaces foreach` skips
workspaces that do not define the script, so no other package needs touching.

## Edge cases & interactions

- **Equal-length shapes (the blind spot above).** `create table R (a, b, primary key (b, a))`
  — every column is in the PK, so both shapes are length 2 and the arity guards cannot
  tell them apart. Must be covered.
- **Single-column PK.** Tuple length 1 vs a 1-column table: the same equal-length blind
  spot in miniature. Existing coverage has a *non-leading* single-column PK on a 2-column
  table (arity guard catches that one); add the degenerate 1-column case if cheap.
- **Empty primary key (singleton table).** `primaryKeyDefinition.length === 0` is a
  supported shape (`createPrimaryKeyComparator` special-cases it). `asPrimaryKeyTuple([])`
  must succeed and produce the empty framed key — do not add a `length > 0` assertion to
  the PK constructor. (`asIndexColumnTuple` *does* reject empty, since a zero-column
  prefix would range over the whole index.)
- **Partial index seek keys.** `args.length < index.schema.columns.length` is legal and
  must still produce the same framed prefix as before; `args.length >
  index.schema.columns.length` must still truncate rather than throw (the planner can
  hand over more constraint values than the index covers).
- **NULL cells in either shape.** `null` frames to the bare NULL tag and must remain
  distinct from an empty-string value, in both the PK path and the index path.
- **UPDATE that moves the primary key.** `oldKeyTuple` → `oldKey` and `values` (full row)
  → `newKey` must stay on their respective methods; the displace/evict ordering in the
  UPDATE branch is unchanged.
- **Index maintenance across a PK move.** `updateIndexEntries(oldRow, newRow, oldPk,
  newPk)` still takes full rows on both sides — confirm nothing in the refactor lets a
  tuple reach it.
- **`ensureUniquePopulated` / `addIndex` backfill loops** feed `decodeRow` output (a full
  row) to `createIndexKey` and `extractPrimaryKey`. Those must keep compiling unchanged —
  if they need a cast, the design is wrong.
- **Unique-constraint probe** (`probeUniqueConstraint` → `createIndexKey(descriptor,
  values)`) passes the engine's full post-update row, not a tuple. Unchanged.
- **Reopen / persistence.** Every regression test that writes then reopens the store must
  still read back the same rows — the strongest signal that no key bytes moved.
- **Tests import `../dist/plugin.js`.** `yarn build` must run before `yarn test` in this
  package, or the specs run against a stale bundle.

## Key tests

- **`test/key-tuple-types.spec.ts` (new, type-level).** A spec whose body is
  `@ts-expect-error`-annotated calls asserting each forbidden substitution is a compile
  error (mirroring the table above). `tsconfig.json` includes `test`, so `yarn typecheck`
  fails if any guard ever stops firing — that is the whole point of adding typecheck to
  `check`. Include one trivial runtime `expect(true).to.equal(true)` so mocha does not
  report an empty file.
- **Rotated all-column PK, runtime (extend `test/oldkeyvalues-compact-shape.spec.ts`).**
  `create table R (a text, b text, primary key (b, a))`; insert; UPDATE a key column;
  DELETE; assert exactly one row lands at the new key and none survives at the old one,
  across a reopen. Expected: passes on today's (already-fixed) code — it documents the
  arity guard's blind spot rather than reproducing a live bug. *If quereus rejects or
  normalizes an out-of-declaration-order composite PK, say so in the handoff and rely on
  the type-level spec alone for that case — do not contort the schema to force it.*
- **`asPrimaryKeyTuple` arity, unit (`test/row-codec.spec.ts`).** Wrong arity throws with
  a message naming the expected count; correct arity round-trips byte-identically with
  `extractPrimaryKey` on the same logical key; empty PK definition accepts `[]`.
- **`asIndexColumnTuple` arity, unit.** Full-width and prefix-width accepted; empty
  rejected; over-width rejected (the module truncates *before* calling it).
- **Byte-identity, unit.** For a representative table + index:
  `createIndexKeyFromTuple(asIndexColumnTuple(idx, [v0, v1]))` equals
  `createIndexKey(idx, fullRowContaining(v0, v1))`, and the partial-prefix form is a
  string prefix of the full form. This is the assertion that pins the two index-key entry
  points to one framing.

## TODO

### Phase 1 — types and codec

- Add `src/schema/key-tuples.ts` with `PrimaryKeyTuple` and `IndexColumnTuple` as above,
  each with a doc comment stating the addressing rule it encodes.
- Add `RowCodec.asPrimaryKeyTuple(values)`: validates
  `values.length === primaryKeyDefinition.length` (allowing 0), throws the same style of
  message `createPrimaryKey` throws today, returns the branded value.
- Narrow `RowCodec.createPrimaryKey` to take `PrimaryKeyTuple`; keep its internal length
  check as belt-and-braces. Keep `extractPrimaryKey`'s full-row length guard.
- Update the class doc comments so the two methods state, in one line each, which shape
  they take and which type constructs it.

### Phase 2 — index manager

- Extract the index-key framing into one shared core and route `createIndexKey`
  (row-shaped) through it.
- Add `asIndexColumnTuple(indexSchema, values)` (validates
  `0 < length <= indexSchema.columns.length`) and `createIndexKeyFromTuple(tuple)`.
- Export whatever the module needs so the inline copy in `optimystic-module.ts` can go
  away.

### Phase 3 — module call sites

- `executePointLookup`: route seek args through `asPrimaryKeyTuple`.
- `executeIndexScan`: replace the inline `serializeIndexValue` + `encodeKeyTuple` loop
  with the truncate → `asIndexColumnTuple` → `createIndexKeyFromTuple` chain; drop the
  now-unused imports if nothing else in the file needs them.
- `update()`: stop destructuring `oldKeyValues`; bind only `oldKeyTuple` inside the
  UPDATE and DELETE cases; keep the guards and `addStatement` ordering exactly as they
  are.
- `requirePreWriteRow`: take `PrimaryKeyTuple`.
- Consolidate `uniqueKeyFor` onto the shared index-key core.
- Rewrite the long explanatory comments at the two DML sites: they currently explain the
  hazard in prose because the compiler could not. Keep one short line each pointing at
  `key-tuples.ts` rather than re-stating the whole story.

### Phase 4 — tests and enforcement

- Add `test/key-tuple-types.spec.ts` (type-level guards).
- Extend `test/oldkeyvalues-compact-shape.spec.ts` with the rotated all-column PK case.
- Add the `asPrimaryKeyTuple` / `asIndexColumnTuple` / byte-identity unit tests.
- Add a root `typecheck` script (`yarn workspaces foreach -At --exclude
  '@optimystic/optimystic' run typecheck`) and insert it into the root `check` chain
  before `test`.

### Phase 5 — validate

Run from `packages/quereus-plugin-optimystic`, streaming output (never silent
redirection):

- `yarn typecheck 2>&1 | tee /tmp/typecheck.log` — must be 0 errors, including the new
  `@ts-expect-error` spec.
- `yarn build 2>&1 | tee /tmp/build.log` — required before the specs that import
  `../dist/plugin.js`.
- `yarn test 2>&1 | tee /tmp/test.log` — full package suite green, with
  `row-codec.spec.ts`, `key-encoding.spec.ts`, `composite-pk-point-lookup.spec.ts`, and
  `oldkeyvalues-compact-shape.spec.ts` unmodified except for the added case.
- From the repo root, `yarn typecheck 2>&1 | tee /tmp/typecheck-root.log` to confirm the
  new fan-out script works and skips packages without it.

## Handoff notes for review

Be explicit about: any call site that needed a cast to compile (each one is a hole in the
design, not a nit); whether quereus accepted the rotated composite PK in the runtime
test; and confirmation that no key-encoding assertion in the existing specs was touched.
