# @optimystic/rn-bundle-check

A private workspace, never published. It stands in for a React Native app, so that `yarn check:rn` can build our React Native entry the way a phone app's release build does.

## Why this exists

Every other test in this repository runs on Node. A React Native app does two things Node never does:

1. It bundles our packages with **Metro**, React Native's bundler, which transforms every module with Babel and the React Native preset.
2. It compiles that bundle to bytecode with **`hermesc`**, the compiler for Hermes, React Native's JavaScript engine.

Code can pass every Node test and still break either step. A class `static { }` block did, in a downstream app, on 2026-09-14. Lint now bans that one construct in library source; this check catches the whole class.

## What `yarn check:rn` does

Run it from the repository root; `yarn check` also runs it, after `yarn build`. `scripts/rn-bundle-check.mjs`:

1. **Refuses an install Metro cannot use.** Metro resolves through real `node_modules` directories, and `metro.config.cjs` finds portal links in each workspace's own `node_modules`, so it needs Yarn's `nodeLinker: node-modules` with `nmHoistingLimits: workspaces`. `.yarnrc.yml` is gitignored, so a fresh clone has neither setting.
2. **Refuses a stale or missing `dist/`** in the four `@optimystic` packages it imports and in Quereus, whose working copy the root `resolutions` link in. It uses the same derivation as the test suites' guard (`buildFreshnessProblems` in `test-harness/build-freshness.mjs`) and the same `OPTIMYSTIC_SKIP_BUILD_CHECK` escape hatch.
3. **Bundles `entry.js`** with `metro.config.cjs`: Android, production mode, the Hermes transform profile, unminified, with a source map.
4. **Checks export routing.** `@optimystic/db-p2p` and `@optimystic/db-p2p/rn` must both resolve to `packages/db-p2p/dist/src/rn.js`, from every module that imports them: `entry.js`, and also the Quereus plugin and `@optimystic/db-p2p-storage-rn`, which import bare `@optimystic/db-p2p` themselves. A wrong route is reported with the module that imported it. If the `react-native` export condition were repointed or dropped, a React Native app would silently get the Node entry; this step fails instead.
5. **Compiles the bundle** with `hermesc -emit-binary -O`, as a release build does. On failure, every `bundle.js:line:column` in the compiler's output is followed by the original file, line and column, read from the source map.

`entry.js` imports what [the db-p2p readme](../db-p2p/readme.md#react-native) tells a React Native app to import, plus both entries of the Quereus plugin (`@optimystic/quereus-plugin-optimystic` and its `/plugin` subpath), which React Native apps use too: sereus's `cadre-core` imports `/plugin`. The plugin brings Quereus itself into the bundle. `metro.config.cjs` aliases exactly the Node built-in module shims that readme's table lists, and `test/shim-table-parity.test.mjs` fails if the two drift apart. If the bundle only succeeds with an alias the table lacks, the readme has a gap: add the row in the same change. The config's one extra alias, a stub for the `react-native` package, exists only because this workspace does not install React Native itself.

On the Windows machine it was built on (measured 2026-09-17), a passing `yarn check:rn` took about 14 seconds with a warm Metro cache (Metro 2.6 s, `hermesc` 10.7 s) and about 22 seconds with Metro's caches cleared (Metro 10.5 s, `hermesc` 10.8 s). Before the Quereus plugin was added, the same runs took about 9 and 16 seconds. Nearly all of the difference is `hermesc` compiling a bundle that grew from 12 MB to 22 MB; watching the sibling checkouts whole (see below) costs about 0.4 s of a warm run. Metro prints a handful of warnings about `multiformats` importing files its own `exports` map does not list. A host app sees the same warnings, and they never fail the check.

## What it does not check

Nothing is executed. A passing run says nothing about:

- **Globals and polyfills.** A missing `TextDecoder`, or Node's `Buffer` used where Hermes has none, still passes.
- **Native modules.** `rn-leveldb` is never bundled: `@optimystic/db-p2p-storage-rn` has the host app pass its constructors in (`packages/db-p2p-storage-rn/src/rn-opener.ts`).
- **Anything on a device.**

Running the bundle under a Hermes runtime is parked as the backlog ticket `feat-rn-bundle-runs-under-hermes`.

Two narrower gaps:

- **Sibling repositories are bundled from their working trees.** `@quereus/quereus` and `p2p-fret` resolve through their portal links to `../quereus/packages/quereus` and `../Fret/packages/fret`: each checkout's own `dist/`, with the dependencies that checkout installed for itself, where a host app gets the published npm packages and its own install. To reach those dependencies, `metro.config.cjs` watches each sibling's whole checkout (`siblingWatchRoots`), because Quereus installs them at its repository root rather than beside the package. The freshness step covers Quereus, which this workspace declares, but not `p2p-fret`, which it does not.
- **Only Windows has been exercised.** The Linux x64 and macOS binary choices (`hermescBinary` in `scripts/rn-bundle-check.mjs`) follow the `hermes-compiler` package layout, and that package ships those binaries with their exec bit set, but neither has been run. Any other platform fails with a message rather than skipping.

## The toolchain pin

`package.json` pins one React Native release's toolchain to exact versions:

| Package | Version |
|---|---|
| `metro`, `metro-cache` | 0.83.8 |
| `@react-native/metro-config`, `@react-native/babel-preset` | 0.83.10 |
| `hermes-compiler` | 0.14.1 |

These move **together**. Each React Native release pairs a Metro version, a Babel preset and a Hermes compiler, and mixing releases gives failures no real app would see. For example, React Native 0.87's preset leaves private class fields untransformed because its Hermes supports them, and the 0.83 compiler then rejects them.

React Native 0.83 is the target because it is the newest release on legacy Hermes, and the only one whose compiler is a standalone npm package. Legacy Hermes is the stricter engine, so what it compiles also compiles on the newer Hermes V1 (React Native 0.84 and later). Downstream apps are still on legacy Hermes; the sereus reference app is on React Native 0.79. The tradeoff: an app on React Native 0.79–0.81 runs an older Babel preset than 0.83's, and a difference between those presets would go unseen here.

NOTE: once the oldest React Native version we support is on Hermes V1 (0.84+), move the whole set to that release in one change: `metro` and `metro-cache`, `@react-native/metro-config`, `@react-native/babel-preset`, and `hermes-compiler`, whose Hermes V1 releases are numbered `250829098.x`.

## Tests

`yarn workspace @optimystic/rn-bundle-check test`, also run by `yarn test`. The fixtures import nothing from `@optimystic/*`, so no build is needed.

- `test/static-block.test.mjs`: a class `static { }` block fails the bundle stage, and the error names its file.
- `test/hermes-syntax.test.mjs`: a regular expression with the `v` flag passes Metro and fails `hermesc`, reported against the fixture's own line.
- `test/node-builtin.test.mjs`: an unshimmed Node built-in fails with a pointer to the readme's shim table.
- `test/shim-table-parity.test.mjs`: the Metro aliases match the readme's shim table.
- `test/hermesc-binary.test.mjs`: each supported platform's binary exists in the installed `hermes-compiler`, and other platforms are refused.
- `test/route-recorder.test.mjs`: the routing step passes a specifier that resolves where expected, and reports one that resolves elsewhere or is never imported. A second importer of the same specifier is judged too, so a wrong route is reported even when the first importer's route was right.
