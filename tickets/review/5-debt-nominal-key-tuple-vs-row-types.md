description: Two kinds of value list — a whole table row, and a short list holding just the key columns — used to be the same plain-array type, so passing one where the other was expected compiled fine and silently produced the wrong storage key. Each now has its own distinct type, so the mix-up is a compile error.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/key-tuples.ts (new), packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/key-tuple-types.spec.ts (new), packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts, package.json
difficulty: medium
----

## What landed

Three differently-addressed value lists reach the Optimystic virtual table's key-building
code, and they are not interchangeable:

- a **full row** — one cell per table column, addressed by column position
  (`row[pkDef[i].index]`);
- a **primary key tuple** — one cell per primary-key column, in key order, addressed
  positionally (`tuple[i]`); this is what `UpdateArgs.oldKeyValues` carries and what a
  point lookup's seek arguments are;
- an **index column tuple** — one cell per index column, in index order, possibly a
  leading prefix.

All three were plain `SqlValue[]`, so handing a method the wrong one compiled, ran, and
returned a *wrong but perfectly valid* tree key. Two shipped bugs came from exactly that.
The two shapes now have distinct nominal types.

### Source changes

**`src/schema/key-tuples.ts` (new).** Declares `PrimaryKeyTuple` and `IndexColumnTuple`
as branded `readonly SqlValue[]`. Two halves make it work: `readonly` blocks a tuple from
reaching a `Row` parameter (quereus's `Row` is mutable `SqlValue[]`), and the phantom
brand blocks a row — or a bare array literal — from reaching a tuple parameter, and keeps
the two tuple kinds apart. `Row` itself is deliberately NOT branded. No runtime cost: the
brand is type-only, arrays behave normally.

**`src/schema/row-codec.ts`.** New `asPrimaryKeyTuple(values)` — the only way to obtain a
`PrimaryKeyTuple`, validating arity (empty allowed, for a singleton table's empty PK).
`createPrimaryKey` narrowed to take `PrimaryKeyTuple`, keeping its internal length check
as belt-and-braces. `extractPrimaryKey(row: Row)` signature unchanged, runtime full-row
guard kept.

**`src/schema/index-manager.ts`.** New exported `indexKeyFromValues(values)` — the single
place an index-style key is assembled (serialize each value, then frame). `createIndexKey`
(row-shaped), the new `createIndexKeyFromTuple` (tuple-shaped), and the vtab's
`uniqueKeyFor` all route through it, so they are byte-identical by construction rather
than by three hand-maintained copies. New `asIndexColumnTuple(indexSchema, values)`
validates `0 < length <= index width` — a prefix is accepted, empty is rejected.

**`src/optimystic-module.ts`.** `executePointLookup` routes seek args through
`asPrimaryKeyTuple`. `executeIndexScan` replaces its inline copy of the framing formula
with truncate → `asIndexColumnTuple` → `createIndexKeyFromTuple`. `update()` no longer
destructures `oldKeyValues`; the UPDATE and DELETE cases each bind only the branded
`oldKeyTuple`, converted *inside* the case so error ordering relative to the guards and
`addStatement` is unchanged. `requirePreWriteRow` takes `PrimaryKeyTuple`.
`uniqueKeyFor` consolidated onto `indexKeyFromValues`. The long prose comments at the two
DML sites — which existed because the compiler could not express the hazard — are cut to
one pointer line each.

**`src/index.ts`.** Re-exports both tuple types so downstream consumers can name them.

**Root `package.json`.** New `typecheck` script fanning out over workspaces, inserted into
`check` as `lint && build && typecheck && test && test:integration`. **`typecheck` must
stay after `build`** — several specs import `../dist/index.js`, whose `.d.ts` only exists
post-build. Before this, `yarn build` ran tsup (esbuild, no type checking) and nothing in
`check` ever type-checked, so the entire nominal guard would have been decorative in CI.

## Validation performed

From `packages/quereus-plugin-optimystic`:

- `yarn typecheck` — 0 errors.
- `yarn build` — success.
- `yarn test` — **439 passing, 11 pending, 0 failing**, smoke ok.
- `yarn test:integration` — **442 passing, 8 pending, 0 failing**, smoke ok.

From repo root:

- `yarn typecheck` — 0 errors, fan-out works and skips workspaces without the script.
  **Verified it actually gates**, not silently no-ops: a deliberate `const _probe: number
  = "not a number"` in `key-tuples.ts` produced
  `src/schema/key-tuples.ts(72,7): error TS2322` and exit 1; probe removed.
- `yarn lint` — clean.

## Use cases to exercise when reviewing

**The compile-time guard itself.** `test/key-tuple-types.spec.ts` holds
`@ts-expect-error`-annotated forbidden calls. `@ts-expect-error` is itself an error when
the line below stops erroring, so weakening any guard fails `yarn typecheck`. The forbidden
calls live in a never-invoked function — they must be type-checked, never executed. To
confirm the guards are real rather than vacuous, delete one `@ts-expect-error` line and
check that `yarn typecheck` fails. Guards asserted:

| call | expected |
|---|---|
| `extractPrimaryKey(row)`, `createPrimaryKey(pkTuple)`, `createIndexKey(idx, row)`, `createIndexKeyFromTuple(idxTuple)`, `asIndexColumnTuple(idx, [...])` | compile |
| `extractPrimaryKey(pkTuple)` | error (readonly → mutable `Row`) |
| `createPrimaryKey(row)` | error (unbranded) |
| `createPrimaryKey(idxTuple)` / `createIndexKeyFromTuple(pkTuple)` | error (wrong brand) |
| `createPrimaryKey(['a','b'])` / `createIndexKeyFromTuple(['a'])` | error (must use constructor) |
| `createIndexKey(idx, idxTuple)` / `insertIndexEntries(pkTuple, pk)` | error (tuple is not a `Row`) |

**The equal-length blind spot — the reason the type work was needed at all.** The arity
checks cannot distinguish the two shapes when every table column is in the primary key.
`create table R (a text, b text, primary key (b, a))`: a full row is `[a, b]`, a key tuple
is `[b, a]`, both length 2, and swapping them yields a different key. Covered at two
levels — `oldkeyvalues-compact-shape.spec.ts` "UPDATE and DELETE stay correct when EVERY
column is in the PK and PK order is rotated" (real `local` transactor over real file
storage: insert, move a key column, assert one row at the new key and none at the old,
reopen, delete, reopen), and `row-codec.spec.ts` "should reject a rotated all-column tuple
only by TYPE, not by arity", which asserts the two addressings genuinely produce
*different* keys so the swap is corruption, not a no-op.

**Index-key byte-identity across entry points.** `key-tuple-types.spec.ts` asserts
`createIndexKeyFromTuple(asIndexColumnTuple(idx, [x, y]))` equals
`createIndexKey(idx, fullRow(x, y))` at full width; that a partial-prefix key is a string
prefix of the full key; that NULL stays distinct from the empty string on both paths; and
that numeric values agree (the `toExponential` form must be reached identically — a plain
integer form on one side would break REAL range bounds). This is the assertion that pins
the two index-key entry points to one framing.

**Arity constructors.** `asPrimaryKeyTuple` — wrong arity throws naming the expected count;
correct arity round-trips byte-identically with `extractPrimaryKey`; empty PK definition
accepts `[]` and yields the empty framed key. `asIndexColumnTuple` — full width and prefix
width accepted, empty rejected, over-width rejected.

**Byte compatibility (no stored key may move).** `key-encoding.spec.ts` and the key
assertions in `row-codec.spec.ts` were **not** touched, and every reopen-based regression
test still reads back the rows it wrote. Worth re-checking independently, since a silent
change here would break already-persisted databases and collide with the open decision in
`debt-optimystic-key-format-migration`.

## Deviations from the plan — please scrutinise these

**Shared core takes values, not payloads.** The ticket specified
`indexKeyFromPayloads(payloads: Array<string | null>)`. Implemented as
`indexKeyFromValues(values: readonly SqlValue[])` instead: a payload-taking core still
leaves the per-value `serializeIndexValue` mapping duplicated at all three call sites,
which is half the drift risk. Taking values folds serialize + frame into one function, so
there is exactly one place an index key is built. Strictly stronger than the plan, but it
is a deviation.

**Zero-argument index scan bypasses `asIndexColumnTuple`.** `executeIndexScan` is reachable
with zero constraint values (`runQuery` guards `args.length > 0` for the point-lookup path
but not for the index-scan path) — an index-served `ORDER BY` produces this, and today it
frames to `''`, which brackets the whole index. `asIndexColumnTuple` deliberately rejects
an empty tuple, so that case calls `indexKeyFromValues([])` directly rather than weakening
the guard. This preserves current behaviour exactly, but it is one code path where the
tuple type does not apply. **Reviewer: check whether the zero-arg path is genuinely
reachable in a plan, and whether bypassing is preferable to letting `asIndexColumnTuple`
accept empty.**

**`row-codec.spec.ts` call sites changed shape.** The plan said the existing specs pass
"unmodified"; that was impossible for `createPrimaryKey`, whose signature changed —
`codec.createPrimaryKey(['x','y'])` no longer compiles. Every such call is now
`codec.createPrimaryKey(codec.asPrimaryKeyTuple(['x','y']))`. **No assertion was weakened
or removed.** One test moved deliberately: "should throw when value count mismatches PK
definition" now exercises `asPrimaryKeyTuple(['x'])`, since the arity check's home is the
constructor.

**`src/index.ts` export added.** Not in the plan. `dist/index.d.ts` bundles the types
structurally either way, but without the named export a consumer cannot annotate a
variable with `PrimaryKeyTuple`.

## Answers to the plan's handoff questions

**Did any call site need a cast?** Only at the engine boundary, where a cast already
existed before this change. `executePointLookup` uses `args as readonly SqlValue[]` and
`executeIndexScan` uses `args.slice(0, width) as readonly SqlValue[]` — both because
quereus hands over `readonly unknown[]`, and the prior code cast identically
(`args as SqlValue[]` / `args[i] as SqlValue`). The two casts *inside* the checked
constructors (`values as PrimaryKeyTuple`) are the brand-minting sites and are the design,
not a hole. **No row-shaped call site needed a cast**: `ensureUniquePopulated`, the
`addIndex` backfill, `probeUniqueConstraint`, `updateIndexEntries`, and
`insert/deleteIndexEntries` all compile unchanged, which is the signal that the row/tuple
split landed where the shapes actually differ.

**Did quereus accept the rotated composite PK?** **Yes.** `create table R (a text, b text,
primary key (b, a))` was accepted with the declaration order preserved; the runtime test
passes and did not need contorting.

**Was any key-encoding assertion touched?** **No.** `key-encoding.spec.ts` is untouched.
In `row-codec.spec.ts` only the *call form* changed (wrapping in `asPrimaryKeyTuple`);
every `expect(...)` is byte-for-byte as it was, plus new ones.

## Known gaps — treat this work as a floor

- **Tuple-to-tuple re-branding is not blocked.** `asPrimaryKeyTuple` accepts
  `readonly SqlValue[]`, and an `IndexColumnTuple` satisfies that — so an index tuple can
  be laundered into a primary-key tuple through the constructor (and vice versa). Arity
  catches it in most schemas, not all. Closing this would mean the constructors reject
  already-branded inputs, which TypeScript can express but adds friction; it was not
  attempted.
- **Seek arguments are protected by arity only, not by types.** The engine hands over
  `readonly unknown[]`, so the brand starts at the constructor. Nothing type-checks that
  `filterInfo.args` really is key-ordered — only that its length matches.
- **No test asserts stored key bytes are unchanged versus the pre-change build.**
  Byte-compatibility rests on the untouched existing assertions plus the reopen tests
  passing. A recorded golden-bytes fixture would be stronger; it was out of scope here and
  overlaps the open `debt-optimystic-key-format-migration` decision.
- **`scanIndexRange` remains uncovered** and still has no production caller (pre-existing
  `NOTE:` in `index-manager.ts`); it does not route through `indexKeyFromValues` because it
  takes already-built keys.
- **The `@ts-expect-error` guards only fire where `tsc` runs.** They are now in the root
  `check` chain, but a developer running only `yarn build && yarn test` in the package will
  still get partial coverage from ts-node's type-checking loader, not the full program.
