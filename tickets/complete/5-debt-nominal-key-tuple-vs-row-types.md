description: Two kinds of value list — a whole table row, and a short list holding just the key columns — used to be the same plain-array type, so passing one where the other was expected compiled fine and silently produced the wrong storage key. Each now has its own distinct type, so the mix-up is a compile error.
files: packages/quereus-plugin-optimystic/src/schema/key-tuples.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/key-tuple-types.spec.ts, packages/quereus-plugin-optimystic/test/key-encoding.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts, package.json, AGENTS.md, docs/releasing.md, docs/internals.md
----

## What shipped

Three differently-addressed value lists reach the Optimystic virtual table's key-building
code, and they are not interchangeable:

- a **full row** — one cell per table column, addressed by column position (`row[pkDef[i].index]`);
- a **primary key tuple** — one cell per primary-key column, in key order, addressed
  positionally (`tuple[i]`); this is what `UpdateArgs.oldKeyValues` carries and what a point
  lookup's seek arguments are;
- an **index column tuple** — one cell per index column, in index order, possibly a leading prefix.

All three were plain `SqlValue[]`, so handing a method the wrong one compiled, ran, and returned
a *wrong but perfectly valid* tree key. Two shipped bugs came from exactly that. The two tuple
shapes are now distinct nominal (branded) types.

### Source

