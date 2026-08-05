description: Fixed a module load-order bug in db-core that made three test files crash instantly when run alone (they only worked as part of the whole suite), and added a permanent guard so the bug class can't come back.
files: packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collections/diary/struct.ts, packages/db-core/src/collections/tree/struct.ts, packages/db-core/test/registrar-import-cycle.spec.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/blocks/block-types.ts
----

## What was wrong

Three db-core spec files (`test/collection.spec.ts`, `test/invalidation-client.spec.ts`,
`test/read-view-pinned.spec.ts`) crashed before any test ran when launched standalone:

```
ReferenceError: Cannot access 'collectionTypes' before initialization
```

Root cause: `src/collections/diary/diary.ts`, `src/collections/diary/struct.ts`, and
`src/collections/tree/struct.ts` imported `registerCollectionType`/`registerBlockType`
through the package root barrel (`../../index.js`) instead of directly from the modules that
define them. When a spec's first import happened to reach a subtree the root barrel also
re-exports, the loader's cycle handling skipped the barrel's re-export of that subtree — so the
registry module's `const collectionTypes = new Map()` never ran before a top-level
`registerCollectionType(...)` call touched it (temporal-dead-zone `ReferenceError`). Full trace
in the original implement ticket if needed.

Full details, the confirmed import trace, and the six-module comparison table (three modules
already importing directly and never crashing vs. three importing through the barrel) are in the
implement-stage ticket text — not reproduced here since the fix is small and this ticket carries
the outcome, not the investigation.

## What changed

Three import fixes — each swaps a root-barrel import of a registrar function for a direct
import from the defining module:

- `diary.ts`: `registerCollectionType` now imported from
  `../../collection/collection-type-registry.js` (was `../../index.js`).
- `diary/struct.ts`: `registerBlockType` now imported from `../../blocks/block-types.js` (was
  `../../index.js`).
- `tree/struct.ts`: same two-function split, plus its remaining root-barrel names
  (`BlockId`, `CollectionHeaderBlock`) converted to `import type` so that edge is erased
  entirely (nothing runtime-imports the root barrel from this file anymore).

This works because `collection-type-registry.ts` and `block-types.ts` have **zero runtime
imports** (only `import type`) — a module with no runtime imports can never be mid-evaluation
when something imports it, so a direct import always sees its module-scope `Map` already
initialized.

New guard test: `packages/db-core/test/registrar-import-cycle.spec.ts`, modeled on the existing
`test/no-fret-import.spec.ts` pattern (regex-based import scan + self-tests proving the
detector fires). Two real assertions:

1. No file under `packages/db-core/src/` imports `registerBlockType` or
   `registerCollectionType` (as a runtime import) from a root-barrel specifier
   (`../index.js`, `../../index.js`, etc.).
2. `collection-type-registry.ts` and `block-types.ts` have zero runtime imports (only
   `import type` allowed) — this is the invariant the whole fix depends on, so it's asserted
   directly rather than left implicit.

Plus two self-test cases proving the detector actually flags violations (multi-name,
multi-line forms) and doesn't false-positive on allowed patterns (subtree-barrel imports,
`import type`, unrelated root-barrel imports).

## How this was tested / how to re-verify

From `packages/db-core`:

```bash
# the three specs that used to crash standalone — now pass
for f in test/collection.spec.ts test/invalidation-client.spec.ts test/read-view-pinned.spec.ts; do
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "$f" --reporter min
done

# guard spec itself
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/registrar-import-cycle.spec.ts" --reporter min

# full suite + typecheck
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min
npx tsc --noEmit -p tsconfig.json
```

Results during implement:

- All 3 previously-crashing specs: pass standalone.
- Swept **all 78** spec files standalone (`for f in $(find test -name '*.spec.ts')`), grepping
  output for `"before initialization"` — zero hits.
- Full suite: **1357 passing** (1353 baseline + 4 new guard-spec tests).
- `tsc --noEmit`: clean, no output/errors.
- Guard sanity check: manually reverted `diary/struct.ts`'s import back to the root barrel,
  reran `registrar-import-cycle.spec.ts` — first assertion failed with a clear message naming
  the file and specifier. Restored the fix, reran — green again (4 passing).

## Gaps / things the reviewer should know

- No process-spawn-per-spec guard was added (i.e. nothing that actually launches `node` once
  per spec file to prove standalone loading at the process level). The ticket explicitly called
  this out as too slow for the unit suite (78 process spawns) and asked for a source-scan guard
  instead — that's what's here. The 78-file standalone sweep above was a manual one-time
  verification during implement, not something CI re-runs automatically. If a future change
  reintroduces a *different* import-cycle shape that this specific regex doesn't model, the
  standalone-crash symptom could in theory resurface without the guard catching it — the guard
  covers the exact class described in the ticket (registrar functions pulled through the root
  barrel), not import cycles in general.
- The guard's import-parsing regex (`IMPORT_RE` in the new spec) handles named-import clauses
  (`import { a, b } from '...'`) including multi-line and `import type`. It does not parse
  `export * from` or default imports, but neither registrar is ever re-exported or
  default-exported anywhere in `src/`, so this isn't a current gap — only worth knowing if the
  export style ever changes.
- Considered and declined: lazily initializing the `collectionTypes`/`blockTypes` maps instead
  of fixing imports. Would have hidden the TDZ rather than removing the cycle; noted in the
  original ticket as a fallback if a future change ever forces a runtime import into either
  registry module.
