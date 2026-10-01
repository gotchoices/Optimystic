description: On Windows, `yarn check:rn` failed with "Unable to resolve module p2p-fret" when started from a shell whose current directory had a lowercase drive letter, because Metro saw the same files under two spellings of the drive. The check now hands Metro one spelling of every path and gives the same answer however the drive is spelled.
architecture: packages/rn-bundle-check/readme.md
files:
  - packages/rn-bundle-check/metro.config.cjs (`workspaceDir`, `repoRoot`, `packageDir`, `linkTarget`)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (`WORKSPACE_DIR`, `REPO_ROOT`, the `require('metro')` load, `bundle`)
  - packages/rn-bundle-check/test/drive-letter-case.test.mjs (new)
  - packages/rn-bundle-check/test/fixtures/routed-target.js (comment only: second user)
  - packages/rn-bundle-check/readme.md
repro: verified
----
# `yarn check:rn` no longer depends on how the drive letter is spelled

## Cause

metro-file-map stores every crawled file under a path relative to the project root, using a case-sensitive prefix comparison (`RootPathUtils.absoluteToNormal` in `metro-file-map/src/lib/RootPathUtils.js`). If one path reaching Metro is spelled `c:\projects\…` and another `C:\projects\…`, the second is filed under a garbage key and can never be found. From a lowercase-drive cwd, `yarn` loads the script, and through it the config and Metro, under `c:`, while the portal junctions to ../Fret and ../quereus resolve to `C:`.

## What changed

The implement ticket prescribed canonicalizing the config's and the script's own paths with `fs.realpathSync.native`, which returns the operating system's spelling (uppercase drive). **That alone was not enough.** I reran the ticket's manual verification (node spawned on `c:/…/scripts/rn-bundle-check.mjs` with cwd `c:/…/packages/rn-bundle-check`), and the check failed in a new way: `Failed to get the SHA-1 for: c:\…\node_modules\metro-runtime\src\polyfills\require.js`. `metro-config`'s defaults contain paths it gets from `require.resolve` relative to its own location (`moduleSystem`, `emptyModulePath`). The script's static `import … from 'metro'` resolved Metro under the lowercase spelling, so those defaults stayed `c:` while the project root became `C:`. Every bundle starts with that polyfill, so any entry failed.

Final change:

- `metro.config.cjs`: `workspaceDir`, `repoRoot`, `packageDir(...)` and `linkTarget(...)` go through `fs.realpathSync.native`. One comment at `workspaceDir` gives the reason.
- `scripts/rn-bundle-check.mjs`:
  - `WORKSPACE_DIR` and `REPO_ROOT` use `realpathSync.native`, so `CONFIG_PATH`, `ENTRY_PATH` and `OUTPUT_PARENT` are canonical too.
  - Metro is no longer imported statically. It is loaded with `require('metro')` from a `createRequire` rooted at the canonical `WORKSPACE_DIR`, with a comment saying why. The same `require` still serves `hermescPath`.
  - `bundle` canonicalizes the `entry` it is given.
- readme: one paragraph under "What `yarn check:rn` does", and the new spec in the Tests list.

The fix ticket's other proposals (moving the file-map cache, reset-and-retry, naming the cache in the error) were not done, as the implement ticket decided.

## Verification (Windows, Node 24.2, Metro 0.83.8)

- Lowercase cwd plus lowercase script path, spawned from a scratch script with `spawnSync(process.execPath, [script], { cwd })`: before the change it failed with "p2p-fret could not be found". With only the config change it failed with the SHA-1 error above. With the final change it passes (Metro 4.1 s, hermesc 13.7 s). It reused the canonical-root file-map cache `bd0a09bb…`, and no `6421d15b…` (lowercase-root) cache file was written.
- `yarn check:rn` from PowerShell: passes.
- `yarn workspace @optimystic/rn-bundle-check test`: 10/10 pass.
- `eslint packages/rn-bundle-check`, `yarn lint:docs` and `check-undeclared-deps`: clean.
- I did not rerun the mixed case (lowercase cwd with an uppercase script path). It passed before the change, and Metro now loads from the canonical path whatever the script's spelling.

## Tests added

`test/drive-letter-case.test.mjs`. Both specs are Windows-only and use `node:test`'s `skip` elsewhere, since only Windows paths have a drive letter.

- **"metro.config.cjs gives Metro canonical roots when loaded through a lowercase drive letter"** loads the config through a `createRequire` on a lowercase-drive path, which gives a separate module instance, and asserts that `projectRoot` and every `watchFolders` entry equal `realpathSync.native` of themselves. Run against the HEAD config, it fails (`c:\…\rn-bundle-check` vs `C:\…`). About 0.1 s.
- **"bundles when the script and the entry are spelled with a lowercase drive letter"** dynamically imports the script through a lowercase-drive file URL (a separate ESM instance, as a lowercase-cwd run gets), then bundles `fixtures/routed-target.js` given by a lowercase path. I confirmed by temporary variants that it fails with the SHA-1 error when the static `import 'metro'` is restored, and fails on the entry's SHA-1 when `bundle` stops canonicalizing `entry`. About 2 s (one Metro crawl).

## Known gaps and things to judge

- **The config-level spec pins something `yarn check:rn` no longer reaches on its own.** The script now loads the config through the canonical `CONFIG_PATH`, so the config's `__dirname` is canonical in the real flow anyway. The config's own `workspaceDir`/`repoRoot` canonicalization only matters to some other loader. Such a loader, Metro's own CLI started from a lowercase cwd for example, would still fail, because Metro's defaults would carry that loader's spelling. The part of the config change that matters to `yarn check:rn` is `linkTarget` → `.native`. It covers junctions whose *stored* target is lowercase, which a `yarn install` run from a lowercase cwd could plausibly write. `repro: static` for that arm: every junction on this machine stores `C:`, so the JS `realpathSync` already returned `C:` and that arm was not exercised. The reviewer may decide the config spec doesn't pay for itself; the bundle spec is the end-to-end reproduction.
- **Only Windows was exercised.** On Linux, `realpathSync.native` resolves symlinks the same way as `realpathSync`. On macOS (case-insensitive APFS) it also canonicalizes case, which should help rather than hurt. Neither was run.
- **Subst or mapped drives:** `realpathSync.native` resolves a `subst` drive to its underlying path. Every path Metro sees now gets that spelling consistently, so this should be harmless, but it is a behaviour change and was not exercised.
- The `%TEMP%\metro-file-map-154e1e9a…` file on this machine predates this work and belongs to some other project root; I left it alone. No `6421d15b…` file existed after verification.
