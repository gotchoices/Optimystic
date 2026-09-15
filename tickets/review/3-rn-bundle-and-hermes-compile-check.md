description: Review the new automated check that builds our React Native entry point with the same bundler and JavaScript-engine compiler a phone app uses, so code that would break a phone app's build fails in this repository instead of in someone else's project.
files:
  - packages/rn-bundle-check/package.json (new private workspace; exact toolchain pins)
  - packages/rn-bundle-check/readme.md (purpose, what it does not check, toolchain-pin NOTE)
  - packages/rn-bundle-check/metro.config.cjs (React Native defaults + readme shim aliases + watch folders + quiet reporter)
  - packages/rn-bundle-check/entry.js (host-shaped imports)
  - packages/rn-bundle-check/shims/node-os.js, shims/node-crypto.js, shims/react-native.js
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (guards, bundle, routing assertion, compile, source-map translation, CLI)
  - packages/rn-bundle-check/test/*.test.mjs, test/fixtures/*.js
  - package.json (root: `check:rn`, chained into `check` after `typecheck`)
  - yarn.lock (+~2.3k lines for the toolchain)
  - test-harness/build-freshness.mjs (`SKIP_ENV` is now exported; nothing else changed)
  - packages/db-p2p/readme.md (§ React Native: `TextDecoder` moved into the polyfill table; note under the shim table)
  - packages/db-p2p/test/entry-parity.spec.ts (comments only)
  - eslint.config.js (comment only), docs/releasing.md, AGENTS.md
----

# What landed

`yarn check:rn` builds our React Native entry the way a phone app's release build does. It bundles a host-shaped entry file with **Metro** (React Native's bundler, which runs Babel with the React Native preset) and then compiles the bundle with **`hermesc`** (the compiler for Hermes, React Native's JavaScript engine). Every other test here runs on Node, so syntax that breaks either step used to surface only in a downstream app. The known case is a class `static { }` block, which did exactly that on 2026-09-14.

It lives in a new private workspace, `packages/rn-bundle-check`, which stands in for a host app, and it runs inside `yarn check` after `yarn build` and `yarn typecheck`. The toolchain is pinned to one React Native release, 0.83: `metro@0.83.8`, `metro-cache@0.83.8`, `@react-native/metro-config@0.83.10`, `@react-native/babel-preset@0.83.10` and `hermes-compiler@0.14.1`. The workspace readme explains why those versions must move together.

The script (`scripts/rn-bundle-check.mjs`) runs these steps in order:

1. Refuse a Plug'n'Play install.
2. Refuse a stale or missing `dist/`, using `buildFreshnessProblems` and honouring `OPTIMYSTIC_SKIP_BUILD_CHECK`.
3. Bundle with Metro (Android, production, `hermes-stable` profile, unminified, source map) into a fresh `mkdtemp` directory.
4. Assert that `@optimystic/db-p2p` and `@optimystic/db-p2p/rn` both resolved to `packages/db-p2p/dist/src/rn.js`.
5. Compile with `hermesc -emit-binary -O`, passed as an argument array. On failure, each `bundle.js:L:C` is followed by the original `[file:line:col]` from the source map.
6. Print step timings, plus the "Checked / Not checked" disclaimer on a passing run.

It never executes the bundle. Running it on a Hermes runtime is `backlog/feat-rn-bundle-runs-under-hermes`, which lists this ticket as a prereq.

# How to validate (use cases)

- **Happy path:** `yarn build && yarn check:rn` → `rn-bundle-check: passed (Metro bundle …s, hermesc compile …s)` plus the disclaimer, exit 0. Expect about 16 `WARN Attempted to import … multiformats …` lines; they are printed once each and never fail the check.
- **Unit tests:** `yarn workspace @optimystic/rn-bundle-check test` (also part of root `yarn test`; needs no build) → 6 pass.
- **Static block (the known instance):** add `static { void BlockWriteLatch.#wired; }` to the class in `packages/db-p2p/src/storage/block-latch.ts`, run `yarn workspace @optimystic/db-p2p build`, then `yarn check:rn` → fails at the bundle stage. Revert and rebuild afterwards.
- **Repointed export condition:** set `exports["."]["react-native"].import` in `packages/db-p2p/package.json` to `./dist/src/index.js`, then run `yarn check:rn` → the routing problem is reported first, then Metro's `net` error. Revert afterwards.
- **Missing build:** rename `packages/db-p2p-storage-rn/dist/src/index.js`, then run `yarn check:rn` → it refuses before Metro starts. Rename it back.

# What was verified, with output (Windows 11, Node 24.2.0)

- `yarn check:rn` passes. Warm and uncontended: 11.7 s wall (Metro 2.3 s, hermesc 8.3 s). Cold, with both caches deleted: about 30 s (Metro 17.5 s, hermesc 11.4 s), but `yarn test:harness` and `yarn lint:deps` were running at the same time, so that number is inflated; planning measured about 20 s cold.
- Workspace tests: 6/6 pass, in 2.9 s with the Metro cache warm.
- `yarn lint`, `yarn lint:docs`, `yarn lint:deps` (constraints, installed majors, undeclared dependencies: 856 files across 12 packages) and `yarn test:harness` (51/51) all pass.
- The root `yarn build` fan-out skips the new workspace, which has no `build` script.
- **Static-block proof** (reverted, db-p2p rebuilt, no trace left in `dist/`):
  ```
  rn-bundle-check: FAILED (Metro bundle 2.9s)
  ..\db-p2p\dist\src\storage\block-latch.js: C:\projects\optimystic\packages\db-p2p\dist\src\storage\block-latch.js: Static class blocks are not enabled. Please add `@babel/plugin-transform-class-static-block` to your configuration.
  ```
- **Routing proof** (`package.json` restored; `git diff` empty):
  ```
  rn-bundle-check: FAILED (Metro bundle 2.0s)
  @optimystic/db-p2p resolved to packages/db-p2p/dist/src/index.js instead of packages/db-p2p/dist/src/rn.js. A React Native app importing it gets the wrong entry point. …
  Unable to resolve module net from …\packages\db-p2p\node_modules\@libp2p\tcp\dist\src\tcp.js: …
  "net" is a Node built-in module, which React Native does not provide. …
  ```
- **Missing-build proof:**
  ```
  rn-bundle-check: FAILED
  Build first: this check bundles compiled dist/ output, and some of it is missing or stale.
    - @optimystic/db-p2p-storage-rn: not built (missing dist/src/index.js).
      Run in C:\projects\optimystic: yarn workspace @optimystic/db-p2p-storage-rn build
  ```

# Where this departs from the plan, and why

- **`resolver.nodeModulesPaths: [<workspace>/node_modules]` was added.** The first run failed with `Unable to resolve module @babel/runtime/helpers/interopRequireDefault from packages/db-core/dist/...`. The React Native preset's runtime transform adds `@babel/runtime` imports to every module, and nothing above `packages/*/dist` holds a copy. A host app gets that package from its own `node_modules`, and monorepo hosts set `nodeModulesPaths` for exactly this; the sereus reference app does. `@babel/runtime` is now declared as a devDependency. Side effect: any package this workspace installs can satisfy an import from `packages/*/dist` at bundle time. That does not mask undeclared dependencies in the libraries, because `scripts/check-undeclared-deps.mjs` covers those, and a flat app install resolves the same way.
- **`fileMapCacheDirectory` was dropped.** Metro 0.83's config validator reports it as an unknown option, and the cache write failed with `ENOENT` because Metro does not create the directory. Only the transform cache (a `FileStore` under `node_modules/.cache/rn-bundle-check/metro`) is workspace-local. Metro's file-map cache still goes to `%TEMP%`, as `metro-file-map-<project hash>-<config hash>`.
- **The routing assertion covers `./rn` as well as the bare specifier.** Wrong routes are also reported when the bundle itself fails. This is necessary because the repointed-condition proof never reaches a post-bundle assertion: the Node entry fails on `net` first, and Metro's message alone points at the wrong fix.
- **`shims/node-os.js` imports the `react-native` stub by relative path.** A bare `'react-native'` import would fail `check-undeclared-deps`, since that package is not installed. Third-party `react-native` imports still reach the stub through the alias.
- **The `stream` and `buffer` aliases point at the package directories** (resolved through `<name>/package.json`), not at `require.resolve('<name>')`. That call returns Node's built-in `buffer`, and the sereus config inherits that bug. Metro then applies its own main-field and `browser` resolution inside the package. Which file it ultimately picks was not inspected.
- **`test-harness/build-freshness.mjs` now exports `SKIP_ENV`,** so the check reuses the variable name instead of repeating the string. The plan expected no change to that file.
- **A fifth test was added:** `test/hermesc-binary.test.mjs`. It pins each platform's binary to the installed package layout and checks that other platforms are refused.
- **Resolver warnings are deduplicated,** from 28 lines to 16.
- **The `TextDecoder` readme row names different packages than the plan expected.** The plan attributed the load-time construction to `uint8arrays`, but its construction is inside a function. I bundled the real entry and mapped every `new TextDecoder` back to its source. Constructions that run at module load are in `@optimystic/db-core`, `@optimystic/db-p2p` and `@optimystic/db-p2p-storage-rn` themselves (e.g. `storage/raw-store-codec`, `cohort-topic/peer-codec`, `keys`), plus `multiformats/codecs/json` and `cborg`. The row now lists those.
- **Two comments in `entry-parity.spec.ts` were corrected, beyond the NOTE the plan named.** Both claimed that bundling the Node entry succeeds because `@libp2p/tcp` falls back to a browser stub. Under Metro it fails, on `net` from `@libp2p/tcp/dist/src/tcp.js` (routing proof above). The old NOTE about unguarded routing now points at `EXPECTED_ROUTES`.

# Known gaps — treat the above as a floor

- **Not run: full `yarn check`, root `yarn test` fan-out, `yarn typecheck`, `yarn test:integration`.** Outside the new workspace, the changes are comments, docs, one `export` keyword and root script wiring. Only `yarn check:rn` and the new workspace's own `test` script were run through Yarn.
- **Only Windows was exercised.** The Linux x64 and macOS binary choices are unverified; there is a `NOTE:` on `hermescBinary`. Yarn's cache zip does keep the exec bit (`-rwxr-xr-x`) on `linux64-bin/hermesc` and `osx-bin/hermesc`.
- **Code paths never run:**
  - the Plug'n'Play refusal;
  - the `OPTIMYSTIC_SKIP_BUILD_CHECK` skip;
  - the `EACCES` and `ENOENT` hermesc messages;
  - the unsupported-platform refusal (unit-tested only);
  - the `rn-leveldb` resolve hint;
  - "kept for inspection" output after a real hermesc failure (only the test's direct `compile()` call was exercised);
  - `unreachedRoutes`, which fires if `entry.js` stops importing a routed specifier.
- **The missing-build proof renamed a single entry file, not the whole `dist/` directory.** `mv dist …` failed on Windows with "Permission denied", probably a file handle held by another process. The guard's `missing` branch keys on the entry file, so the proof exercises the same code.
- **The disclaimer prints only on passing runs.** The plan said "every time". A failing run prints the failure instead, because "Checked: Metro bundles …" would be false there. Decide whether failures should print the "Not checked" half.
- **Concurrent runs:** the tests and `check:rn` share the transform cache. The only concurrency exercised was `node --test` running three bundles in parallel, which passed. Metro's file map falls back to a full crawl if a concurrent write leaves a corrupt cache file (read in `metro-file-map/src/index.js`), but that path was not triggered.
- **`watchFolders` covers the repository root, which Metro crawls, including every workspace's `node_modules`.** This is most of the roughly 17 s cold bundle time. Narrowing it to the linked workspaces would be faster but brittle.
- `yarn install` reports the unmet `rn-leveldb` peer of `@optimystic/db-p2p-storage-rn`. That is expected, and noted in the plan.

# Tripwires placed (`NOTE:` sites)

- `metro.config.cjs`, `outOfRepoLinkTargets`: it watches the sibling package directory, not the sibling repository root. If Fret ever hoists its dependencies to its root `node_modules`, watch the workspace root instead.
- `scripts/rn-bundle-check.mjs`, `hermescBinary`: the Linux and macOS selections have never been run.
- `packages/rn-bundle-check/readme.md`, "The toolchain pin": once the oldest supported React Native version is on Hermes V1 (0.84+), move all the pinned packages to that release in one change.
