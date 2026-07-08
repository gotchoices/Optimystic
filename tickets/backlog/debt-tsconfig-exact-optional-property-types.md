description: Turn on a stricter TypeScript setting that catches a class of subtle optional-property bugs, and fix the roughly two hundred type errors it surfaces across the packages.
prereq: tsconfig-base-consolidation
files: tsconfig.base.json, packages/db-core, packages/db-p2p, packages/quereus-plugin-optimystic, packages/substrate-simulator
----

## What

Enable `exactOptionalPropertyTypes: true` in the shared `tsconfig.base.json` (created by
the `tsconfig-base-consolidation` ticket) and triage the resulting type errors.

`exactOptionalPropertyTypes` makes TypeScript distinguish "this property may hold `undefined`"
(`x?: T` where `T` includes `undefined` is required to be explicit) from "this property may be
absent". Without it, assigning `undefined` to an optional property and omitting the property
are treated the same; with it, they are not — which catches real bugs where code assumes a
key is present because it was set to `undefined`.

## Why this is its own ticket

Enabling the flag was deliberately kept **out** of the tsconfig consolidation because the
fallout is large and requires per-site semantic judgement, not a mechanical sweep. Measured
error counts with the flag on (TS 5.9.3, `tsc --noEmit` per package):

| package | errors |
|---|---|
| db-p2p | 122 |
| db-core | 54 |
| quereus-plugin-optimystic | 25 |
| substrate-simulator | 6 |
| reference-peer | 2 |
| db-p2p-storage-rn | 1 |
| demo | 1 |
| others | 0 |
| **total** | **~211** |

Each site needs a real decision: widen the type to `T | undefined`, stop assigning `undefined`
(delete the key or use a conditional spread), or narrow before use. Some will reveal genuine
latent bugs. This is not a find-and-replace.

## Scope / expectations

- Turn on `exactOptionalPropertyTypes` in `tsconfig.base.json`.
- Drive every package to a clean `tsc` build (and clean tsup build for the plugins).
- Where a fix reveals a behavior question (was the code relying on `undefined`-vs-absent?),
  resolve it correctly rather than blanket-widening every type to `| undefined` — blanket
  widening defeats the point of the flag.
- The bulk of the work is db-p2p and db-core; consider splitting into per-package fix tickets
  if a single agent run cannot cover all ~211 sites well.

## Notes

- Depends on `tsconfig-base-consolidation` landing first (the base file must exist).
- `verbatimModuleSyntax` is already enabled by the consolidation ticket — not in scope here.
