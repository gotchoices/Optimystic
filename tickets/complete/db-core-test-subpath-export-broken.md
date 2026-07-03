description: Fixed the `@optimystic/db-core/test` import so it ships in published packages instead of being silently excluded.
files: packages/db-core/package.json, packages/db-core/src/testing/test-transactor.ts, packages/db-core/test/*.spec.ts, docs/optimystic.md

## What was done

`packages/db-core/package.json` exported `"./test"` pointing at `dist/test/test-transactor.js`, but the `files` allowlist excluded `dist/test` via `"!dist/test"`. Any consumer installing from a registry got a broken subpath import.

**Fix (commit `77fa307`):**
- Moved `test/test-transactor.ts` → `src/testing/test-transactor.ts` (git rename; internal imports rewritten `../src/index.js` → `../index.js`, `../src/transform/index.js` → `../transform/index.js`)
- Repointed `"./test"` export to `dist/src/testing/test-transactor.*`
- Updated 9 files in `test/` (8 specs + `simulation.ts`) importing `'../src/testing/test-transactor.js'`
- Deleted old `test/test-transactor.ts`

## Review findings

**Verified (all green):**
- **Build** — `yarn build` in db-core exits 0; `dist/src/testing/test-transactor.{js,d.ts,js.map,d.ts.map}` all present.
- **Tests** — `yarn test` → 1136 passing, exit 0.
- **Tarball** — `yarn pack --dry-run` lists `dist/src/testing/test-transactor.js` (+ `.d.ts`, maps, raw `src/testing/test-transactor.ts`). No `dist/test/*` leaks in; `!dist/test` exclusion is still valid (keeps compiled specs out).
- **`files` field** — ships `src` + `dist`; only `dist/test` excluded, so `dist/src/testing/` is included. Correct.
- **Internal imports** — moved file uses correct relative paths (`../index.js`, `../transform/index.js`); no leftover `../src/` prefix.
- **Spec imports** — all 9 `test/` importers point at `'../src/testing/test-transactor.js'`; no breakage; old file confirmed deleted.
- **Real consumer** — `packages/demo` (`src/run.ts`, `test/message-app.spec.ts`) imports `@optimystic/db-core/test`. `npx tsc --noEmit` on demo exits 0 — the moved export resolves for an actual downstream package.
- **Lint** — `eslint` on moved file + a spec exits 0.

**Found & fixed inline (minor):**
- `docs/optimystic.md:74` referenced `@optimystic/db-core/test-transactor.js` — a subpath that has never existed (the export is `./test`, not `./test-transactor.js`). Pre-existing doc error in the area this change touches; corrected to `@optimystic/db-core/test`.

**Major findings:** none. Scope is a narrow mechanical relocation.

**Tripwires:** none. The `!dist/test` glob is now only guarding compiled specs rather than the transactor, but it remains correct and harmless — no future condition trips it.
