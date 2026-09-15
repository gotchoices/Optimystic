description: An automated check now builds our React Native entry point with the same bundler and JavaScript-engine compiler a phone app uses, so code that would break a phone app's build fails in this repository instead of in someone else's project.
files:
  - packages/rn-bundle-check/package.json, readme.md, metro.config.cjs, entry.js
  - packages/rn-bundle-check/shims/node-os.js, shims/node-crypto.js, shims/react-native.js
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs
  - packages/rn-bundle-check/test/*.test.mjs, test/fixtures/*.js
  - package.json (root: `check:rn`, chained into `check` after `typecheck`), yarn.lock
  - test-harness/build-freshness.mjs (`SKIP_ENV` exported)
  - packages/db-p2p/readme.md, packages/db-p2p/test/entry-parity.spec.ts, eslint.config.js, docs/releasing.md, AGENTS.md, README.md
----

# What landed

`yarn check:rn` builds our React Native entry the way a phone app's release build does. It bundles a host-shaped `entry.js` with **Metro** (React Native's bundler, running Babel with the React Native preset) and compiles the bundle with **`hermesc`** (the compiler for Hermes, React Native's JavaScript engine). Every other test here runs on Node, so syntax that breaks either step used to surface only in a downstream app. The known instance is a class `static { }` block, which did exactly that on 2026-09-14.

It lives in the private workspace `packages/rn-bundle-check`, which stands in for a host app, and runs inside `yarn check` after `yarn build` and `yarn typecheck`. The toolchain is pinned to React Native 0.83: `metro@0.83.8`, `metro-cache@0.83.8`, `@react-native/metro-config@0.83.10`, `@react-native/babel-preset@0.83.10` and `hermes-compiler@0.14.1`. The workspace readme explains why they move together.

`scripts/rn-bundle-check.mjs` runs these steps in order:

1. Refuse an install Metro cannot use.
2. Refuse a stale or missing `dist/`.
3. Bundle with Metro (Android, production, Hermes profile, unminified, with a source map).
4. Assert that `@optimystic/db-p2p` and `@optimystic/db-p2p/rn` both resolved to `packages/db-p2p/dist/src/rn.js`.
5. Compile with `hermesc -emit-binary -O`, with bundle positions in errors translated back to source files.

It never executes the bundle; running it is `backlog/feat-rn-bundle-runs-under-hermes`. The implement handoff lists every deviation from the plan and every proof run: static block, repointed export condition, missing build.

# Review findings

Read the implement diff (`ad25474e`) first, then every new file in the workspace, the modified docs and comments, `test-harness/build-freshness.mjs`, the db-p2p readme's React Native section, db-p2p's `exports`, and the Metro, `metro-cache` and `metro-file-map` source behind the config choices.

## Validation run in this pass (Windows 11)

- `yarn check:rn` passed three times: 13.0 s and 10.2 s warm, and 19.7 s while the workspace tests ran at the same time.
- `yarn workspace @optimystic/rn-bundle-check test` passed 7/7 after this pass's changes.
- `yarn lint`, `yarn lint:docs` and `yarn lint:deps` (859 files across 12 packages) all passed after the changes.
- **Not run:**
  - Full `yarn check`, root `yarn test` fan-out, `yarn typecheck`, `yarn test:integration`. Outside the workspace, this pass only changed one README line. The implementer ran `yarn test:harness` against the one harness change.
  - Linux and macOS. Still unexercised; the existing `NOTE:` on `hermescBinary` covers it.

## Correctness — found and fixed

- **Metro crawled the check's own output.** `watchFolders` covers the repository root, so Metro walked the 46 MB transform cache and every run's output directory. When the tests and `check:rn` ran at the same time, Metro printed `Error "ENOENT" reading contents of …\runs\run-AAdMGA, skipping. Add this directory to your ignore list` (observed). `metro.config.cjs` now adds the workspace cache directory to `resolver.blockList`, after Metro's default pattern. The pattern was checked against absolute paths: it matches the cache directory and everything under it, and not a sibling name, `entry.js`, or db-p2p's `dist`. A second concurrent run printed no error.
- **The install refusal named the wrong cause.** It reported "this install uses Plug'n'Play" whenever `packages/rn-bundle-check/node_modules` was absent. A hoisted node-modules install also leaves that directory absent. `metro.config.cjs` also needs `nmHoistingLimits: workspaces` to find portal links in each workspace's `node_modules`. The message now names which condition failed and asks for both settings. The readme's step 1 was updated to match.

## Tests — gap found and filled

- **The routing assertion had no automated test.** It is what the entry-parity comment and the db-p2p readme now rely on to catch a repointed `react-native` condition, and it had only a manual proof. The route logic moved from three free functions over a shared `Map` into an exported `createRouteRecorder(expected)`. `test/route-recorder.test.mjs` bundles a two-file fixture through the real resolver hook and asserts three outcomes: a correct route passes, a wrong route names both paths, and an expected specifier the bundle never imports is reported. The readme's test list was updated.
- The other paths the handoff lists as never run were read and left untested: the Plug'n'Play branch, the skip variable, the `EACCES`/`ENOENT` messages, the `rn-leveldb` hint, and "kept for inspection". Each is a message on an error path whose logic is a single branch, and reproducing it needs a broken install. Not worth fixtures.

## Docs and comments — found and fixed

- The script header still said only the bare specifier's route was asserted; it now names both.
- The `EXPECTED_ROUTES` comment pointed at "the NOTE in entry-parity.spec.ts". The implementer had rewritten that NOTE away; the comment now stands alone.
- The root `README.md` package list, which includes other dev tooling such as the substrate simulator, now lists `packages/rn-bundle-check`.
- Checked and accurate: `AGENTS.md`, `docs/releasing.md` (both enumerations of the `yarn check` chain), the `eslint.config.js` comment, the two rewritten `entry-parity.spec.ts` comments (consistent with the implementer's routing proof, where Metro fails on `net`), and the workspace readme.
- `docs/architecture.md`'s package table lists only runtime packages, so the workspace was correctly left out.
- **Not independently verified:** the db-p2p readme's new `TextDecoder` row says bare React Native's Hermes lacks `TextDecoder`. That is consistent with the implementer's source-map evidence for which modules construct one at load, but no Hermes runtime was available here to confirm it. `feat-rn-bundle-runs-under-hermes` would settle it.

## Filed

- **`backlog/debt-rn-shim-table-lists-unreached-aliases`.** The bundle was run through the exported `bundle()` with an `onResolve` callback that recorded every aliased name. Of the readme's eight shim specifiers, only `node:os` is ever requested (plus the harness-only `react-native` stub); `crypto`, `stream` and `buffer` in both spellings never are. The table therefore tells apps to install packages the recipe does not need. An unused `buffer` alias would also let a new `import 'buffer'` bundle silently. The ticket is framed as a boundary invariant, not a readme edit: the check should report aliases nothing resolves, just as it already reports unimported routes. The site-claim grep of open tickets found nothing else touching the shim table; `feat-rn-bundle-runs-under-hermes` is about runtime polyfills, a different site.

## Tripwires placed

- `scripts/rn-bundle-check.mjs`, `createOutputDir`: nothing prunes `runs/`. A run kept after a hermesc failure, or killed mid-bundle, stays on disk at about 12 MB each; if they pile up, prune old `run-*` directories there.

## Considered and left as is

- **Disclaimer only on passing runs** (the implementer's open question). Kept. On a failure the reader needs the failure, and its "Checked: …" half would be false.
- **Concurrent runs sharing the Metro transform cache.** `metro-cache`'s `FileStore` treats a truncated JSON entry as a cache miss (`SyntaxError` → `null`), so a torn read costs a re-transform, not a wrong result. No tripwire needed.
- **`resolver.nodeModulesPaths` pointing at the workspace's `node_modules`.** It can satisfy an undeclared import from `packages/*/dist` at bundle time. That is the same resolution a flat app install gives, and `check-undeclared-deps` guards the libraries' manifests. Kept.
- **Sixteen `multiformats` resolver warnings per run.** A host app sees the same ones, and they are deduplicated. Silencing them would hide a change in their number.
- **Security and supply chain.** `hermesc` is spawned with an argument array; `hermes-compiler` has no install scripts; the workspace is `private`, so `yarn pub`'s `--no-private` skips it.
- **Types, performance and file size.** Nothing found. The script is about 400 lines in four labelled sections of short functions. Warm run time is dominated by `hermesc` (8 s), which compiles a 12 MB bundle, as a release build does.
