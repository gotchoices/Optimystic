description: Add an automated check that builds our React Native entry point with the same bundler and JavaScript-engine compiler a phone app uses, so code that would break a phone app's build fails in this repository instead of days later in someone else's project.
files:
  - packages/rn-bundle-check/ (new private workspace: package.json, readme.md, metro.config.cjs, entry.js, shims/, scripts/rn-bundle-check.mjs, test/, test/fixtures/)
  - package.json (root: new `check:rn` script, chained into `check`)
  - test-harness/build-freshness.mjs (reuse `buildFreshnessProblems`; no change expected)
  - packages/db-p2p/package.json (the `react-native` condition and `./rn` export the check exercises)
  - packages/db-p2p/readme.md (§ React Native: the Metro shim table the config mirrors; TextDecoder gap; mention the check)
  - packages/db-p2p/test/entry-parity.spec.ts (NOTE at lines 25-29 about unguarded `react-native` condition routing — point it at the new check)
  - packages/db-p2p-storage-rn/src/rn-opener.ts (why `rn-leveldb` is never bundled)
  - eslint.config.js (`NO_STATIC_BLOCK` comment — name the check as the backstop for the whole class)
  - docs/releasing.md (`yarn check` step table)
  - AGENTS.md (line ~113, the `yarn check` gate list)
  - scripts/check-undeclared-deps.mjs (will scan the new workspace; its imports must be declared)
  - ../sereus/packages/reference-app-rn/metro.config.js (read-only reference: a working host config)
difficulty: medium
----

# What this builds

