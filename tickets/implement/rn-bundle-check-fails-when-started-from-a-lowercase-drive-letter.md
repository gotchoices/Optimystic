description: On Windows, `yarn check:rn` fails with "Unable to resolve module p2p-fret" whenever it is started from a shell whose current directory has a lowercase drive letter (`c:\projects\optimystic`), because Metro then sees this repository and the sibling repositories under two different spellings of the same drive. The check should give the same answer however the drive letter is spelled.
architecture: packages/rn-bundle-check/readme.md
files:
  - packages/rn-bundle-check/metro.config.cjs (`workspaceDir`, `repoRoot`, `packageDir`, `linkTarget`)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (`WORKSPACE_DIR`, `REPO_ROOT`, `CONFIG_PATH`, `ENTRY_PATH`, `bundle`)
  - packages/rn-bundle-check/readme.md
  - packages/rn-bundle-check/test/ (new spec)
repro: verified
----
# `yarn check:rn` breaks when the drive letter is spelled lowercase

This replaces the fix ticket `rn-bundle-check-keeps-a-file-map-crawled-while-a-sibling-was-rebuilding`. That ticket blamed a stale Metro file-map cache written while Fret's 1.0.0 release was rebuilding `../Fret/packages/fret/dist`. Reproduction showed the cache and the Fret release were both incidental.

## What actually happens

The failing runs' cache file was `%TEMP%\metro-file-map-6421d15b…-29bdd9a2…`. Metro names that file `metro-file-map-<md5 of the project root>-<md5 of the build parameters>`, and `6421d15b2e1eb7d4da851f20786233b1` is the md5 of `c:/projects/optimystic/packages/rn-bundle-check` — **lowercase `c:`**. A normal run's file is `bd0a09bb…`, the md5 of the `C:` spelling. So the failing runs were started from a lowercase-drive directory, and the run that "passed after deleting the cache" was very likely started from an uppercase one, which reads a different cache file altogether.

Verified on 2026-09-30 (Windows, Node 24.2, Metro 0.83.8), with Fret untouched:

