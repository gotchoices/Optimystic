description: Eleven copy-pasted TypeScript config files have drifted apart across the packages; replace the duplication with one shared root config that every package extends, and fix the drift in the process.
prereq:
files: tsconfig.base.json (new), packages/db-core/tsconfig.json, packages/db-p2p/tsconfig.json, packages/db-p2p-storage-fs/tsconfig.json, packages/db-p2p-storage-ns/tsconfig.json, packages/db-p2p-storage-rn/tsconfig.json, packages/db-p2p-storage-web/tsconfig.json, packages/reference-peer/tsconfig.json, packages/quereus-plugin-optimystic/tsconfig.json, packages/quereus-plugin-crypto/tsconfig.json, packages/substrate-simulator/tsconfig.json, packages/demo/tsconfig.json
difficulty: medium
----

## Goal

Introduce a single `tsconfig.base.json` at the repo root holding the shared compiler
options. Rewrite each package `tsconfig.json` to `extends` it and declare only the
genuinely package-specific settings. Resolve the drift the review found and enable
`verbatimModuleSyntax` in the base (fixing the small fallout). Do **not** enable
`exactOptionalPropertyTypes` — that is deferred to a separate backlog ticket
(`debt-tsconfig-exact-optional-property-types`).

## Current state (why this is safe)

- No package uses project `references`, `paths`, or an alternate `tsconfig.*.json`
  variant. Each config is a flat `compilerOptions` + `include`/`exclude`.
- All 11 packages are ESM (`"type": "module"`), `target: "ES2022"`.
- 9 packages build with `tsc`; the two quereus plugins build with `tsup` (esbuild).
  tsup honors `extends` via TS's config parser, but the tsc `module`/`moduleResolution`
  settings do **not** drive the plugins' emitted output (tsup/esbuild does) — they only
  affect type-check resolution, which is identical between Node16 and NodeNext today.

### Measured drift (the review's items, confirmed)

- `db-core/tsconfig.json` carries a UTF-8 BOM (`EF BB BF`) and is the only config
  written flat (no indentation). Every other config uses tab indentation.
- `db-p2p-storage-fs` omits `downlevelIteration` that its siblings set. (This is a
  no-op at `target: ES2022` — `downlevelIteration` only affects `target < ES2015` —
  but normalize it anyway so the configs are literally identical.)
- `quereus-plugin-optimystic` and `quereus-plugin-crypto` use `module`/`moduleResolution`
  = `NodeNext`; the other 9 use `Node16`. Both also set `resolveJsonModule: true`.
- `reference-peer` omits `rootDir: "."` that every other config sets.
- `db-p2p-storage-web` sets `lib: ["ES2022", "DOM"]`; the others use `["ES2022"]`.

## Decisions (already settled — do not re-open)

**Module resolution → `Node16` in the base.** Rationale: the 9 tsc-emit packages already
use `Node16`, so hoisting `Node16` into the base leaves their emit untouched by
construction (satisfies the "must not change emitted module semantics" constraint with
zero churn). The two plugins emit via tsup, so flipping their tsc setting `NodeNext → Node16`
does not change their output — only type-resolution, which is identical today. `NodeNext`
was the alternative and is semantically equivalent for these ESM packages under TS 5.9;
`Node16` was chosen for zero-churn on the emit-driving packages and version-pinned
reproducibility.

**`verbatimModuleSyntax: true` → enable in the base.** Measured fallout is only 9 errors,
all in `reference-peer`, all "type-only import must be marked `import type`". Fixing them
(adding `type` markers) *restores* the import elision the compiler was already doing, so
emitted JS stays equivalent. All other 10 packages compile clean under the flag (verified).

**`exactOptionalPropertyTypes` → NOT enabled here.** Measured fallout ~211 errors
concentrated in `db-core` (54) and `db-p2p` (122), plus scattered in others. This is real
semantic triage (distinguishing "property may be `undefined`" from "property may be absent")
and must not ride along with a mechanical consolidation. Deferred to backlog ticket
`debt-tsconfig-exact-optional-property-types`.

**`outDir` / `rootDir` / `include` / `exclude` stay in each package's own config.**
TypeScript resolves these path-bearing settings relative to the file that *declares* them.
Hoisting `outDir: "dist"` into the root base would resolve to `<repo-root>/dist` for every
package — wrong. They must remain per-package. Only path-independent `compilerOptions`
belong in the base.