Every test here runs on Node. A React Native app instead bundles our code with **Metro** (React Native's bundler, which runs Babel with the React Native preset) and then compiles the bundle to bytecode with **`hermesc`**, the compiler for Hermes, React Native's JavaScript engine. Code can pass every Node test and still break either step; the class `static { }` block that broke a downstream app on 2026-09-14 is the known instance.

This ticket adds `yarn check:rn`: bundle a small host-shaped entry file with Metro and a pinned React Native toolchain, then compile the bundle with a pinned `hermesc`. It runs inside `yarn check`, after `yarn build`.

It does **not** execute the bundle. Running it under a Hermes runtime (the "run step") was evaluated and scoped out to `backlog/feat-rn-bundle-runs-under-hermes`; see "Why no run step" below.

# Spike results (2026-09-15, Windows, scratch install — the design rests on these)

**Toolchain versions must all come from one React Native release.** Each React Native release pairs a Metro version, a Babel preset, and a Hermes compiler:

| React Native | Hermes compiler | Rejects `static { }`? |
|---|---|---|
| 0.79 – 0.81 | `hermesc` inside the `react-native` package itself (74 MB package) | yes (verified with 0.79's binary from ../sereus) |
| 0.83 | npm `hermes-compiler@0.14.1` (legacy Hermes, 43 MB) | yes (verified) |
| 0.84 – 0.87 | npm `hermes-compiler@250829098.x` (the newer "Hermes V1" line) | **no** — accepts static blocks, private fields, `for await` |

Mixing releases gives false failures. React Native 0.87's Babel preset, under the Hermes transform profile, keeps class syntax and private fields as-is because Hermes V1 supports them. Compiling that output with 0.83's legacy compiler failed with dozens of "private properties are not supported" errors that no real app would see. So pin one release's triple (Metro version, Babel preset version, compiler version).

**Chosen target: the React Native 0.83 toolchain** — `metro@0.83.8`, `@react-native/metro-config@0.83.10`, `@react-native/babel-preset@0.83.10`, `hermes-compiler@0.14.1`. Reasons: downstream apps are still on legacy Hermes (the sereus reference app is RN 0.79 / Expo SDK 53), and legacy Hermes is the stricter target, so syntax it compiles also compiles on Hermes V1. 0.83 is the newest release on legacy Hermes and the only one whose compiler is a standalone npm package. Getting 0.79's compiler would mean installing the whole `react-native@0.79` package and its dependencies. On every probe we ran (static block, private fields, `for await`), 0.79's and 0.83's compilers gave identical results. Tradeoff: an app on RN 0.79–0.81 runs an older Babel preset than 0.83's, so a preset-level difference between those versions would go unseen.

**Measured cost** (this machine, bundling the full entry, about a 9.5 MB bundle):
- Metro bundle: 8–10 s with a cold cache, 2–3 s warm.
- `hermesc` 0.14.1 compile: 6–7 s. The RN 0.87 compiler took 17 s, for comparison.
- Total about 20 s cold, well under the one-minute bar, so it belongs in `yarn check`.
- Install size: the toolchain plus shim dependencies came to 167 top-level packages and about 50 MB, plus 43 MB for `hermes-compiler` (roughly 93 MB total), all in this workspace's `node_modules`.

**What each stage catches (verified on fixtures):**
- A `static { }` block fails **at the Babel stage** under both the 0.83 and 0.87 presets and both transform profiles. The error names the file: `<file>: Static class blocks are not enabled. Please add @babel/plugin-transform-class-static-block to your configuration.`
- A regular expression with the `v` flag (`/[\p{L}--[a-z]]/v`) **passes Babel** and **fails at `hermesc`**: `bundle.js:803:25: error: Invalid regular expression: Invalid flags`. This is a verified construct for testing the compile stage. The `d` flag and BigInt literals compile fine and are not usable for that test.
- Our current RN entry, plus `@optimystic/db-p2p-storage-rn`, `@optimystic/db-core` and `@libp2p/websockets`, **bundles and compiles cleanly** with the readme's shim table, plus one stub (below).

**What the bundle needed beyond the readme's Metro shim table:** only `react-native` itself. `libp2p/dist/src/user-agent.react-native.js` does `import { Platform } from 'react-native'`, and every real app has that package. The check substitutes a stub exporting `Platform` (`OS`, `Version`, `select`). This is harness-only, not a readme gap. Installing real `react-native` would pull its native-module graph into the bundle and add a large install.

**Noise to expect:** Metro prints about 14 `WARN Attempted to import ... multiformats/dist/src/hashes/sha2-browser.js which is not listed in the "exports"` lines, and falls back to file-based resolution. Host apps see the same warnings. Warnings must not fail the check.

# Design

## Workspace `packages/rn-bundle-check` (private)

A private workspace stands in for a host app: a package that depends on our published packages the way an app would. It keeps the roughly 93 MB of toolchain out of the library packages' dependencies. With `nmHoistingLimits: workspaces`, the toolchain installs into this workspace's own `node_modules`. `private: true` keeps it out of `yarn pub` (which runs with `--no-private`). It needs no `build` script: `yarn workspaces foreach run <script>` skips workspaces that lack the script (confirmed from `yarn workspaces foreach --help`).

`package.json`:
- `dependencies`: `@optimystic/db-core`, `@optimystic/db-p2p` and `@optimystic/db-p2p-storage-rn`, all `workspace:^`. Declaring all three is what lets `buildFreshnessProblems` cover them, because it only checks directly declared dependencies. Also `@libp2p/websockets` and `@libp2p/circuit-relay-v2`, the transports the readme's RN example imports, and `@libp2p/crypto` and `@libp2p/interface` (storage-rn's peer dependencies). Use the same ranges db-p2p declares; `yarn constraints` enforces the majors.
- **Do not** add `rn-leveldb`. `db-p2p-storage-rn` never imports it; the host passes the constructors in (`rn-opener.ts`). Yarn will report the unmet peer dependency, and that is expected.
- `devDependencies`, exact pins for the toolchain triple: `metro@0.83.8`, `@react-native/metro-config@0.83.10`, `@react-native/babel-preset@0.83.10` and `hermes-compiler@0.14.1`. Also `@babel/core@^7.29.0`. Shim dependencies: `readable-stream@^4.7.0`, `buffer@^6.0.3`, and `@noble/hashes` (db-p2p's range). If the source-map approach below uses it, add `@jridgewell/trace-mapping`; if the cache store is imported directly, add `metro-cache@0.83.8`.
- Put a `// NOTE:` tripwire next to the pins, in readme.md (JSON has no comments): once the oldest React Native version we support is on Hermes V1 (RN 0.84+), move the whole triple to that release together.
- `scripts`: `"bundle-check": "node scripts/rn-bundle-check.mjs"` and `"test": "node --test \"test/*.test.mjs\""`.

## `metro.config.cjs`

- Start from `@react-native/metro-config`'s `getDefaultConfig(__dirname)`. That supplies React Native's resolver fields, condition names (including `react-native`), transformer and preset, which is what makes this "the same tooling a phone app uses".
- `resolver.extraNodeModules` holds **exactly** the rows of the db-p2p readme's "Node.js built-in module shims" table, each under both the bare and `node:` spelling: `os` → `shims/node-os.js`, `crypto` → `shims/node-crypto.js` (`createHash` for sha256 and sha512 via `@noble/hashes`), `stream` → `readable-stream`, `buffer` → `buffer`. The one extra entry is `react-native` → `shims/react-native.js`, commented as harness-only. The rule, written in the file's header: *if the bundle only succeeds with an alias not in the readme table, that is a readme gap — add the row to the readme in the same change.*
- `watchFolders`: the repo root, plus the real path of every workspace-`node_modules` symlink that resolves **outside** the repo root. Today that is `p2p-fret`, which is `portal:`-linked to `../Fret/packages/fret`. Derive the list by scanning `packages/*/node_modules` (scoped and unscoped entries, `lstat` → `realpath`) rather than hard-coding sibling paths the way the sereus config does. The spike confirmed Metro needs the sibling root in `watchFolders` to resolve it.
- `serializer.getModulesRunBeforeMainModule: () => []`, because React Native's `InitializeCore` lives in the stubbed-out `react-native` package.
- Cache: a workspace-local `FileStore` under `node_modules/.cache/rn-bundle-check/metro`. It is gitignored through `node_modules/`, and it keeps runs from sharing the machine-wide `%TEMP%/metro-cache` with other projects. Metro keys its cache by file content, so a warm cache is safe.
- Reporter: a quiet reporter that suppresses the ASCII banner but still forwards warnings and errors.

## `entry.js` (host-shaped)

Import what the readme tells a React Native host to import: `@optimystic/db-p2p/rn`, `@optimystic/db-p2p-storage-rn`, `@optimystic/db-core`, `webSockets` from `@libp2p/websockets`, and `circuitRelayTransport` from `@libp2p/circuit-relay-v2`. Also import the bare `@optimystic/db-p2p`. Touch each namespace, for example `Object.keys(ns).length`, so no import is dead. No polyfills: nothing executes.

## `scripts/rn-bundle-check.mjs`

Export pure-ish functions the tests reuse, `bundle({ entry, outDir })` and `compile({ bundlePath, sourceMapPath })`, plus a CLI `main()` that does the following in order:

1. **Linker guard.** If the install is Plug'n'Play (`process.versions.pnp` is set, or this workspace has no `node_modules`), fail with this message: Metro requires `nodeLinker: node-modules`. `.yarnrc.yml` is gitignored, so a fresh clone defaults to Plug'n'Play; see `blocked/decide-whether-to-commit-the-yarn-linker-setting`. Don't add a `prereq:` on that blocked ticket.
2. **Build-freshness guard.** Call `buildFreshnessProblems(<this workspace dir>)` from `../../test-harness/build-freshness.mjs`, print the problems and exit 1, honouring `OPTIMYSTIC_SKIP_BUILD_CHECK` the same way `assertBuildFresh` does. Check what it reports when `dist/` is missing entirely; it must say "build first", not just let Metro fail with "Unable to resolve". `p2p-fret` is transitive and stays uncovered, per the existing NOTE in that file.
3. **Condition routing.** Wrap `resolver.resolveRequest` to record what `@optimystic/db-p2p` (bare) resolves to. After bundling, assert it is `packages/db-p2p/dist/src/rn.js`. This closes the gap the NOTE in `entry-parity.spec.ts` (lines 25-29) describes: if someone repoints or drops the `react-native` condition, React Native silently gets the Node entry.
4. **Bundle.** Call `Metro.runBuild` with `platform: 'android'`, `dev: false`, `minify: false` (so error lines stay readable), `unstable_transformProfile: 'hermes-stable'` (what a Hermes app builds with), and a source map. Write into a fresh `fs.mkdtemp` directory under the workspace's `node_modules/.cache/rn-bundle-check/`, so concurrent runs (the check plus the tests) never share an output file.
   - On an `Unable to resolve module X` failure where X is a Node builtin, add a hint: either the readme's shim table is missing a row, or the importing dependency is not React-Native-safe.
   - On a resolve failure for `rn-leveldb`, add a hint that `db-p2p-storage-rn` must never import it statically.
5. **Compile.** Run `hermesc -emit-binary -O -out <dir>/bundle.hbc <dir>/bundle.js` via `execFileSync` or `spawnSync` with an **argument array** (never a composed shell string).
   - Binary path: `path.dirname(require.resolve('hermes-compiler/package.json'))` joined with `hermesc/win64-bin/hermesc.exe` on `win32`, `hermesc/linux64-bin/hermesc` on `linux` + `x64`, or `hermesc/osx-bin/hermesc` on `darwin`. Any other platform or architecture fails with a clear "unsupported platform" message, never a silent skip.
   - If the binary is not executable (`EACCES`, a possible lost exec bit on POSIX), say so.
   - On failure, translate every `bundle.js:L:C` in `hermesc`'s output back to the original module path and line using the source map, and print both.
6. **Report.** Print step timings and this disclaimer every time: *"Checked: Metro bundles the React Native entry with the React Native 0.83 toolchain, and legacy Hermes compiles it. Not checked: running it, globals and polyfills, native modules (rn-leveldb), or anything on a device."* A green check must not read as "works on a phone".

## Wiring and docs

- Root `package.json`: `"check:rn": "yarn workspace @optimystic/rn-bundle-check run bundle-check"`. Chain it into `check` after `yarn typecheck` and before `yarn test`, because it needs `dist/`.
- `docs/releasing.md`: add a row to the `yarn check` step table and one sentence on what it does not cover.
- `AGENTS.md` (~line 113): add `check:rn` to the gate list, with a short paragraph on the linker requirement and the disclaimer.
- `packages/db-p2p/readme.md` § React Native:
  - Mention the check and that it mirrors the shim table.
  - **Fix the TextDecoder gap the spike surfaced.** Evaluating the bundle in an engine without `TextDecoder` fails at module load (`ReferenceError: TextDecoder is not defined`), because a dependency constructs one at load time. The sereus reference app traced it to `uint8arrays`. The readme lists `TextDecoder` under "Built-in (no polyfill needed)" as "built-in to Expo SDK 52+". Hermes CLI v0.13 lacks it (verified), and the sereus polyfill notes that bare React Native 0.85's Hermes lacks it too. Move it into the global polyfill table: required unless the runtime provides it (Expo SDK 52+ does, bare React Native does not); a UTF-8-only shim is enough.
- `eslint.config.js`: extend the `NO_STATIC_BLOCK` comment. Lint gives instant feedback on the one known construct; `yarn check:rn` is the backstop for the whole class (any syntax Metro or legacy Hermes rejects).
- `entry-parity.spec.ts`: update the NOTE at lines 25-29 to say the routing is now asserted by `yarn check:rn`.

# Edge cases & interactions

- **The check must be seen to fail on the known instance (manual, then revert).** Add a `static { }` block to a class in `packages/db-p2p/src/storage/block-latch.ts` (lint will object; skip lint for this experiment), run `yarn build` then `yarn check:rn`. It must fail at the bundle stage naming `packages/db-p2p/dist/src/storage/block-latch.js`. `tsconfig.base.json` targets ES2022, so `tsc` emits static blocks unchanged (confirmed) and Metro does see them. Revert, and record the output in the review handoff.
- **Syntax Babel passes but legacy Hermes rejects.** Covered by the `v`-flag fixture test below. The failure must name the fixture's source path via the source map, not only `bundle.js:L:C`.
- **Stale or missing `dist/`.** The freshness guard refuses with its remedy before Metro runs.
- **Plug'n'Play install.** The linker guard refuses with the message above.
- **A new Node builtin reached through a third-party package** (the GitHub #8 `path` case). The bundle fails with the resolve hint (fixture test below).
- **`react-native` condition repointed or removed** in `packages/db-p2p/package.json`. The routing assertion fails. Verify manually once by temporarily pointing the condition at `index.js`, then revert.
- **Portal-linked siblings.** `p2p-fret` resolves through `../Fret/packages/fret` and that checkout's own `dist`. A host gets the npm-published copy instead, so the check bundles the sibling's working tree, not what npm ships. Say so in the workspace readme. `@quereus/quereus` is not reachable from this entry, because db-p2p does not depend on it. If the `watchFolders` derivation finds no out-of-repo symlinks (a host that installed `p2p-fret` from npm), it must still work.
- **Concurrent runs.** `yarn test` (the fixture tests) and `yarn check:rn` can overlap in a maintainer's shells. Separate `mkdtemp` output directories avoid collisions, and the Metro FileStore tolerates concurrent readers.
- **Windows and POSIX.** Only Windows was exercised in the spike. Use argument arrays and `path.join` everywhere; the Linux and macOS binary selection is written but unverified here. Say that in the handoff.
- **Metro warnings** (the multiformats `exports` fallback) must not fail the check.
- **Undeclared-dependency guard.** Every bare import in the workspace (config, shims, scripts, tests) must be declared. Run `yarn lint:deps` and check that a trailing-slash specifier such as `require.resolve('buffer/')` is understood; if not, use `'buffer'`.
- **ESLint.** Keep fixtures out of `packages/*/src/**/*.ts` (where `NO_STATIC_BLOCK` applies), for example as `test/fixtures/*.js`. `eslint .` still parses them, and ES2022+ parsing accepts static blocks and the `v` flag. Confirm `yarn lint` stays green.

# Tests (workspace `test` script, `node --test`, runs in `yarn test`; no `yarn build` needed — fixtures import nothing from `@optimystic/*`)

- `test/static-block.test.mjs`: `bundle()` on `test/fixtures/static-block.js` (a class with `static x = new Map(); static { ... }`) rejects; the error contains the fixture file name and `Static class blocks`.
- `test/hermes-syntax.test.mjs`: `bundle()` on `test/fixtures/unicode-sets-regex.js` (`export const re = /[\p{L}--[a-z]]/v;`) succeeds; `compile()` fails with non-zero exit; the reported message contains `unicode-sets-regex.js` (source-map translation) and `Invalid regular expression`.
- `test/node-builtin.test.mjs`: `bundle()` on a fixture that does `import 'node:path'` fails with the readme-gap hint.
- `test/shim-table-parity.test.mjs` (pure, no Metro): parse the db-p2p readme's "Node.js built-in module shims" table (`| \`os\` / \`node:os\` | …` rows) and assert the config's `extraNodeModules` keys equal those names in both spellings, plus the declared harness-only `react-native`. Fails if either side drifts.
- Expected full check on a clean `yarn build`: bundle and compile succeed in about 20 s cold; the routing assertion passes; the disclaimer prints.

# Why no run step

Executing the bundle was evaluated and parked in `backlog/feat-rn-bundle-runs-under-hermes`. In short: a load-only run does work under the standalone Hermes CLI with the readme's polyfills. But no current Hermes runtime is published for Windows (the newest is v0.13.0 from August 2024, a GitHub release download, not npm), and a solo-node smoke run did not come up in the time boxed for planning. The details are in that ticket.

# TODO

- Create `packages/rn-bundle-check` with `package.json` (pins above), `readme.md` (purpose, what it does not cover, toolchain-pin tripwire, portal note), `metro.config.cjs`, `entry.js`, `shims/node-os.js`, `shims/node-crypto.js`, `shims/react-native.js`; run `yarn install` and commit the lockfile change.
- Write `scripts/rn-bundle-check.mjs`: linker guard, freshness guard, routing assertion, bundle with source map into a `mkdtemp` directory, compile via argument array with platform binary selection, source-map error translation, timings plus disclaimer.
- Add root `check:rn` and chain it into `check` after `typecheck`.
- Add the four tests and fixtures; run `yarn workspace @optimystic/rn-bundle-check test`.
- Run `yarn build && yarn check:rn`; record timings.
- Manual failure proofs (static block in `block-latch.ts`; `react-native` condition repointed); record outputs and revert both.
- Readme: TextDecoder moved into the polyfill table; mention the check.
- Update `docs/releasing.md`, `AGENTS.md`, the `eslint.config.js` comment, and the `entry-parity.spec.ts` NOTE.
- Run `yarn lint`, `yarn lint:deps`, `yarn lint:docs` and `yarn test:harness`; all green.
