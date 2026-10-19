description: A schema upgrade may now add a column and an index on that column in one version, because the Quereus release we now require creates new indexes after it adds columns; the documented workaround is gone.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json, yarn.lock, packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts, packages/quereus-plugin-optimystic/README.md (Limitations), .release-notes.pending.md, packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts
----
# Adopt Quereus 4.20.3: `apply schema` creates indexes after added columns

Quereus 4.20.3 (quereus 012c09757) emits `apply schema`'s index creates after the per-table alter block, so one schema version can add a column and an index on it. Before, the index was created first and the apply failed with `Column 'b' not found`.

## What changed here

- Every `@quereus/quereus` range moved `^4.20.1` → `^4.20.3`: both Quereus plugins' dev and peer ranges and `engines.quereus` (kept equal, as `yarn.config.cjs` requires), plus `rn-bundle-check` and `upgrade-check`. `yarn install` updated `yarn.lock`; `yarn lint:deps` green.
- Rebuilding the optimystic plugin regenerated `src/transaction/quereus-version.ts` (`QUEREUS_VERSION` 4.20.2 → 4.20.3); without it the `QuereusEngine` "Engine ID" spec fails.
- README Limitations: removed the "creates a new index before it adds the columns" bullet.
- `.release-notes.pending.md`: the column-ALTER paragraph's "Known gap … index before columns" sentence now says a version may add a column and an index on it together; the Dependencies bullet now names ^4.20.3, says the plugins require 4.20.3, and lists the index-order fix beside the two earlier engine fixes.

## Test added

- `alter-table-arms.spec.ts` → "one version may add a column and an index on it: the index is maintained and both survive a restart": V1 table with a row, then one `apply schema` adding nullable `b` plus `index t_b on t (b)`; an index-driven read finds the new row; a hydrate-only restart sees the column, a new row is found through the index, and `verifyIndexes` reports no missing or orphaned entries.

## Validation run

- `yarn test` in `quereus-plugin-optimystic`: 1053 passing, 14 pending, 0 failing.
- `quereus-plugin-crypto` build + test: 125 passing.
- `yarn typecheck`, `yarn lint:docs`, `yarn lint:deps`: green.
- `upgrade-check` test: 101 passing.
- Not run: full `yarn check` (integration tests, `check:rn`). The range bump touches the `rn-bundle-check` manifest only; a reviewer may want `yarn check:rn`.
