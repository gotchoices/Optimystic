description: On Windows, `yarn check:rn` failed with "Unable to resolve module p2p-fret" when started from a shell whose current directory had a lowercase drive letter, because Metro saw the same files under two spellings of the drive. The check now hands Metro one spelling of every path and gives the same answer however the drive is spelled.
architecture: packages/rn-bundle-check/readme.md
files:
  - packages/rn-bundle-check/metro.config.cjs (`workspaceDir`, `repoRoot`, `packageDir`, `linkTarget`)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (`WORKSPACE_DIR`, `REPO_ROOT`, the `require('metro')` load, `bundle`)
  - packages/rn-bundle-check/test/drive-letter-case.test.mjs
  - packages/rn-bundle-check/test/fixtures/routed-target.js (comment only: second user)
  - packages/rn-bundle-check/readme.md
repro: verified
----
# `yarn check:rn` no longer depends on how the drive letter is spelled

## Cause

metro-file-map stores every crawled file under a path relative to the project root, using a case-sensitive prefix comparison (`RootPathUtils.absoluteToNormal` in `metro-file-map/src/lib/RootPathUtils.js`). If one path reaching Metro is spelled `c:\projects\…` and another `C:\projects\…`, the second is filed under a garbage key and can never be found. From a lowercase-drive cwd, `yarn` loads the script, and through it the config and Metro, under `c:`. The portal junctions to ../Fret and ../quereus resolve to `C:`.

## What changed (`ticket(implement): rn-bundle-check-fails-when-started-from-a-lowercase-drive-letter`)

- `metro.config.cjs`: `workspaceDir`, `repoRoot`, `packageDir(...)` and `linkTarget(...)` go through `fs.realpathSync.native`, which returns the operating system's spelling (uppercase drive).
- `scripts/rn-bundle-check.mjs`: `WORKSPACE_DIR` and `REPO_ROOT` are canonical, so the config, entry and output paths are canonical too. Metro is loaded with `require('metro')` from a `createRequire` rooted at the canonical directory instead of a static import. Metro's defaults (`moduleSystem`, the require polyfill every bundle starts with) are paths Metro resolves from its own location, so an import under the lowercase spelling failed every bundle with "Failed to get the SHA-1". `bundle` canonicalizes the `entry` it is given.
- readme: one paragraph under "What `yarn check:rn` does", plus the spec in the Tests list.

The fix ticket's other proposals (moving the file-map cache, reset-and-retry, naming the cache in the error) were not done, as the implement ticket decided.

## Review findings

**What I checked:** I read the implement diff before the handoff, then the whole script, the config's changed sites, the readme, and the sibling RN tests. I checked the other uses of the canonical paths: `repoRelative` compares Metro's now-canonical file paths against `REPO_ROOT`, which is also canonical, so they agree. `hermescPath` goes through the same canonical `require`. `buildFreshnessProblems` takes the canonical `WORKSPACE_DIR`. `invokedDirectly` compares `argv[1]` with `import.meta.url`, and Node builds both from the same spelling, so it is unaffected. The fix ticket `rn-bundle-check-keeps-a-file-map-crawled-while-a-sibling-was-rebuilding` was folded into this one, and nothing else open on the board touches these files.

**Reproduction confirmed:** I temporarily restored the pre-fix script and ran the bundle spec. It failed with `Failed to get the SHA-1 for: c:\…\fixtures\routed-target.js`. With the fix restored it passes.

**Tests, cut one:** I removed "metro.config.cjs gives Metro canonical roots when loaded through a lowercase drive letter". It asserted that each root equals `realpathSync.native` of itself, which restates the implementation. It also guarded a path `yarn check:rn` no longer takes, because the script now loads the config through the canonical `CONFIG_PATH`. The end-to-end bundle spec is the reproduction and stays. I updated the test file header and the readme Tests entry to match.

**Tripwire:** the config's own canonicalization does not protect any other loader by itself. Metro's CLI started from a lowercase cwd would still carry its own spelling in Metro's defaults. Nothing loads the config that way today, so I recorded it as a `NOTE:` at `workspaceDir` in `metro.config.cjs` rather than filing a ticket.

**Unverified arm, not filed:** `linkTarget`/`packageDir` → `.native` covers junctions whose *stored* target is lowercase, and no junction on this machine has one, so that arm was never exercised. It is cheap and the change is consistent, so I left it as is.

**Platforms:** only Windows was exercised. On Linux, `realpathSync.native` resolves symlinks like `realpathSync`. On macOS it also canonicalizes case, which helps. `subst` drives resolve to their underlying path, consistently for every path, so there is no split. No finding.

**Error handling, resource cleanup, type safety, size:** no new error paths. The test removes its output directory in `t.after`. The script is plain JS with no types. The changes are a few lines each. No findings.

**Docs:** the readme paragraph and Tests list match the code. `docs/internals.md` and AGENTS.md describe `check:rn` only at a level this change does not affect.

**Validation run:** `yarn workspace @optimystic/rn-bundle-check test` 9/9 pass. `eslint packages/rn-bundle-check` clean. `yarn lint:docs` clean. `yarn check:rn` passes (Metro 4.1 s, hermesc 14.9 s).
