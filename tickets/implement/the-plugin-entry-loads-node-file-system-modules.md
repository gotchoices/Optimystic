description: The Quereus plugin's main entry reads a file from disk when it loads, to learn which Quereus version it runs on. That breaks browser builds and React Native builds of any app that imports from it, even for an error class. Fix the version lookup at build time instead, and add a check that fails if the main entry ever stops bundling for a browser again.
architecture: docs/correctness.md
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (lines 10–42: the `node:fs` / `node:url` / `node:path` imports, `resolveQuereusVersion()`, `QUEREUS_ENGINE_ID`)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts (new, generated, committed)
  - packages/quereus-plugin-optimystic/scripts/write-quereus-version.mjs (new: the build-time version lookup, moved out of the runtime module)
  - packages/quereus-plugin-optimystic/package.json (`build`, `test:smoke`, new `esbuild` devDependency)
  - packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts (lines 61–74: engine id tests; `installedQuereusVersion()` helper)
  - packages/quereus-plugin-optimystic/test/browser-bundle.spec.ts (new: the regression guard)
  - packages/quereus-plugin-optimystic/README.md (§ Transaction Engine, § Error Handling)
  - docs/correctness.md (Theorem 4 proof sketch, step 1 "Engine ID match")
  - scripts/check-undeclared-deps.mjs (read-only: the new spec imports `esbuild`, so it must be declared)
repro: verified
----

# What is wrong

`src/transaction/quereus-engine.ts` works out `QUEREUS_ENGINE_ID` (`quereus@<version>`) when the module loads. `@quereus/quereus` exports no version and its `exports` map has no `./package.json` subpath, so the code calls `import.meta.resolve('@quereus/quereus')`, walks up the directories and `readFileSync`s the first `package.json` named `@quereus/quereus`. That needs `node:fs`, `node:url` and `node:path` at module scope, and `import.meta`. The file is reachable from the root entry (`src/index.ts` → `transaction/index.ts` → `quereus-validator.ts` → `quereus-engine.ts`). The `./plugin` entry does not reach it. Sereus imports `./plugin` for exactly that reason, and matches `PartialCommitError` by its `name` string instead of the class (`sereus/packages/cadre-core/src/control-write-retry.ts`, `LEGACY_PARTIAL_COMMIT_ERROR_NAME`).

## Reproduced (2026-09-17)

**Browser.** esbuild (`platform: 'browser'`, `bundle: true`, run from `packages/quereus-plugin-optimystic`) on `export { PartialCommitError } from '@optimystic/quereus-plugin-optimystic'` fails with exactly three errors, all in `dist/index.js`: `Could not resolve "fs"`, `"url"`, `"path"`. When those three are marked external, the whole graph bundles (about 3.7 MB). So nothing else in the root entry's graph (libp2p, db-p2p, quereus) blocks a browser build.

**React Native.** With `packages/rn-bundle-check`'s Metro config and an entry that imports the plugin's `dist/index.js`, Metro fails with `Unable to resolve module path`. The check's own hint says it is a Node built-in React Native does not provide. React Native fails at build time: it does not throw at runtime, and no shim silently returns a wrong version. With `fs`/`url`/`path` stubbed out in a copy of `dist`, Metro bundles, and then `hermesc` (legacy Hermes, React Native 0.83 toolchain) rejects the file with `error: 'import.meta' is currently unsupported` at the `import.meta.resolve` line. With that line also replaced, the bundle compiles. **The engine id lookup is the only thing that keeps the plugin's root entry out of React Native and browser builds.** A shim for `fs`/`path`/`url` would not be enough, because of `import.meta`.

## Where the engine id is used, and why every machine must agree

`QuereusEngine.id` is stamped into every session-mode transaction's `TransactionStamp.engineId` by the writer. `createQuereusValidator` registers its engine under `QUEREUS_ENGINE_ID`. `TransactionValidator.validate` (`packages/db-core/src/transaction/validator.ts:85`) rejects `Unknown engine: <id>` when the two differ. A browser or React Native app that writes in session mode builds its `QuereusEngine` from this same root entry. So the id must come from **the same mechanism on every platform**. A Node-only runtime lookup paired with a build-time fallback elsewhere would make a phone's writes refused by Node validators whenever the two values differed. That rules out "lazy lookup, only on Node".

The engine id is a first gate. It is not the only defence against two nodes running different Quereus builds: the validator also re-executes the statements and compares the operations hash (`validator.ts:170`). Two validators on different Quereus versions that share an id still cannot accept divergent operations. They reject with an operations-hash mismatch instead of `Unknown engine`.

# Decision: fix the version when the plugin is built

Of the three options the fix ticket listed:

- **Build-time constant (chosen).** Portable: no Node built-ins and no `import.meta`, and the same value on every platform running the same plugin build.
- **An export from `@quereus/quereus` itself (for example a generated `VERSION`).** This is the best long-term source: portable, and accurate at runtime. It needs a change and release in the separate quereus repository, and a raised peer minimum. Rejected for now because it cannot land from this repo. Leave a `NOTE:` at the constant saying that if quereus ever exports its version, the id should be read from there.
- **Lazy lookup, Node only.** Rejected: the id would differ by platform (see above), and the root entry would still need a dynamic `import('node:fs')` that Metro and hermesc would have to tolerate.

