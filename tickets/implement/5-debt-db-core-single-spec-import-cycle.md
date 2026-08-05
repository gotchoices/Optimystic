----
description: Running certain db-core test files on their own crashes before any test starts, because of a module load-order problem; developers have to run the whole suite to work around it. Fix the load order and add a guard so it cannot come back.
files: packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collections/diary/struct.ts, packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/blocks/block-types.ts, packages/db-core/test/no-fret-import.spec.ts
difficulty: easy
----

## Problem (reproduced)

Three db-core spec files crash before any test runs when launched individually:

```
cd packages/db-core
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/collection.spec.ts" --reporter min
```

```
Exception during run: ReferenceError: Cannot access 'collectionTypes' before initialization
    at registerCollectionType (src/collection/collection-type-registry.ts)
    at src/collections/diary/diary.ts
```

**Measured blast radius.** Every one of the 78 spec files under `packages/db-core/test/` was run
standalone. Exactly 3 crash, all with the same `collectionTypes` error:

- `test/collection.spec.ts`
- `test/invalidation-client.spec.ts`
- `test/read-view-pinned.spec.ts`

The other 75 pass standalone. The full-suite glob (`"test/**/*.spec.ts"`) passes, which is why this
has stayed invisible — it only bites the run-one-spec iteration loop.

## Root cause (confirmed by import trace)

A cycle through the **package root barrel** (`packages/db-core/src/index.ts`) combined with a
side-effecting top-level call, producing a temporal-dead-zone (TDZ) error.

What the three crashing specs share: their first project import reaches **into a subtree that the
root barrel also re-exports** — `../src/collection/index.js` for two of them,
`../src/collections/tree/index.js` for the third. That ordering is what triggers it:

1. The spec imports `src/collection/index.js`. That barrel starts evaluating; its first dependency
   is `collection.ts`.
2. `collection.ts` imports the root barrel `../index.js`, so the root barrel starts evaluating.
3. The root barrel reaches `export * from "./collection/index.js"` (line 6) — but
   `collection/index.js` is **already in progress** from step 1, so the loader skips it. Its child
   `collection-type-registry.js` therefore never gets evaluated, and the module-scope
   `const collectionTypes = new Map()` never runs.
4. The root barrel continues to `export * from "./collections/index.js"` (line 7), which evaluates
   `diary.ts`. Its top-level `registerCollectionType({...})` call runs and touches
   `collectionTypes` — still in its TDZ. `ReferenceError`.

This is deterministic for that entry order, not a flake.

**The distinguishing detail — and the fix.** There are six modules under `src/` that call a
registrar at module-evaluation time. Three already do the right thing and never crash; three do
not:

| Module | Imports registrar from | Safe? |
|---|---|---|
| `src/btree/nodes.ts` | `../blocks/index.js` (owning subtree barrel) | yes |
| `src/btree/tree-block.ts` | `../blocks/index.js` | yes |
| `src/chain/chain-nodes.ts` | `../blocks/index.js` | yes |
| `src/collections/diary/diary.ts` | `../../index.js` (**root barrel**) | **no** |
| `src/collections/diary/struct.ts` | `../../index.js` (**root barrel**) | **no** |
| `src/collections/tree/struct.ts` | `../../index.js` (**root barrel**) | **no** |

Importing the registrar through the root barrel is what drags the call into the cycle. Importing it
from the defining module reaches it directly, outside the cycle.

Why the direct import is genuinely robust and not just a reshuffle: **neither registry module has
any runtime import.** `collection-type-registry.ts` imports only types; `block-types.ts` imports
only a type from `./index.js`. A module with no runtime imports can never be mid-evaluation when
someone imports it, so its module-scope `const` is always initialized before any importer's body
runs. That property is what the fix rests on, so the guard below should assert it.

## Sibling registry: same shape, currently dormant

`src/blocks/block-types.ts` holds `const blockTypes = new Map()` with the identical shape. It does
**not** crash today: nothing under `src/blocks/` imports the root barrel at runtime
(`blocks/helpers.ts` uses `import type`, which is erased), so `blocks/index.js` — the root barrel's
first export — always finishes evaluating before `collections/` is reached. Verified with a probe
entry that deep-imports `src/blocks/index.js`: no crash.

It is one runtime import away from breaking the same way. The guard below covers it, because it
makes every registrar import direct, for both registries.

## Expected behavior

Any single db-core spec file runs standalone without a load-order crash, and a future edit that
reintroduces the hazard fails a test rather than surfacing as a confusing `ReferenceError`.

