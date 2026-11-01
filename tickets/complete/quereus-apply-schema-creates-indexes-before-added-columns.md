description: A schema upgrade may now add a column and an index on that column in one version, because the Quereus release we now require creates new indexes after it adds columns; the documented workaround is gone.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json, yarn.lock, packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts, packages/quereus-plugin-optimystic/README.md, .release-notes.pending.md, packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts
----
# Adopt Quereus 4.20.3: `apply schema` creates indexes after added columns

Quereus 4.20.3 (quereus 012c09757) emits `apply schema`'s index creates after the per-table alter block, and keeps `DROP INDEX` ahead of it, so one schema version can add a column and an index on it, or drop both. Before, the index was created first and the apply failed with `Column 'b' not found`.

## What landed

- Every `@quereus/quereus` range moved `^4.20.1` → `^4.20.3`: both Quereus plugins' dev and peer ranges and `engines.quereus` (kept equal, as `yarn.config.cjs` requires), plus `rn-bundle-check` and `upgrade-check`; `yarn.lock` updated. The root manifest portal-links the sibling `quereus` checkout, which is at 4.20.3.
- `src/transaction/quereus-version.ts` regenerated (`QUEREUS_VERSION` 4.20.3).
- README Limitations: the "creates a new index before it adds the columns" bullet removed; the column-upgrade paragraph now says a version may add a column and an index on it, or drop both.
- `.release-notes.pending.md`: the column-ALTER paragraph and the Dependencies bullet describe the fix.
- Test in `alter-table-arms.spec.ts`: "one version may add a column and an index on it: the index is maintained and both survive a restart".

## Review findings

Checked: the implement diff (`ticket(implement): quereus-apply-schema-creates-indexes-before-added-columns`) file by file; every `@quereus/quereus` range in the repo (all six at ^4.20.3, root is a portal to 4.20.3); remaining mentions of the old gap across tracked markdown and source (none left; the `4.20.2` strings in `upgrade-check/fixtures/*` are recorded release data and correctly unchanged; the `4.20.1` comment in `optimystic-module.ts` refers to an unrelated memory-module behaviour); Quereus's `schema-differ.ts` ordering, to confirm the README claim.

Found and fixed inline (minor):
- The new test's `verifyIndexes` loop would pass vacuously if the report list came back without the new index; it now asserts the reports include `t_b` before checking missing/orphaned entries.
- Release notes Dependencies list: the middle sub-bullet ended with a period although another item followed; changed to a semicolon to match the list.
- README: removing the Limitations bullet also dropped its "dropping an index together with its column works" fact and left no positive statement of the new capability; added one sentence to the column-upgrade paragraph, verified against Quereus's differ (creates after the alter block, `DROP INDEX` before it).

Tests: the one test added pins the contract this ticket exists for (column + index in one apply, index maintained, survives restart); kept. No tests cut — none restate implementation.

Major findings / tickets: none — the change is a dependency bump plus documentation; no code path in this repo changed.

Tripwires: none raised.

Validation run (this pass): `yarn test` in `quereus-plugin-optimystic` — 1053 passing, 14 pending, 0 failing, smoke ok on quereus@4.20.3; `yarn lint:docs`, `yarn lint:deps`, `yarn typecheck` green; `yarn check:rn` passed (Metro bundle + hermesc compile), which the implement pass had left unrun. Not run: `yarn test:integration` (unaffected by a range bump and docs).