**What changes in meaning.** Today the id names the Quereus actually installed at runtime. After this change it names the Quereus the plugin was built against. The two differ only when a consumer installs a different Quereus inside the plugin's peer range (`^4.3.0`). In that case nodes running the same plugin build agree on the id even across different Quereus installs, and the operations-hash check becomes what refuses a divergent execution. Nodes running different plugin builds against the same Quereus can now disagree, and the result is a clear `Unknown engine` refusal. `docs/correctness.md` Theorem 4 step 1 currently reads "both validators use the same execution engine version". Update it to say the id names the Quereus version the plugin build was compiled against, and that step 5 (the operations hash) is what catches a runtime Quereus that differs from it.

**How the constant stays correct.**
- `scripts/write-quereus-version.mjs` (Node, build-time) resolves the installed `@quereus/quereus` version with today's walk-up logic, moved out of the runtime module as is. It writes `src/transaction/quereus-version.ts`, containing only `export const QUEREUS_VERSION = '<x.y.z>';` under a "generated, do not edit" header.
- The plugin's `build` script runs it before `tsup`, so every `yarn build`, every `yarn check` and every release (`yarn pub` builds first) regenerates the file from whatever Quereus is resolved.
- The generated file is **committed**, so typecheck and the mocha suite, which run from `src` through `register.mjs`, work on a fresh clone without a build. A Quereus bump shows up as a one-line diff.
- The existing spec `should match the installed @quereus/quereus version` stays as the guard. It fails if someone bumps Quereus and runs tests without building. Make its failure message name the fix (`yarn workspace @optimystic/quereus-plugin-optimystic build`, or run the script).
- `test:smoke` (which imports `dist/index.js` under Node) additionally asserts the id equals the installed Quereus version, not just its format, so a stale `dist` fails too.

A tsup `define` was considered and rejected: it applies only to the `dist` build, and the tests run from `src`, where the global would be undefined.

# Regression guard (leave this behind)

Add `test/browser-bundle.spec.ts` (mocha, runs in `yarn test`). It uses esbuild's JavaScript API to bundle the plugin's `src/index.ts` and `src/plugin.ts` with `platform: 'browser'`, `bundle: true`, `write: false`. It asserts the build succeeds with no resolution errors. On failure, the assertion message lists each unresolved specifier and its importing file. Workspace dependencies resolve to their built `dist`, which `yarn check` builds first; the plugin's own tests already rely on that.

- Declare `esbuild` as a devDependency of the plugin. It is only in the plugin's `node_modules` today as tsup's dependency, and `yarn lint:deps` (`scripts/check-undeclared-deps.mjs`) will flag an undeclared import. Match the version tsup already pulls in.
- Also fail on `import.meta` if it is cheap to do. Hermes rejects it even when a browser accepts it, and the React Native bundle check does not yet cover the plugin; `rn-bundle-check-covers-the-quereus-plugin` adds that. One way: pass `supported: { 'import-meta': false }` and treat esbuild's "import.meta … will be empty" warning as a failure. First confirm nothing else in the root entry's browser graph uses `import.meta` (db-p2p's non-React-Native entry is in that graph). If something does, restrict the assertion to files under this package and say so in the test.
- Check it fails first: run the new spec against today's `quereus-engine.ts` and see it fail on `fs`/`url`/`path` before making the fix.

# Should the error classes get their own browser-safe subpath?

No, not in this ticket. Once the root entry bundles for browsers and React Native, `import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic'` just works. A separate `/errors` subpath would be a second import spelling to document and keep in sync. The other classes applications are told to classify on (`TornActionError`, `SyncRetryExhaustedError`, `CoordinatorPartialCommitError`) already come from `@optimystic/db-core`, which has no Node-only imports. The one thing a subpath would buy is a lighter import, because the root entry drags in libp2p and Quereus. Anyone importing the plugin at all already pays that.

# Downstream note

When this ships, tell sereus (`sereus-83`) they can drop the `no-restricted-imports` rule in `eslint.config.mjs` and the `LEGACY_PARTIAL_COMMIT_ERROR_NAME` name match in `cadre-core/src/control-write-retry.ts`, and import the class. That is their change to make, not this repo's. Put it in the review handoff so it reaches the reply.

# TODO

- Write `test/browser-bundle.spec.ts` and add `esbuild` to the plugin's devDependencies. Run it and confirm it fails on today's code (`fs`/`url`/`path`).
- Add `scripts/write-quereus-version.mjs`, generate and commit `src/transaction/quereus-version.ts`, and change `build` to run the script before `tsup`.
- In `quereus-engine.ts`: remove the three `node:` imports, `resolveQuereusVersion()` and the `import.meta.resolve` call. Build `QUEREUS_ENGINE_ID` from `QUEREUS_VERSION`. Replace the long comment with a short one that says the value is fixed at build time and why, and add the `NOTE:` about preferring a Quereus-exported version if one appears.
- Keep `test/quereus-engine.spec.ts`'s installed-version test. Give it an actionable failure message. Its `installedQuereusVersion()` helper runs under Node in tests, so it may keep using `fs`.
- Strengthen `test:smoke` to compare against the installed Quereus version. Keep it a one-liner, or move it to a small `scripts/smoke.mjs` if the inline string gets unreadable.
- Decide whether `engines.node >=20.6.0` is still needed. It was raised for `import.meta.resolve`. Leave it alone unless nothing else relies on it, and say which in the handoff.
- Update `README.md` § Transaction Engine: the id names the Quereus version the plugin was built against, and the root entry is safe to import in browsers and React Native. Update § Error Handling: `PartialCommitError` can be imported from the root entry on any platform.
- Update `docs/correctness.md` Theorem 4 step 1 as described above.
- Run `yarn workspace @optimystic/quereus-plugin-optimystic build`, then that workspace's `test` (which includes `test:smoke`), `yarn typecheck`, `yarn lint`, `yarn lint:deps` and `yarn lint:docs`.