## Target: `tsconfig.base.json` (repo root)

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "Node16",
		"moduleResolution": "Node16",
		"lib": ["ES2022"],
		"strict": true,
		"strictFunctionTypes": true,
		"noUncheckedIndexedAccess": true,
		"esModuleInterop": true,
		"allowSyntheticDefaultImports": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"downlevelIteration": true,
		"allowImportingTsExtensions": false,
		"verbatimModuleSyntax": true
	}
}
```

## Target: per-package `tsconfig.json`

Baseline shape (db-core, db-p2p, storage-fs, storage-ns, storage-rn, substrate-simulator,
demo — all identical). The `extends` path is `../../tsconfig.base.json` (packages live at
`packages/<name>/`):

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"rootDir": ".",
		"outDir": "dist"
	},
	"include": ["src", "test"],
	"exclude": ["node_modules", "dist"]
}
```

Package-specific deltas on top of the baseline shape:

- **db-p2p-storage-web** — add `"lib": ["ES2022", "DOM"]` to its `compilerOptions`
  (overrides the base `["ES2022"]`).
- **reference-peer** — same as baseline (this is where it *gains* the missing `rootDir: "."`).
- **quereus-plugin-optimystic**, **quereus-plugin-crypto** — add `"resolveJsonModule": true`
  to their `compilerOptions` (genuinely package-specific; they import JSON). They inherit
  `Node16` from the base — do not re-declare `module`/`moduleResolution`.
- **db-core** — must be written **without a BOM** and with tab indentation like the rest.

## Edge cases & interactions (write/verify these)

- **BOM removal (db-core):** rewrite via the Write tool (emits UTF-8, no BOM). Confirm the
  first bytes are `7B` (`{`) not `EF BB BF`. Nothing in the repo reads this file as anything
  but a tsconfig, so removal is safe — but verify `yarn build` still picks it up.
- **Path-bearing settings not hoisted:** double-check no package silently loses its `outDir`
  — after the change, each still emits into its own `packages/<name>/dist`, not `<root>/dist`.
  A quick post-build `ls packages/<name>/dist` on a couple packages catches a misroute.
- **Module-resolution parity:** the 9 tsc packages keep `Node16` (unchanged). The 2 plugins
  drop from `NodeNext → Node16` — confirm each still builds under tsup and its emitted output
  is unchanged (diff `dist` before/after, or at least confirm the build succeeds and smoke
  test passes: `quereus-plugin-optimystic` has `npm run test:smoke` in its test script).
- **verbatimModuleSyntax fallout in reference-peer (9 errors):** fix each by marking the
  offending imports `import type { ... }` (or `export type`). After fixing, confirm the
  emitted JS for reference-peer is equivalent (the type-only imports were already being
  elided; marking them `type` keeps that behavior).
- **Easy-to-overlook packages:** `db-p2p-storage-fs` and `db-p2p-storage-rn` are excluded
  from parts of the root script chain in some setups — build them explicitly, don't rely on
  the aggregate `yarn build` alone. Storage-fs is also the one that was missing
  `downlevelIteration`; confirm it builds after normalization.
- **tsup + extends:** confirm both quereus plugins actually resolve `../../tsconfig.base.json`
  through tsup (build succeeds, `dist` produced). If tsup for some reason does not honor
  `extends` for a specific option a plugin relies on, surface it — do not silently paper over.
- **eslint:** `yarn lint` runs `eslint .` with typescript-eslint. Confirm it still resolves
  each package's tsconfig after the `extends` refactor (run `yarn lint` once).

## TODO

- Create `tsconfig.base.json` at the repo root with the exact contents above.
- Rewrite all 11 package `tsconfig.json` files to `extends` the base, keeping only
  `rootDir`, `outDir`, `include`, `exclude`, plus the per-package deltas listed above.
  Ensure db-core is written without a BOM.
- Add `type` markers to the ~9 type-only imports in `reference-peer` that
  `verbatimModuleSyntax` flags. Get `packages/reference-peer` to compile clean:
  `cd packages/reference-peer && npx tsc --noEmit` → 0 errors.
- Build every package and confirm success. Stream output:
  `yarn build 2>&1 | tee /tmp/tsconfig-build.log`. Then explicitly build the
  easy-to-miss ones if the aggregate skips them:
  `cd packages/db-p2p-storage-fs && yarn build`,
  `cd packages/db-p2p-storage-rn && yarn build`.
- Spot-check emit routing: `ls packages/db-core/dist packages/reference-peer/dist` after build.
- Run `yarn lint` and the plugin smoke test path (build + `quereus-plugin-optimystic` test)
  to confirm nothing broke.
- Do NOT touch `exactOptionalPropertyTypes` — leave it off; the backlog ticket owns it.
- Hand off to review with an honest note on which packages you actually rebuilt vs. relied
  on the aggregate script for.
