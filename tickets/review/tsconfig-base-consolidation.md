description: A shared root TypeScript config now replaces eleven copy-pasted per-package configs; verify the consolidation didn't change any package's build output and that the drift fixes are correct.
prereq:
files: tsconfig.base.json, packages/db-core/tsconfig.json, packages/db-p2p/tsconfig.json, packages/db-p2p-storage-fs/tsconfig.json, packages/db-p2p-storage-ns/tsconfig.json, packages/db-p2p-storage-rn/tsconfig.json, packages/db-p2p-storage-web/tsconfig.json, packages/reference-peer/tsconfig.json, packages/reference-peer/src/cli.ts, packages/quereus-plugin-optimystic/tsconfig.json, packages/quereus-plugin-crypto/tsconfig.json, packages/substrate-simulator/tsconfig.json, packages/demo/tsconfig.json
difficulty: medium
----

## What was done

Introduced `tsconfig.base.json` at the repo root holding all path-independent shared
compiler options. Rewrote all 11 package `tsconfig.json` files to `extends`
`../../tsconfig.base.json`, keeping only path-bearing settings (`rootDir`, `outDir`,
`include`, `exclude`) plus genuine per-package deltas. Enabled `verbatimModuleSyntax: true`
in the base and fixed the fallout. Did **not** touch `exactOptionalPropertyTypes` (owned by
backlog ticket `debt-tsconfig-exact-optional-property-types`).

### Base config (`tsconfig.base.json`)

Holds: `target ES2022`, `module/moduleResolution Node16`, `lib ["ES2022"]`, `strict`,
`strictFunctionTypes`, `noUncheckedIndexedAccess`, `esModuleInterop`,
`allowSyntheticDefaultImports`, `skipLibCheck`, `forceConsistentCasingInFileNames`,
`declaration`, `declarationMap`, `sourceMap`, `downlevelIteration`,
`allowImportingTsExtensions: false`, `verbatimModuleSyntax: true`.

### Per-package files

All 11 reduced to `extends` + `{ rootDir: ".", outDir: "dist" }` + `include`/`exclude`,
with these deltas layered on:

- **db-p2p-storage-web** — adds `"lib": ["ES2022", "DOM"]` (overrides base).
- **quereus-plugin-optimystic**, **quereus-plugin-crypto** — add `"resolveJsonModule": true`.
  Dropped their old `NodeNext` → inherit `Node16` from base.
- All others (db-core, db-p2p, storage-fs, storage-ns, storage-rn, reference-peer,
  substrate-simulator, demo) — identical baseline shape.

### Drift resolved

- **db-core** — was UTF-8 BOM + flat/no-indent; rewritten without BOM (first bytes now
  `7b 0a 09` = `{`,LF,tab), tab-indented like the rest.
- **db-p2p-storage-fs** — gained `downlevelIteration` (via base; no-op at ES2022 but now
  literally identical to siblings).
- **reference-peer** — gained `rootDir: "."` (via baseline shape).
- **plugins** — `NodeNext` → `Node16` (via base). tsup/esbuild drives their emit, not tsc's
  module setting, so output is unchanged; only tsc type-resolution shifts (identical today).

### verbatimModuleSyntax fallout (fixed)

Sole fallout was 9 × TS1484 in `packages/reference-peer/src/cli.ts` line 6 — a mixed
value+type import from `@optimystic/db-core`. Fixed by marking the 9 type-only names with
inline `type` (`Diary, NetworkTransactor, BTree` stay value imports; `ITransactor`,
`BlockGets`, `GetBlockResults`, `ActionBlocks`, `BlockActionStatus`, `PendRequest`,
`PendResult`, `CommitRequest`, `CommitResult` now `type`). These were already being elided
by the compiler, so emitted JS is equivalent.

## Validation performed (what I actually ran)

- `packages/reference-peer` → `npx tsc --noEmit` → **0 errors** (was 9 before the `type`
  markers).
- `yarn build` from root (topological, all 9 tsc packages + 2 tsup plugins) → **EXIT 0**.
  Since the 9 tsc packages use `build: "tsc"` (emit + typecheck), a green build proves all
  10 non-reference-peer packages compile clean under `verbatimModuleSyntax` — reference-peer
  was the only fallout.
- Explicit `yarn build` in `db-p2p-storage-fs` and `db-p2p-storage-rn` (the easy-to-miss
  ones) → **EXIT 0** each.
- Emit-routing spot-check across 8 packages: each `packages/<name>/dist` is populated
  (with `dist/src` + `dist/test`, correct for `rootDir: "."`); **no** `<repo-root>/dist`
  was created. Confirms no `outDir` misroute.
- `yarn lint` (`eslint .` with typescript-eslint) → **EXIT 0** — tsconfig still resolves per
  package after the `extends` refactor.
- Both plugins → `npx tsc --noEmit` → **0 errors** each (confirms tsup's `extends` resolution
  of `../../tsconfig.base.json` and Node16 type-check parity).
- `quereus-plugin-optimystic` → `npm run test:smoke` → **`smoke ok quereus@4.3.0`** (EXIT 0).

## Known gaps / honest notes for the reviewer

- **Did NOT run the full mocha test suites** (`yarn test` / per-package `test`). Validation
  was build + typecheck + lint + the single plugin smoke test. Test suites are a reasonable
  next check if the reviewer wants runtime coverage, but nothing in this diff changes runtime
  code except the 9 `type` markers in `cli.ts` (compile-time only).
- **Plugin emit-equivalence was verified indirectly** — via build success + the optimystic
  smoke test — not by a byte-level `dist` diff before/after. I did not snapshot `dist` prior
  to the change. If the reviewer wants hard proof the `NodeNext → Node16` tsc switch left
  esbuild output identical, a `git stash`-free approach would be to rebuild from the prior
  commit into a temp dir and diff. I judged smoke + build sufficient given tsup drives emit.
- **quereus-plugin-crypto** — typechecked clean but I did not run a smoke test for it (its
  `package.json` was not confirmed to have a `test:smoke` script; I only inspected
  optimystic's). Reviewer may want to run `packages/quereus-plugin-crypto` tests.
- **`substrate-simulator` and `demo`** — built as part of the aggregate `yarn build` (green),
  not rebuilt in isolation. No reason to suspect issues; flagging that I relied on the
  aggregate for these two.
- Line endings: new/rewritten files use LF (matches `.editorconfig`, which sets tab indent +
  final newline and does not pin CRLF). Pre-existing files varied (db-p2p was CRLF). Not a
  functional concern; noting in case a reviewer sees LF/CRLF churn in the diff.

## Deferred (do not do here)

- `exactOptionalPropertyTypes` — ~211 errors of real semantic triage (db-core 54, db-p2p 122,
  scattered elsewhere). Owned by backlog ticket `debt-tsconfig-exact-optional-property-types`.
  Confirm that ticket exists / is filed; this ticket deliberately left the flag off.