- **`src/schema/key-tuples.ts` (new).** `PrimaryKeyTuple` and `IndexColumnTuple` as branded
  `readonly SqlValue[]`. Two halves: `readonly` blocks a tuple from reaching a `Row` parameter
  (quereus's `Row` is mutable `SqlValue[]`), and the phantom brand blocks a row — or a bare array
  literal — from reaching a tuple parameter, and keeps the two tuple kinds apart. `Row` itself is
  deliberately not branded. The brand is type-only; no runtime cost. Also declares
  `UnbrandedValues` (added during review — see findings), the constructors' input type, which
  refuses an already-branded array.
- **`src/schema/row-codec.ts`.** `asPrimaryKeyTuple(values)` is the only way to obtain a
  `PrimaryKeyTuple`, validating arity (empty allowed, for a singleton table's empty PK).
  `createPrimaryKey` narrowed to take `PrimaryKeyTuple`, keeping its length check as
  belt-and-braces. `extractPrimaryKey(row: Row)` unchanged, full-row runtime guard kept.
- **`src/schema/index-manager.ts`.** `indexKeyFromValues(values)` is the single place an
  index-style key is assembled (serialize each value, then frame). `createIndexKey` (row-shaped),
  `createIndexKeyFromTuple` (tuple-shaped), and the vtab's `uniqueKeyFor` all route through it, so
  they are byte-identical by construction rather than by three hand-maintained copies.
  `asIndexColumnTuple(indexSchema, values)` validates `0 < length <= index width`.
- **`src/optimystic-module.ts`.** `executePointLookup` routes seek args through
  `asPrimaryKeyTuple`. `executeIndexScan` replaces its inline copy of the framing formula with
  truncate → `asIndexColumnTuple` → `createIndexKeyFromTuple`. `update()` no longer destructures
  `oldKeyValues`; the UPDATE and DELETE cases each bind only the branded `oldKeyTuple`, converted
  inside the case so error ordering relative to the guards and `addStatement` is unchanged.
  `requirePreWriteRow` takes `PrimaryKeyTuple`. The long prose comments at the two DML sites — which
  existed because the compiler could not express the hazard — are cut to one pointer line each.
- **`src/index.ts`.** Re-exports the tuple types.
- **Root `package.json`.** New `typecheck` script fanning out over workspaces, inserted into `check`
  as `lint && build && typecheck && test && test:integration`. It must stay after `build`: several
  specs import `../dist/index.js`, whose `.d.ts` only exists post-build.

### Tests

- `test/key-tuple-types.spec.ts` (new) — 11 `@ts-expect-error`-annotated forbidden calls in a
  never-invoked function, plus runtime assertions that the brands are type-only, that the two
  index-key entry points are byte-identical (full width, prefix, NULL-vs-empty-string, numeric
  `toExponential` form), and that the zero-width key brackets the whole index.
- `test/oldkeyvalues-compact-shape.spec.ts` — the equal-length blind spot end-to-end over real file
  storage: `create table R (a text, b text, primary key (b, a))`, move a key column via UPDATE,
  reopen, DELETE, reopen.
- `test/row-codec.spec.ts` — `asPrimaryKeyTuple` arity cases; the rotated all-column pair asserted to
  produce *different* keys, so the swap is corruption rather than a no-op. Existing call sites
  rewrapped in `asPrimaryKeyTuple`; no assertion weakened or removed.
- `test/key-encoding.spec.ts` — golden on-disk bytes (added during review — see findings).

## Review findings

### What was checked

Read the implement diff (`308f55a`) before the handoff summary. Then: every call site of
`createPrimaryKey` / `extractPrimaryKey` / `createIndexKey` / `indexKeyFromValues` /
`asPrimaryKeyTuple` / `asIndexColumnTuple` across all packages; the reachability of the
`executeIndexScan` zero-argument path through `runQuery`'s plan dispatch; byte-equivalence of the
three consolidated key-framing formulas against their pre-change forms; whether the type-level guards
are real rather than decorative; whether `yarn typecheck` actually gates; and every doc that
describes the `yarn check` chain or the vtab key path.

### Verified rather than assumed

- **The compile-time guards are non-vacuous.** Deleted every `@ts-expect-error` directive from
  `key-tuple-types.spec.ts` and re-ran `tsc --noEmit`: exactly 11 `error TS2345` lines, one per
  guard, each naming the intended reason. File restored; clean afterwards.
- **`yarn typecheck` gates from the repo root.** Injected `const _probe: number = "not a number"`
  into `key-tuples.ts`; root `yarn typecheck` reported `error TS2322` and exited 1. Reverted.
  (It prints nothing on success, which reads like a no-op — hence the probe.)
- **`tsc --noEmit` covers the specs**, not just `src`: `--listFilesOnly` shows 47 files under
  `test/` in the program (`tsconfig.json` has `include: ["src", "test"]`).
- **The zero-argument index scan is genuinely reachable**, as the handoff asked. `runQuery` guards
  `args.length > 0` only for the point-lookup arm; the legacy `idxNum >= 10` arm sets an index
  target with no such guard, so an index-served scan with `argc === 0` reaches
  `executeIndexScan`. Bypassing `asIndexColumnTuple` there (rather than letting it accept empty) is
  the right call — the constructor's rejection of an empty tuple is what stops a caller from
  *accidentally* ranging over a whole index, and this site does so deliberately. Behaviour is
  byte-identical to the pre-change code (`encodeKeyTuple([])` → `''`).
- **No key bytes moved.** `indexKeyFromValues(values)` expands to exactly the previous
  `encodeKeyTuple(values.map(serializeIndexValue))` at all three former sites; `serializeIndexValue`
  already mapped `undefined` to `null`, so the added `?? null` changes nothing. The new golden-byte
  assertions (below) pass against the shipped encoder.

### Minor findings — fixed in this pass

- **The documented re-branding hole is now closed.** The handoff listed "tuple-to-tuple re-branding
  is not blocked" as a known gap: `asPrimaryKeyTuple(values: readonly SqlValue[])` accepted an
  `IndexColumnTuple`, so the two kinds could be laundered into each other *through the very site*
  meant to be the audit point, and arity only catches that when the widths differ. Added
  `UnbrandedValues = readonly SqlValue[] & { readonly __tupleBrand?: never }` in `key-tuples.ts` and
  narrowed both constructors to it. A `Row`, a bare literal, and an unbranded `readonly SqlValue[]`
  all still satisfy it; either branded tuple now fails on the property's type. Three new
  `@ts-expect-error` guards cover it, plus two positive assertions that the constructors did not
  become unusable. The brand-minting casts widen through `readonly SqlValue[]` first, with a comment
  at each of the two sites saying why.
- **Golden on-disk bytes were missing.** Every assertion in `key-encoding.spec.ts` was either
  relational (distinct / correctly ordered) or a round-trip through the same module, so a
  coordinated change to encoder *and* decoder would keep the suite green while making every
  persisted database unreadable — these strings are the tree keys. Added an
  `on-disk format (literal bytes)` block pinning `encodeKeyElement(null)`, the empty payload, the
  `\x00\xff` escape, the empty tuple, and `KEY_PREFIX_END`. This closes the handoff's "no test
  asserts stored key bytes are unchanged" gap.
- **The zero-argument index-scan bypass had no test.** Added one asserting
  `indexKeyFromValues([]) === ''`, that it prefixes a full index key, and that it sorts below
  `KEY_PREFIX_END` — so `[key, key + END)` really does bracket the entire index rather than an empty
  range.
- **Doc rot from the new `check` step.** `docs/releasing.md` (step table and release checklist) and
  `AGENTS.md` both still described `yarn check` as lint + build + test + test:integration. Updated
  both, and recorded *why* `typecheck` exists as a separate step and why it must follow `build`.
- **`docs/internals.md` had no entry for the class of bug this ticket exists to retire.** Added
  *Common Pitfalls #7 — A Full Row Where a Key Tuple Belongs*, in the existing
  bug/symptom/fix/enforced-by form, next to the other invariants that are enforced by a spec. Two
  shipped bugs came from this substitution; the file is where a maintainer looks for exactly that.

### Major findings — none

No defect was found that warrants a new ticket. The one substantive gap in the implementation (the
re-branding hole) was closable in-place at the type level — rung 1 of the ladder, making the bad
state unrepresentable — so filing an instance ticket would have been the wrong disposition.

### Evidence appended to an existing ticket

`tickets/backlog/debt-optimystic-key-format-migration.md` claims the same three files. Appended a
section noting that literal golden bytes now pin the on-disk format, so the *next* accidental
format change fails a test instead of shipping silently. That does not answer that ticket's open
question (whether pre-existing databases need a migration path) — it only narrows how the problem
can recur.

### Tripwires — parked, not filed

- **`yarn typecheck` on a clean tree fails for the wrong reason.** The two tsup-built packages' specs
  import their own `dist/`, so without a prior `yarn build` the run dies on unresolved modules rather
  than on real type errors. Fine inside `check`, which orders them correctly; only bites someone
  running `typecheck` standalone after `yarn clean`. Parked as prose in `docs/releasing.md` and
  `AGENTS.md` — it is a build-ordering fact with no single code site.
- **Seek arguments are protected by arity only, not by types.** Quereus hands over
  `readonly unknown[]`, so nothing type-checks that `filterInfo.args` is really key-ordered; only its
  length is checked. This is inherent to the engine boundary — the brand necessarily *starts* at the
  constructor — and cannot be closed from inside this repo. Already described in `key-tuples.ts`'s
  header prose.

### Considered and left alone

- **`asIndexColumnTuple` is an instance method that never touches `this`** (it takes the index schema
  as a parameter). Making it static would be marginally cleaner but churns every call site for no
  behavioural gain.
- **`indexKeyFromValues` is exported taking unbranded values**, which technically bypasses
  `createIndexKeyFromTuple`. It is the low-level shared core, is not re-exported from the package
  barrel, and its four callers are all legitimate — narrowing it would just push the cast elsewhere.
- **`createIndexKeyFromTuple` is a one-line pass-through.** It exists to give the branded shape its
  own entry point; the indirection is the point.
- **`scanIndexRange` remains uncovered with no production caller** — pre-existing, already carries a
  `NOTE:` in `index-manager.ts`, and does not route through `indexKeyFromValues` (it takes
  already-built keys). Out of scope here.

### Correction to the handoff

The handoff stated that before this change "nothing in `check` ever type-checked". That is true only
of the two packages that build with **tsup/esbuild** (`quereus-plugin-optimystic`,
`quereus-plugin-crypto`) — the other nine build with `tsc`, so `yarn build` has always type-checked
them. Those two are exactly the packages that gained a `typecheck` script, so coverage is in fact
complete; only the stated reasoning was too broad. No action needed; recorded so a future reader does
not go looking for nine missing scripts.

## Validation

From `packages/quereus-plugin-optimystic`, after all review edits:

- `npx tsc --noEmit` — 0 errors.
- `yarn test` — **443 passing, 11 pending, 0 failing**, smoke ok.
- `yarn test:integration` — **446 passing, 8 pending, 0 failing**, smoke ok.

From the repo root:

- `yarn lint` — clean (all packages).
- `yarn build` — success.
- `yarn typecheck` — 0 errors.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written. Root `yarn test`
/ `yarn test:integration` across all eleven packages were not re-run: the only source changes are
confined to `quereus-plugin-optimystic`, and the remaining edits are Markdown.
