description: Our React Native build check now also bundles and compiles both entries of the Quereus plugin (and, through it, Quereus itself), so a change that breaks the plugin on phones fails in this repository instead of in a downstream app's build.
prereq: the-plugin-entry-loads-node-file-system-modules
architecture: packages/rn-bundle-check/readme.md
files:
  - packages/rn-bundle-check/entry.js (imports both plugin entries)
  - packages/rn-bundle-check/package.json, yarn.lock (`@optimystic/quereus-plugin-optimystic` workspace dep, `@quereus/quereus` ^4.19.4)
  - packages/rn-bundle-check/metro.config.cjs (`siblingWatchRoots`, `siblingWorkspaceRoot`, `declaresWorkspaces`; NOTE with measured crawl cost)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (comments only: `EXPECTED_ROUTES`, `createRouteRecorder`, bundle size in `createOutputDir` NOTE)
  - packages/rn-bundle-check/test/route-recorder.test.mjs, test/fixtures/routed-twice.js, test/fixtures/nested/routed.js, test/fixtures/nested/routed-target.js
  - packages/rn-bundle-check/readme.md
  - packages/quereus-plugin-optimystic/README.md (new "React Native" section)
  - tickets/backlog/debt-rn-shim-table-lists-unreached-aliases.md (evidence appended)
----

# What was done

`yarn check:rn` bundles `packages/rn-bundle-check/entry.js` with Metro under the React Native 0.83 toolchain and compiles it with legacy `hermesc`. The entry now also imports `@optimystic/quereus-plugin-optimystic` and `@optimystic/quereus-plugin-optimystic/plugin` and touches both namespaces in `reached`. The workspace declares the plugin (`workspace:^`) and its peer `@quereus/quereus` (`^4.19.4`, the range the plugin's own devDependency uses).

## Watch folders: implemented as the ticket recommended, but the premise shifted

The ticket expected the bundle to fail on `temporal-polyfill` until the sibling Quereus checkout's root was watched. **It did not fail.** Once this workspace declares `@quereus/quereus` directly, Yarn installs the portal's dependencies into `packages/rn-bundle-check/node_modules`, and Metro reaches them through the `nodeModulesPaths` fallback. I recorded where they landed: `temporal-polyfill`, `moat-maker`, `inheritree`, `fast-json-patch` all resolved to this workspace's copies, not to `../quereus/node_modules`, which is where Node loads them from. The ticket's probe did not declare `@quereus/quereus`, which is why it failed there.

I implemented the root watch anyway: `siblingWatchRoots()` maps each out-of-repo link target to the nearest ancestor whose `package.json` declares `workspaces` (`../quereus`, `../Fret`), falling back to the target itself. The reasons: Metro then resolves the same copies Node does; the check stops depending on which workspaces happen to declare what; and it matches sereus's reference-app Metro config, which watches both sibling roots. After the change, the four dependencies above resolve to `C:\projects\quereus\node_modules\...` (verified). The walk stops before reaching a directory that contains this repository, so a stray manifest in the parent directory cannot widen the watch to every project on the machine. It also stops at a filesystem root, for a target on another drive. **Reviewer: if you think the fallback behaviour is good enough and the crawl is not worth it, this is the decision to challenge.** The NOTE above `siblingWatchRoots` spells out both mechanisms.

## Routing assertion

No change was needed. Metro keys its resolution cache by the importing module's directory, so it resolves the same specifier separately from each directory and the route recorder sees every resolution. I verified this with a probe that logged origins: bare `@optimystic/db-p2p` is resolved from `entry.js`, from `packages/quereus-plugin-optimystic/dist/index.js` and from `packages/db-p2p-storage-rn/dist/src/leveldb-storage.js`, and all three land on `packages/db-p2p/dist/src/rn.js`. A new test locks the behaviour in: `judges every importer of a specifier, not only the first`. It bundles a fixture in which the same specifier is imported from two directories, the first resolution correct and the second elsewhere, and asserts that the second is reported as a misroute. Comments on `EXPECTED_ROUTES` and `createRouteRecorder` now say this.

## Build freshness

This was verified. The freshness step now judges `@optimystic/quereus-plugin-optimystic` and `@quereus/quereus`, whose portal link is now present in this workspace's `node_modules`. `p2p-fret` is still not judged. Proof: I pushed one plugin `src` file's mtime an hour ahead and `buildFreshnessProblems` reported "dist is stale" for the plugin. I then restored the mtime (to within 1 ms) and it reported nothing.

## Timings (Windows, 2026-09-17, `yarn check:rn` wall clock)

"Cold" here means this check's Metro transform cache and its `metro-file-map-*` caches in `%TEMP%` were deleted first. The OS file cache stayed warm.

| | cold | warm |
|---|---|---|
| Before (old entry, old config) | 15.8 s (Metro 8.1, hermesc 6.7) | 9.4 s (Metro 1.8–1.9, hermesc 6.6) |
| After | 22.3 s (Metro 10.5, hermesc 10.8) | 14.3 s (Metro 2.6, hermesc 10.7) |

The bundle grew from 12 MB to 22 MB, and most of the added time is hermesc. The wider watch alone costs about 0.4 s on a warm bundle: with the new entry, 2.2 s watching only the linked packages against 2.6 s watching the sibling roots, over three runs each. Both runs stay well inside the 10-minute idle limit. The old readme said about 30 s cold, but my baseline measured 15.8 s under the definition above, so the readme now gives only my numbers.

## Shims

Quereus and the plugin need nothing beyond the db-p2p shim table. The bundle still requests only `node:os` and the harness-only `react-native` stub. That is recorded as evidence on `debt-rn-shim-table-lists-unreached-aliases`.

# Validation run

- `yarn check:rn`: passes.
- `yarn workspace @optimystic/rn-bundle-check test`: 8/8 pass, including the new route test.
- `yarn lint:docs`, `yarn lint:deps`, and `npx eslint packages/rn-bundle-check`: clean.

# Known gaps and things for the reviewer to probe

- **Plugin README runtime claim is from reading the code, not from running it.** The new React Native section says the plugin's `network` transactor cannot build its own node on React Native. `CollectionFactory.createNetworkTransactor` calls `createLibp2pNode` without `transports`, and db-p2p's React Native `createLibp2pNode` throws without them. The section tells hosts to call `plugin.collectionFactory.registerLibp2pNode(networkName, node, node.coordinatedRepo)`, as sereus's `cadre-core` does (`control-database.ts`), and says a registered node matches only tables whose `port` is `0` (the key is `${networkName}:0`). Nothing in this repository runs the plugin on Hermes; see backlog `feat-rn-bundle-runs-under-hermes`. Whether the plugin should accept host transports itself is a feature question I did not file.
- **The new config helpers have no unit tests.** `siblingWorkspaceRoot` and `declaresWorkspaces` are internal to `metro.config.cjs`, as `outOfRepoLinkTargets` already was. They are exercised end to end by `yarn check:rn` with the real sibling layout. The stop at a directory that holds this repository and the stop at a drive root are not exercised by anything.
- The route test depends on Metro resolving the entry's own dependency before the nested module's. That is the realistic order, but a recorder that kept only the *first* resolution would still pass this test if Metro ever reversed the order.
- As before, only Windows has been run.
