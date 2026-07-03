----
description: Review fix that moved TestTransactor into src/testing/ so the ./test subpath export is included in published registry installs.
files: packages/db-core/src/testing/test-transactor.ts, packages/db-core/package.json, packages/db-core/test/*.spec.ts
----

## What was done

`packages/db-core/package.json` exported `"./test"` pointing at `dist/test/test-transactor.js`, but `files` excluded `dist/test` via `"!dist/test"`. Any consumer installing from a registry got a broken subpath import.

**Changes:**
- Moved `test/test-transactor.ts` → `src/testing/test-transactor.ts`
- Updated internal imports within that file (`../src/index.js` → `../index.js` etc.)
- Updated `package.json` `"./test"` export targets to `dist/src/testing/test-transactor.*`
- Updated 9 spec files in `test/` that imported `'./test-transactor.js'` → `'../src/testing/test-transactor.js'`
- Deleted old `test/test-transactor.ts`

**Verification done by implementer:**
- `yarn build` exits 0
- `dist/src/testing/test-transactor.js` present
- `yarn pack --dry-run` lists the file in tarball
- `yarn test` → 1136 passing, 0 failing

## Use cases for review

- Import `@optimystic/db-core/test` from a consumer package — confirm the export resolves and ships in tarball
- Spec files in `packages/db-core/test/` that use `TestTransactor` — confirm no import breakage
- Check that `src/testing/test-transactor.ts` internal imports use correct relative paths (no leftover `../src/` prefix)
- Confirm `package.json` `files` field now includes `dist/src/` without explicit exclusion of `dist/src/testing/`

## Review findings

No known gaps. Straightforward mechanical relocation; scope is narrow.