## Fix — verified end to end

The source change below was applied and fully validated (full suite 1353 passing, `tsc --noEmit`
clean, all 3 crashing specs green), then reverted so this stage lands it properly alongside the
guard test. It is a known-good diff, not a proposal.

`src/collections/diary/diary.ts`:
```ts
import { Collection } from "../../index.js";
import { registerCollectionType } from "../../collection/collection-type-registry.js";
```

`src/collections/diary/struct.ts`:
```ts
import { registerBlockType } from "../../blocks/block-types.js";
```

`src/collections/tree/struct.ts`:
```ts
import type { BlockId, CollectionHeaderBlock } from "../../index.js";
import { registerBlockType } from "../../blocks/block-types.js";
import { registerCollectionType } from "../../collection/collection-type-registry.js";
```

Note the `tree/struct.ts` change also splits the type-only names into `import type`, so the root
barrel edge there is erased entirely.

### Lazy-initializing the maps — considered and not recommended

Making `collectionTypes` / `blockTypes` lazily initialized would also hide the TDZ, but it adds
indirection to both registries to paper over an import-graph problem that the direct import removes
outright. Prefer the direct import plus the guard. If a future change ever forces a runtime import
into one of the registry modules, revisit this.

## Guard test — the durable part

Add a source-scanning guard modeled directly on the existing `test/no-fret-import.spec.ts`, which
already establishes the pattern in this package: scan `src/**/*.ts`, collect import specifiers with
a regex, assert no violations, **and** include self-tests proving the detector actually fires so it
cannot rot into a no-op. Reuse its `importSpecifiers` / `tsFiles` approach.

Two assertions:

- **No registrar is imported through the package root barrel.** For every file under
  `packages/db-core/src/`, if it imports `registerBlockType` or `registerCollectionType` at runtime
  (not `import type`), the specifier must not be a root-barrel path (`../index.js`,
  `../../index.js`, `../../../index.js`, …). Before the fix this flags exactly the three modules in
  the table above; after it, zero.

  Scoping the rule to *any* registrar import — rather than trying to detect whether the call is at
  top level — is deliberate: it avoids a brittle "is this call top-level" heuristic, and a direct
  import is the better style at a non-top-level call site anyway, so a false positive costs nothing.

- **The two registry modules have no runtime imports.** `src/collection/collection-type-registry.ts`
  and `src/blocks/block-types.ts` may use `import type` freely but must have zero runtime import
  statements. This is the property the whole fix depends on; assert it explicitly so a future edit
  that adds a runtime import to either module fails here with a clear message instead of
  resurfacing as a `ReferenceError` in an unrelated spec.

A guard that spawns a process per spec file to prove standalone loading was considered and
rejected — 78 process spawns is far too slow for the unit suite, and the source scan catches the
same class at a fraction of the cost.

## Verification

```bash
cd packages/db-core

# the three that crashed — each must now pass standalone
for f in test/collection.spec.ts test/invalidation-client.spec.ts test/read-view-pinned.spec.ts; do
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "$f" --reporter min
done

# every spec standalone — expect zero "before initialization"
for f in $(find test -name '*.spec.ts' | sort); do
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "$f" --reporter min 2>&1 \
    | grep -q "before initialization" && echo "TDZ-CRASH $f"
done

# full suite + typecheck (baseline before this ticket: 1353 passing, tsc exit 0)
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min 2>&1 | tail -5
npx tsc --noEmit -p tsconfig.json
```

Sanity-check the guard by reverting one of the three imports back to the root barrel and confirming
the new test fails.

## TODO

- Apply the three verified import changes in `collections/diary/diary.ts`,
  `collections/diary/struct.ts`, and `collections/tree/struct.ts`.
- Add the guard spec (suggested `test/registrar-import-cycle.spec.ts`), modeled on
  `test/no-fret-import.spec.ts`: reuse its `importSpecifiers` / `tsFiles` helpers and its
  detector-self-test structure.
- Guard assertion 1: no runtime import of `registerBlockType` / `registerCollectionType` from a
  root-barrel specifier anywhere under `src/`.
- Guard assertion 2: `collection-type-registry.ts` and `block-types.ts` have zero runtime imports.
- Include detector self-tests covering each import form (named, multi-name, multi-line,
  `export ... from`) plus allowed cases (`import type`, subtree-barrel imports such as
  `../blocks/index.js`) so the guard cannot silently stop detecting.
- Confirm the guard fails when one import is reverted to the root barrel, then restore.
- Run the full verification block above; full suite and `tsc --noEmit` must stay clean.