- Spawning `node <c:/…>/packages/rn-bundle-check/scripts/rn-bundle-check.mjs` with cwd `c:/projects/optimystic/packages/rn-bundle-check` fails with the exact reported error (`p2p-fret could not be found within the project or in these directories: ..\db-p2p\node_modules …`) and writes the `6421d15b…-29bdd9a2…` cache file.
- Deleting that cache file and rerunning from the same lowercase cwd fails again (now naming `rebalance-monitor.js`, as the ticket's second run did). The cache is not the cause.
- Same lowercase cwd, but the script path spelled `C:/…`, passes. What matters is the spelling of the paths the config and script derive from their own module locations (`__dirname`, `import.meta.url`), which under `yarn` follows the shell's cwd. PowerShell normalizes its cwd to `C:`, so it does not reproduce there; a VS Code terminal or a runner that spawns with a lowercase cwd does.
- Hiding Fret's `dist/src/index.js` or its `package.json` for one run (what a release does mid-rebuild) fails with different messages ("main module field could not be resolved"), and the very next run passes. A disappearing sibling file does not stick.

## Why the spelling breaks Metro

metro-file-map stores every file under a path relative to the project root, computed by `RootPathUtils.absoluteToNormal` (`metro-file-map/src/lib/RootPathUtils.js`). That comparison is case-sensitive. With the project root `c:\projects\optimystic\packages\rn-bundle-check`:

| absolute path | stored as |
|---|---|
| `c:\projects\Fret\packages\fret\package.json` | `..\..\..\Fret\packages\fret\package.json` |
| `C:\projects\Fret\packages\fret\package.json` | `..\..\..\..\..\C:\projects\Fret\packages\fret\package.json` |

`metro.config.cjs` hands Metro mixed spellings:

- `workspaceDir = __dirname` and `repoRoot = fs.realpathSync(...)` keep whatever spelling the module was loaded under (the JS `realpathSync` does not canonicalize the drive letter; `fs.realpathSync.native` does).
- `siblingWatchRoots()` gets the sibling roots from `fs.realpathSync` of the portal junctions, and a junction stores its target as Yarn wrote it, `C:\projects\Fret\packages\fret`.

So the watch folders are `c:\projects\optimystic`, `C:\projects\Fret`, `C:\projects\quereus`, Fret's files are crawled under the garbage key, and the `p2p-fret` junction's target never meets them. A standalone metro-file-map harness confirms it: a lowercase root plus an uppercase sibling root loses the sibling through the link; every root in one spelling finds it. A junction whose *stored target* is spelled differently is harmless (also checked) — only the project root and watch roots matter.

Paths that reach Metro and inherit the module-load spelling today: `workspaceDir` (also `projectRoot` via `getDefaultConfig(workspaceDir)`, `nodeModulesPaths`, the shim aliases, `cacheDir` and its `blockList` pattern), `repoRoot`, `packageDir(...)` (from `require.resolve`, so from the config module's own spelling), and in the script `ENTRY_PATH` / the `entry` that `bundle` passes to `runBuild` (tests pass fixture paths from `import.meta.url`).

## Fix

Canonicalize every filesystem path the config and the script build before Metro sees it, with `fs.realpathSync.native`, which returns the operating system's own spelling (uppercase drive on Windows) and resolves links the way the existing `realpathSync` calls already do. Concretely:

- `metro.config.cjs`: `workspaceDir = fs.realpathSync.native(__dirname)`; `repoRoot` and `linkTarget` use `.native`; `packageDir` returns a canonical directory. Everything else is derived from those.
- `scripts/rn-bundle-check.mjs`: derive `WORKSPACE_DIR` (and so `CONFIG_PATH`, `ENTRY_PATH`, `OUTPUT_PARENT`) and `REPO_ROOT` with `realpathSync.native`, and have `bundle` canonicalize the `entry` it is given, so a caller's spelling (the tests', or a future one) cannot reintroduce the mismatch.
- One comment at the canonicalization in the config saying why (metro-file-map compares path prefixes case-sensitively; two spellings of one drive split the file map). This is a defect in Metro itself; patching the dependency is out of scope.

The fix ticket's other proposals — moving the file-map cache under `node_modules/.cache/rn-bundle-check`, resetting it and retrying on failure, or naming the cache in the error — are not needed: the cache never held a stale crawl, and every one of them would have left this failure in place.

## Test

One regression spec at the config layer (cheaper than a Metro run, and a bundle-level fixture would need a built sibling to cross into): on Windows, load `metro.config.cjs` through a path whose drive letter is flipped to lowercase (`createRequire(import.meta.url)` on the flipped path loads a separate module instance) and assert that `projectRoot` and every `watchFolders` entry equal `fs.realpathSync.native` of themselves. Before the fix it fails on `projectRoot`/`watchFolders[0]`. Use `node:test`'s `skip` on non-Windows platforms (no drive letters there; a lowercased path simply does not exist) — a platform condition, not a hidden failure. Add it to the readme's test list.

## TODO

- Canonicalize the paths in `metro.config.cjs` and `scripts/rn-bundle-check.mjs` as described above, with the one-line reason at the config site.
- Add the Windows-only config spec under `packages/rn-bundle-check/test/` and list it in the readme's Tests section.
- Re-verify by hand: from cwd `c:/projects/optimystic/packages/rn-bundle-check`, spawn node on the script spelled `c:/…/scripts/rn-bundle-check.mjs` (a scratch script using `spawnSync(process.execPath, [script], { cwd })`; `yarn` from PowerShell will not reproduce, since PowerShell uppercases its cwd). It must pass. Also run `yarn check:rn` and `yarn workspace @optimystic/rn-bundle-check test` normally.
- Delete any `%TEMP%\metro-file-map-6421d15b…` file the verification leaves behind.
- readme.md: one sentence under "What `yarn check:rn` does" or the narrower gaps saying the check canonicalizes paths because Metro's file map is drive-letter-case-sensitive, so it no longer matters how the shell spells the drive. No recovery recipe is needed once the fix lands.
