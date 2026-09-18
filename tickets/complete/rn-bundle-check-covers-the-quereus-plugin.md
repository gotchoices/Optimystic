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
  - AGENTS.md, docs/releasing.md (review: scope wording)
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

# Review findings

Reviewed the implement diff (6ae02008) first, then the handoff. Ran `yarn check:rn` (passes, Metro 2.7 s, hermesc 10.7 s warm), `yarn workspace @optimystic/rn-bundle-check test` (8/8), `yarn lint:docs` and `npx eslint packages/rn-bundle-check` (clean), before and after the fixes below.

## Fixed in this pass (minor)

- **Route test was order-dependent, as the handoff said.** `judges every importer of a specifier, not only the first` now runs two recorders over one bundle, one expecting each of the two resolutions, so a recorder that keeps only the first *or* only the last resolution fails regardless of Metro's order. Verified by mutation: a keep-first recorder fails the test; the mutation was reverted.
- **A misroute did not say who imported the wrong file.** With several importers of bare `@optimystic/db-p2p` (entry.js, the plugin, db-p2p-storage-rn), "resolved to X instead of Y" left the reader guessing, and the remedy pointed only at db-p2p's `exports`, which is wrong when an importer has its own copy. `onResolve` now also receives Metro's `context.originModulePath`; the recorder keeps importers per resolved path and the message reads `X (imported by A) instead of Y`, and also suggests checking that the importer reaches the workspace copy. Both route tests assert the importer. Readme step 4 says so.
- **Plugin README port rule was imprecise.** "whose `port` is `0` (the default)" ignored the plugin's `default_port` setting (`optimystic-module.ts` resolves `port` from the table argument, then `default_port`, then 0). Reworded. The rest of the section's runtime claims were checked against source: `createNetworkTransactor` calls `createLibp2pNode` without `transports`, db-p2p's React Native `createLibp2pNode` throws without them, `registerLibp2pNode` keys `${networkName}:0`, and `register` returns `collectionFactory`. Still static, not run (see below).
- **`declaresWorkspaces` rethrew a bare JSON parse error**, which would not name the sibling manifest that broke Metro config loading. It now names the file, like `linkTarget` does.
- **Docs that should have been touched:** AGENTS.md and docs/releasing.md described `yarn check:rn` as bundling only "the React Native entry"; both now mention the Quereus plugin.

## Decision the implementer asked to have challenged: watching whole sibling checkouts

Kept. Resolving a linked package's dependencies from its own repository's install is what Node does and what sereus's reference Metro config does; the alternative only works because this workspace happens to declare `@quereus/quereus`, which is a fragile reason for a check to pass. Measured cost (0.4 s warm) is recorded in the NOTE above `siblingWatchRoots`, with the remedy if it grows. Either choice bundles a working tree rather than the published package, which the readme already lists as a gap.

## Tripwires recorded

- `siblingWorkspaceRoot`'s two stop conditions (parent directory holding this repository, drive root) are exercised by nothing: `NOTE:` added above the function in `metro.config.cjs`, saying to move it into a testable module if the walk gains another case. Not filed: both stops are defensive and only the found-a-root path runs on any known layout.

## Checked, nothing to do

- **Freshness step**: `buildFreshnessProblems` derives candidates from `workspace:` ranges and root `resolutions` portals, so the plugin and Quereus are judged with no code change; `p2p-fret` remains uncovered, as the readme and the NOTE in `test-harness/build-freshness.mjs` already say.
- **The `@quereus/quereus` direct dependency** is still needed with the root watch: the plugin declares Quereus as a peer, which the depending workspace must provide, and it is what brings Quereus into the freshness step.
- **Shims**: no new alias needed; evidence already on `debt-rn-shim-table-lists-unreached-aliases`.
- **Resource cleanup**: test output directories are removed in `t.after`; unchanged.
- **Plugin cannot take host transports on React Native** (it only accepts a pre-built node through `registerLibp2pNode`): not filed. The workaround is documented and is what sereus's `cadre-core` already does; whether the plugin should accept transports is a feature question nobody has asked for.
- **Running the plugin on Hermes** remains out of scope, tracked by backlog `feat-rn-bundle-runs-under-hermes`.
- Only Windows has been run, as before.
