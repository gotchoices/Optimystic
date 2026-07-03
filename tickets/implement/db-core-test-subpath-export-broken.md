----
description: Move TestTransactor into the published src/ tree so the ./test subpath export resolves for registry installs.
prereq:
files: packages/db-core/src/testing/test-transactor.ts, packages/db-core/package.json, packages/db-core/test/*.spec.ts
difficulty: easy
----

## What was done

`packages/db-core/package.json` exported `"./test"` pointing at `dist/test/test-transactor.js`, but `files` excluded `dist/test` with `"!dist/test"`. Any consumer installing from a registry got a broken import.

**Fix applied:**

1. Moved `test/test-transactor.ts` → `src/testing/test-transactor.ts`
   - Updated internal imports: `../src/index.js` → `../index.js`, `../src/transform/index.js` → `../transform/index.js`
2. Updated `package.json` `"./test"` export target:
   - `dist/test/test-transactor.*` → `dist/src/testing/test-transactor.*`
3. Updated 9 spec files in `test/` that imported `'./test-transactor.js'` → `'../src/testing/test-transactor.js'`
4. Deleted the old `test/test-transactor.ts`

**Verified:**
- `yarn build` exits 0
- `dist/src/testing/test-transactor.js` exists
- `yarn pack --dry-run` lists `dist/src/testing/test-transactor.js` in the tarball
- `yarn test` → 1136 passing, 0 failing

`demo/src/run.ts` required no change — it still imports `@optimystic/db-core/test` (the export key is unchanged; only the target file moved).
----
