description: Our React Native build check only builds the networking package, not the Quereus plugin, even though React Native apps (sereus's among them) use the plugin. So a change that breaks the plugin on phones goes unnoticed until a downstream app fails to build. Add the plugin's two entry points to the check.
prereq: the-plugin-entry-loads-node-file-system-modules
architecture: packages/rn-bundle-check/readme.md
files:
  - packages/rn-bundle-check/entry.js (the stand-in React Native app entry that the check bundles)
  - packages/rn-bundle-check/package.json (add `@optimystic/quereus-plugin-optimystic` workspace dependency and `@quereus/quereus`, its peer)
  - packages/rn-bundle-check/metro.config.cjs (`outOfRepoLinkTargets()` and the NOTE above it; `watchFolders`)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (`EXPECTED_ROUTES`, `bundleAndCompile`, `freshnessProblem` → test-harness/build-freshness.mjs)
  - packages/rn-bundle-check/readme.md
  - packages/quereus-plugin-optimystic/README.md (a short React Native note, pointing at the db-p2p readme's shim table)
repro: verified
----

# Why

`yarn check:rn` (in `packages/rn-bundle-check`) bundles `entry.js` with Metro under the React Native 0.83 toolchain and compiles the bundle with legacy `hermesc`. `entry.js` imports only `@optimystic/db-core`, `@optimystic/db-p2p` (bare and `/rn`), `@optimystic/db-p2p-storage-rn` and two libp2p transports. It never imports `@optimystic/quereus-plugin-optimystic`. That is how the plugin's root entry came to import `fs`/`url`/`path` and `import.meta` without any check in this repo noticing (see `the-plugin-entry-loads-node-file-system-modules`). React Native apps do use the plugin. Sereus's `cadre-core` imports `@optimystic/quereus-plugin-optimystic/plugin`, and sereus's React Native reference app bundles `cadre-core`.

# What was measured (2026-09-17, Windows)

A probe entry importing the plugin's built `dist/index.js` was run through this check's own `bundle` and `compile` functions:

1. **Metro fails** with `Unable to resolve module path` from the plugin's `dist/index.js`. That is expected until the prereq lands.
2. With the Node imports stubbed out, Metro **then fails inside Quereus**: `Unable to resolve module temporal-polyfill from C:\projects\quereus\packages\quereus\dist\src\types\temporal-types.js`. This is a harness gap, not a product bug. `@quereus/quereus` is portal-linked (root `package.json` `resolutions`) to the sibling checkout `../quereus/packages/quereus`, and that repository hoists its dependencies to its **root** `node_modules` (`C:\projects\quereus\node_modules\temporal-polyfill`). `outOfRepoLinkTargets()` watches only the linked package directory, and Metro refuses files outside its watch folders. The NOTE above `outOfRepoLinkTargets()` predicted exactly this: "If it ever hoists them to its root `node_modules` … watch the sibling's workspace root instead." It trips as soon as Quereus enters the bundle.
3. With the sibling's repository root (`../quereus`) added to `watchFolders`, Metro bundled. `hermesc` then rejected `import.meta` in the plugin (fixed by the prereq). With that also stubbed out, **bundle and compile both passed**. So once the prereq lands, the only harness change needed is the watch-folder fix.
4. Re-run after the prereq, with no stubs (2026-09-17, Windows): a scratch entry importing the plugin's real `dist/index.js` and `dist/plugin.js`, this check's `metro.config.cjs` merged with `watchFolders` + `C:/projects/quereus`, then this check's own `compile`. Metro bundled in about 3 s (its transform cache was already warm for the shared libp2p and db-p2p modules) and `hermesc` compiled; about 13 s end to end. Only the usual `multiformats` "not listed in exports" resolver warnings appeared.

# Requirements

- `entry.js` imports both `@optimystic/quereus-plugin-optimystic` (root) and `@optimystic/quereus-plugin-optimystic/plugin`, and touches each namespace the way the existing imports are touched in `reached`, so neither reads as dead code. Update its header comment: the entry now also covers what a React Native app imports from the Quereus plugin.
- `package.json` declares `@optimystic/quereus-plugin-optimystic` (`workspace:^`) and `@quereus/quereus` (the plugin's peer). A direct workspace dependency also brings the plugin's `dist` under the build-freshness step (`test-harness/build-freshness.mjs`), so a stale plugin build is refused before bundling. Confirm it does.
- `metro.config.cjs`: an out-of-repo link target whose own repository hoists dependencies must have that repository's root watched. Recommended: for each link target, walk up to the nearest ancestor whose `package.json` declares `workspaces`, and watch that ancestor. Fall back to the link target itself when there is none, as for Fret today. Update the NOTE to describe the new behaviour, and state what widening the watch costs: Metro crawls the whole sibling checkout. Measure the cold and warm run times before and after, and put the numbers in the readme's timing paragraph. The readme's "Sibling repositories are bundled from their working trees" gap now covers Quereus as well as Fret; say so.
- Routing: the plugin imports bare `@optimystic/db-p2p`, which must land on `dist/src/rn.js` under React Native. The route recorder records every resolution, so check that the existing `EXPECTED_ROUTES` assertion also covers the plugin's own import. If it only covers the first resolution it sees, extend it so that an import coming through the plugin is checked too.
- The check must stay under the runner's 10-minute idle limit. The probe's cold runs were well inside it, but record the real numbers.
- `packages/quereus-plugin-optimystic/README.md` gains a short React Native note: both entries bundle for React Native with the shims in the db-p2p readme's table, plus whatever the plugin itself needs. The Metro run tells you whether it needs anything more. None was needed in the probe beyond the existing table.

# Not in scope

- Running the bundle on a Hermes runtime: backlog `feat-rn-bundle-runs-under-hermes`.
- Pruning the shim table: backlog `debt-rn-shim-table-lists-unreached-aliases`. Adding Quereus and the plugin to the bundle may change which shims are reached, so mention anything you observe on that ticket as evidence.

# TODO

- Add the two dependencies to `packages/rn-bundle-check/package.json`, run `yarn install`, and extend `entry.js`.
- Run `yarn check:rn` and confirm it fails on the `temporal-polyfill` watch-folder gap. It should get past the plugin's `fs`/`import.meta`, because the prereq has landed.
- Change `outOfRepoLinkTargets()` / `watchFolders` to watch the sibling repository's workspace root, and update the NOTE.
- Confirm the plugin's `@optimystic/db-p2p` import is covered by the routing assertion, and extend it if not.
- Run `yarn check:rn` and `yarn workspace @optimystic/rn-bundle-check test`. Record the cold and warm timings.
- Update `packages/rn-bundle-check/readme.md` (what the entry covers, sibling-repository gap, timings) and the plugin README's React Native note. Run `yarn lint:docs` and `yarn lint:deps`.
