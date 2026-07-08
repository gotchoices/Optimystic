description: A shared root TypeScript config now replaces eleven copy-pasted per-package configs; the consolidation was verified to not change any package's build output and the drift fixes are correct.
prereq:
files: tsconfig.base.json, packages/db-core/tsconfig.json, packages/db-p2p/tsconfig.json, packages/db-p2p-storage-fs/tsconfig.json, packages/db-p2p-storage-ns/tsconfig.json, packages/db-p2p-storage-rn/tsconfig.json, packages/db-p2p-storage-web/tsconfig.json, packages/reference-peer/tsconfig.json, packages/reference-peer/src/cli.ts, packages/quereus-plugin-optimystic/tsconfig.json, packages/quereus-plugin-crypto/tsconfig.json, packages/substrate-simulator/tsconfig.json, packages/demo/tsconfig.json
difficulty: medium
----

## Summary

Introduced `tsconfig.base.json` at the repo root holding all path-independent shared
compiler options. All 11 package `tsconfig.json` files were rewritten to `extends`
`../../tsconfig.base.json`, keeping only path-bearing settings (`rootDir`, `outDir`,
`include`, `exclude`) plus genuine per-package deltas (web `DOM` lib; both plugins
`resolveJsonModule`). `verbatimModuleSyntax: true` was enabled in the base and its sole
fallout fixed (9 type-only import markers in `reference-peer/src/cli.ts`).
`exactOptionalPropertyTypes` was correctly left off — owned by backlog ticket
`debt-tsconfig-exact-optional-property-types` (confirmed present).

## Review findings

Adversarial pass over the implement diff (commit `89411fe`) with fresh eyes before reading
the handoff. Verdict: **clean, faithful consolidation. Zero findings — nothing fixed, nothing
filed.** Details of what was checked:

### Correctness / no-silent-drop — CHECKED, clean

Diffed every removed per-package block against `base + declared deltas`. The base is a
superset of the common options; nothing was silently lost:
- Every package's compiler options are fully covered by the base except its genuine deltas,
  which are all preserved: `db-p2p-storage-web` keeps `lib: ["ES2022","DOM"]`; both plugins
  keep `resolveJsonModule: true`.
- `db-p2p-storage-fs` and `quereus-plugin-crypto` *gain* `downlevelIteration` via the base —
  confirmed no-op at `target: ES2022` (it only affects `target < ES2015`).
- `reference-peer` *gains* `rootDir: "."` — correct, matches siblings; emit still routes to
  its own `dist`.
- Only two intended functional deltas: `verbatimModuleSyntax` `false→true` (all packages) and
  plugin module resolution `NodeNext→Node16`. The plugins emit via tsup/esbuild, so their
  runtime output is unaffected by the tsc module setting; only type-resolution shifts
  (identical between Node16/NodeNext for these ESM packages today).

### Path-bearing settings — CHECKED, correct

`rootDir`/`outDir`/`include`/`exclude` correctly kept per-package (they resolve relative to
the declaring file). `include: ["src","test"]` must not be hoisted (would resolve to the
repo root). `exclude: ["node_modules","dist"]` could technically hoist but was left
per-package — a reasonable, consistent choice, not a defect.

### Drift fixes — CHECKED, correct

- `db-core` BOM removed: first bytes now `7b 0a 09` (`{`,LF,tab), not `EF BB BF`. Tab-indented
  like siblings.
- Final newline present on new/rewritten files (`.editorconfig` compliant): last byte `0a`
  verified on base, db-core, reference-peer.
- LF line endings on rewritten files (matches `.editorconfig`; no CRLF pin). Cosmetic churn
  only.

### No missed files — CHECKED

Globbed all `tsconfig*.json` in source (excluding `node_modules`): only the 11 package configs
+ the new base. No stray `tsconfig.build.json` / `tsconfig.eslint.json` variant that should
also extend the base. Root has no `tsconfig.json` (only `tsconfig.base.json`), and
`eslint.config.js` resolves per-package configs fine after the refactor (lint green).

### Build / lint / tests — RUN, all pass

The implementer's honest gap was the full test suites. I ran them:
- `yarn build` (9 tsc packages + 2 tsup plugins, topological) → **EXIT 0**.
- `yarn lint` (`eslint .`) → **EXIT 0**.
- `yarn test` (full mocha suites, all workspaces) → **EXIT 0** (258 passing in the core sweep
  + a 6-passing p2p integration suite; ~6m32s wall).

The passing test run closes the implementer's chief worry directly: the suites run under
`ts-node/esm` (transpile-only). Under `verbatimModuleSyntax: true`, any type-only import left
*unmarked* would be emitted as a real runtime import and crash on a missing binding — a green
full-suite run proves no such case survived anywhere, not just in `reference-peer`.

### Tripwires (recorded here, no ticket)

- **`verbatimModuleSyntax: true` is now enforced repo-wide.** This is a guard, not a hazard:
  future mixed value+type imports will fail at build *and* under the transpile-only test
  runner until marked `import type`. Noted so a future contributor who hits a fresh TS1484
  understands it is intended policy, not a regression. No code site to tag (config-level);
  parked here in findings only.

### Deferred (verified, not touched here)

- `exactOptionalPropertyTypes` — backlog ticket `debt-tsconfig-exact-optional-property-types`
  confirmed to exist. This ticket deliberately left the flag off.
