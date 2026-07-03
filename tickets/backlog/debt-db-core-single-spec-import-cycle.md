description: Running any single db-core test file on its own crashes before the tests start, due to a module load-order problem; you have to run the whole test suite at once to work around it.
files: packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/index.ts, packages/db-core/src/collection/index.js (barrel)
difficulty: medium
----
## Problem

In `packages/db-core`, loading a **single** spec file, e.g.

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/collection.spec.ts" --reporter min
```

crashes before any test runs:

```
Exception during run: ReferenceError: Cannot access 'collectionTypes' before initialization
    at registerCollectionType (packages/db-core/src/collection/collection-type-registry.ts:4:5)
    at packages/db-core/src/collections/diary/diary.ts:41:1
```

(The stack line numbers drift with edits; the identifier `collectionTypes` and the two files are the stable markers.)

The full-suite glob used for validation —
`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"` — does **not**
hit this, because loading many files first evaluates a module that initializes the registry
before `diary.ts` runs. So the failure only bites when a developer tries to run one spec in
isolation (a normal thing to do while iterating on a single test).

## Root cause

A barrel-file circular import with a temporal-dead-zone (TDZ) hazard:

- `diary.ts` imports `registerCollectionType` from the package barrel (`../../index.js`) and,
  at **module-evaluation time** (top-level statement, currently near line 50), calls
  `registerCollectionType({ ... })`.
- `collection-type-registry.ts` declares `const collectionTypes = new Map()` at module scope,
  and `registerCollectionType` closes over it.
- The barrel re-exports both modules. Depending on which spec is the entry point, the loader
  can evaluate `diary.ts` (and thus invoke `registerCollectionType`) **before** the
  `const collectionTypes` initializer has run. Accessing a `const`/`let` in its TDZ throws
  `Cannot access 'collectionTypes' before initialization`.

This is deterministic for the single-file entry order — a real latent defect on that path, not
a flake.

## Expected behavior

Any single db-core spec file can be run on its own without a load-order crash.

## Notes / possible directions (for the implementer to weigh, not prescriptive)

- Make registration not depend on module-eval order: e.g. lazy-initialize the `collectionTypes`
  map (function-local `static`/getter, or initialize on first `registerCollectionType`/`getCollectionType`
  call) so it cannot be observed in its TDZ.
- Or break the barrel cycle: have `diary.ts` import `registerCollectionType` directly from
  `../../collection/collection-type-registry.js` instead of through the package barrel.
- Or move the side-effecting `registerCollectionType(...)` call out of module top-level into an
  explicit registration step.

Pre-existing; unrelated to the collection-conflict-replacement-discarded change that surfaced it.
Low urgency (workaround: run the full glob) but it degrades the single-file test iteration loop.
