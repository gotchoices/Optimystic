----
description: Route the stray direct-to-console log calls in library code through each package's toggleable debug logger, then wire up ESLint with a no-console rule so this kind of stray output gets caught automatically instead of the current do-nothing lint script.
prereq:
files: package.json, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/cohort-topic/coldstart.ts, packages/db-p2p/src/storage/restoration-coordinator-v2.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/logger.ts, packages/db-p2p/src/logger.ts, packages/reference-peer/src/cli.ts, packages/reference-peer/src/mesh.ts, packages/demo/src/run.ts
difficulty: medium
----

From review finding eh-3 (logging portion), docs/review.html Section 9. Two independent-but-related pieces of work: (1) sweep stray `console.*` in library code to each package's `debug` logger; (2) stand up ESLint with a `no-console` rule and a real root `lint` script so regressions get caught.

## Background — how logging works here

Each library package has a `logger.ts` that wraps the `debug` npm package:

```ts
// packages/db-core/src/logger.ts (representative)
import debug from 'debug'
const BASE_NAMESPACE = 'optimystic:db-core'
export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`)
}
export const verbose = typeof process !== 'undefined'
	&& (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
```

Usage is `const log = createLogger('some-subsystem')` at module top, then `log('message %o', obj)`. Output is silent unless the consumer sets `DEBUG=optimystic:*` (or a narrower namespace). That is exactly the toggleability the ticket wants — library code should never print unconditionally.

Packages that already have `logger.ts`: `db-core`, `db-p2p`, `db-p2p-storage-fs`, `db-p2p-storage-ns`, `db-p2p-storage-rn`, `db-p2p-storage-web`.

**`quereus-plugin-optimystic` has NO `logger.ts`** but already depends on `debug` (package.json line 63). It needs a new `logger.ts` following the same pattern with `BASE_NAMESPACE = 'optimystic:quereus-plugin'`. Add a `@types/debug` devDependency to that package too (it is missing — reference-peer has it as the model).

## The library console offenders to sweep

These are in library `src` and must move to a `debug` logger. Pick a sensible `subNamespace` per file (suggestions in parens). Preserve severity intent: many are warnings/errors — `debug` has no levels, so keep the message text descriptive (prefix `WARN:`/`ERROR:` in the string if it aids the reader), or route to a `:error` sub-namespace. Do not swallow: a `console.error` in a catch that signals real failure should still log via `debug` (visible when enabled), not vanish.

- `packages/db-core/src/transactor/network-transactor.ts:455` — `console.warn('Failed to record coordinator hint', e)`. File already imports `createLogger`/`verbose` and has `const log = createLogger('network-transactor')` — use `log`.
- `packages/db-core/src/transactor/network-transactor.ts:561` — `console.warn('[NetworkTransactor] non-tail commit had errors ...')`. Same `log`.
- `packages/db-core/src/cohort-topic/coldstart.ts:210` — `console.warn('cohort-topic cold-start: parent registration ... failed', err)`. Add/reuse a `createLogger('cohort-topic:coldstart')`.
- `packages/db-p2p/src/storage/restoration-coordinator-v2.ts:188` — `console.log(...)`. Add `createLogger('restoration-coordinator')`.
- `packages/db-p2p/src/libp2p-key-network.ts:551` — `console.warn('invalid multiaddr from connection', a, err)`. File already has `private readonly log = createLogger('libp2p-key-network')` (line 142) — use `this.log`.
- `packages/db-p2p/src/cluster/cluster-repo.ts:1229` — `console.error('Failed to propagate to peer ...')`. Add `createLogger('cluster-repo')`.
- `packages/quereus-plugin-optimystic/src/plugin.ts:21` — `console.log('Optimystic plugin loading with config:', config)`. Use new package logger, `createLogger('plugin')`.
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:125` — `console.debug(...)`. Use `createLogger('collection-factory')`.
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:437` — `console.log('Stopping libp2p node: ${key}')`. Same logger.
- `packages/quereus-plugin-optimystic/src/optimystic-module.ts:307,327,334,356` — four `console.warn(...)`. Use `createLogger('module')` (or `'optimystic-module'`).

That is ~13 call sites across the `.ts` sources; the review's "about sixteen" also counts a couple of multi-line calls as several. **Re-grep `console\.` under `packages/**/src/**/*.ts` after the sweep** to confirm nothing library-side remains except the deliberate exemptions below. There are no `console.*` calls in library `.js` sources, but grep once to be sure.

## Legitimate console output — exempt explicitly

These are CLI / entry-point / demo files whose whole job is to print to a terminal. **Leave the `console.*` calls, but exempt them explicitly in the ESLint config** (per-file / per-glob override), not by accident:

- `packages/reference-peer/src/cli.ts` — commander-based CLI (`bin: optimystic-peer`). ~90 console calls, all intentional user output.
- `packages/reference-peer/src/mesh.ts` — `mesh` entry script (`yarn mesh`).
- `packages/demo/src/run.ts` — the demo app, prints its walkthrough to the terminal.
- Root `scripts/*.js` (e.g. `publish-package.js`) — build/publish tooling.
- Test files (`**/test/**`, `**/*.spec.ts`) — conventionally allowed to console.

## ESLint setup

No ESLint exists anywhere in the repo (no `eslint.config.*`, no `.eslintrc`, no eslint dep). Stand it up fresh. Repo is ESM (`"type": "module"`), yarn 4 workspaces, TypeScript throughout — use a **flat config** (`eslint.config.js` at repo root) with `typescript-eslint`.

Root devDependencies to add: `eslint` (^9), `typescript-eslint` (^8, the combined meta-package that pulls `@typescript-eslint/parser` + `eslint-plugin`), and `@eslint/js`. Keep it minimal — the goal is a working `no-console` gate, not a full style regime.

Config shape (illustrative):

```js
// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'tess/**'] },
  js.configs.recommended,
  // NOTE: use the non-type-checked preset to keep lint fast and avoid needing a
  // tsconfig project graph across every workspace; no-console needs no type info.
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // Intentional terminal output — CLI, entry scripts, demo, tooling, tests.
    files: [
      'packages/reference-peer/src/cli.ts',
      'packages/reference-peer/src/mesh.ts',
      'packages/demo/src/**',
      'scripts/**',
      '**/test/**',
      '**/*.spec.ts',
    ],
    rules: { 'no-console': 'off' },
  },
);
```

Keep the rest of `tseslint.configs.recommended` from failing the build on pre-existing style issues: the first pass should not turn the whole codebase red over unrelated rules. If `recommended` surfaces a flood of unrelated errors, **scope this ticket to `no-console` only** — set the other noisy rules to `'off'` (or start from `js.configs.recommended` + parser only, without the full recommended preset) and leave a `NOTE:` comment in `eslint.config.js` that tightening the rest is future work. Do not let unrelated rule violations block the `no-console` gate. Document whatever you disable.

Replace the root `lint` script:

```json
"lint": "eslint ."
```

`eslint .` with a flat config walks the tree from root, so a single root script covers the whole workspace — no per-package fan-out needed (unlike the existing `build:`/`test:` scripts). Confirm the flat-config `ignores` excludes `dist`, `node_modules`, `.tsbuildinfo`, and the `tess/` tooling tree so lint stays fast and doesn't choke on generated/vendored code.

## Validation

- `yarn install` after editing root `package.json` (adds eslint deps).
- `yarn lint` must exit 0 after the sweep. Before the sweep it should report the library `no-console` violations — run it once mid-work to confirm the rule actually fires on the offenders (proves the gate works), then again after to confirm green.
- Re-grep `console\.` under `packages/**/src/**/*.ts`; only the exempted CLI/demo/entry files should remain.
- `yarn build` (or at least `yarn build:db-core && yarn build:db-p2p && yarn build:quereus-optimystic`) to confirm the logger edits compile. The new `quereus-plugin-optimystic/src/logger.ts` must be picked up by its tsup build.
- Do NOT run the full `yarn test` unless quick — the logger swaps are behavior-preserving (silent-by-default). A targeted build + lint is the meaningful gate here.

## Notes / tripwires for the review handoff

- The `verbose` export in the existing `logger.ts` files is a separate mechanism (env-gated eager logging); this ticket doesn't touch it. Mirror it in the new quereus-plugin `logger.ts` only if a call site needs it — otherwise keep that logger minimal (just `createLogger`).
- If `typescript-eslint`'s `recommended` preset proves too noisy to land cleanly, the `no-console`-only fallback above is the accepted scope — note in the review ticket that broader lint rules are deferred.

## TODO

- Add `packages/quereus-plugin-optimystic/src/logger.ts` (mirror db-core's pattern, `BASE_NAMESPACE = 'optimystic:quereus-plugin'`); add `@types/debug` devDep to that package.
- Sweep the ~13 library `console.*` sites listed above to `debug` loggers, preserving severity intent in the message text.
- Re-grep `packages/**/src/**/*.ts` for `console\.`; confirm only exempt CLI/demo/entry files remain.
- Add root `eslint.config.js` flat config: `no-console: error` on `packages/*/src/**/*.ts`, `off` override for CLI/mesh/demo/scripts/tests.
- Add `eslint`, `typescript-eslint`, `@eslint/js` to root devDependencies; run `yarn install`.
- Replace root `lint` script with `eslint .`.
- Run `yarn lint` mid-sweep (confirm it flags offenders) and post-sweep (confirm green). Build the three touched packages.
