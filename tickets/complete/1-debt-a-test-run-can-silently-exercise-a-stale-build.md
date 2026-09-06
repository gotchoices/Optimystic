description: A test run that would have quietly tested a previous build now refuses to start and tells you which package to rebuild and where. Reviewed, re-verified live, and three small fixes applied.
files:
  - test-harness/build-freshness.mjs (the check)
  - test-harness/build-freshness.test.mjs (23 tests, `node --test`)
  - packages/*/register.mjs (all eleven call it; the two `quereus-plugin-*` pass `{ checkSelf: true }`)
  - package.json (root — `test:harness`, chained ahead of the workspace fan-out in `test`)
  - AGENTS.md (§ Testing)
----

# Refuse to start a test run against a stale build

## What shipped

Every package resolves its workspace and sibling-repository dependencies through a `node_modules`
symlink into a working copy whose manifest points at `dist`. Editing `packages/db-core/src` and
running `yarn workspace @optimystic/db-p2p test` therefore used to exercise the *previous* build of
`db-core` with no warning — a false green or a false regression depending on which way the edit cut.

`assertBuildFresh` in `test-harness/build-freshness.mjs` now runs from every package's
`register.mjs`, above its `register('ts-node/esm', ...)` line, so it fires before ts-node exists and
long before the first spec is imported. It prints a remedy to stderr and exits 1.

The list of packages it checks is derived, not hand-written: candidates are the calling package's own
`workspace:`-ranged dependencies plus every name the root manifest's `resolutions` redirects with
`portal:`/`link:`; each is located by walking `node_modules` upward from the `register.mjs`
directory, stopping at the first directory that holds an entry and bounded above by the repository
root; each hit is classified by `lstat` (symlink → a working copy worth judging, real directory → a
registry install, skipped; nothing found → skipped); and for a symlink the newest mtime under the
target's `src` is compared against the newest mtime anywhere under its build-output root.

`{ checkSelf: true }` additionally compares the calling package's own `src` against its own `dist`.
Only `quereus-plugin-optimystic` and `quereus-plugin-crypto` pass it — their specs import
`../dist/...` outright. `OPTIMYSTIC_SKIP_BUILD_CHECK` set to any non-empty value skips the check and
says so on stderr every run.

## Review findings

### Verified independently (not taken from the handoff)

- **The derived target list.** Re-derived against the live working tree from an instrumented copy of
  the module (a scratch copy with the internal functions exported; discarded afterwards). It matches
  the implement ticket's table exactly for all eleven packages — including that `db-core`'s guard is
  a no-op today and that `p2p-fret` resolves as `linked` only from `db-p2p` and `substrate-simulator`.
- **The originating instance, live.** Bumped the mtime of `packages/db-core/src/index.ts` (mtime
  only, bytes and git state unchanged), ran `db-p2p`'s exact mocha command line: exit 1 before mocha
  started, with the `clean && build` remedy naming `C:\projects\optimystic`. Original mtime restored
  afterwards and the whole-tree probe re-run to confirm all eleven packages read clean again.
- **The escape hatch, live.** Same stale tree with `OPTIMYSTIC_SKIP_BUILD_CHECK=1`: skip warning on
  stderr, suite ran, exit 0.
- **The sibling-repository remedy commands are actually runnable.** The implement ticket verified
  only the `quereus` checkout. Both were checked here: `C:\projects\quereus` and `C:\projects\Fret`
  root manifests declare `workspaces`, and `@quereus/quereus` and `p2p-fret` each have `clean` and
  `build` scripts — so `Run in <repo>: yarn workspace <name> clean && yarn workspace <name> build`
  works as printed for either.
- **Cost, which the implement ticket left un-measured.** `buildFreshnessProblems` wall time per
  package on this tree: 0.8 ms (`db-core`, no resolved targets) to 51.2 ms
  (`quereus-plugin-optimystic`, four linked targets plus `checkSelf`); every other package is 3–28 ms.
  Against suites that run 15 s to 2 m, this is noise. The plan's 56 ms figure holds.
- **Fixture hygiene.** No `optimystic-build-freshness-*` directories survive in the OS temp directory
  after a harness run, so the junction fixtures are being torn down rather than leaked.

### Fixed in this pass (minor)

- **`process.stderr.write` followed by `process.exit(1)` could publish nothing at all.** Node
  documents these writes as *asynchronous* on a Windows terminal and on a macOS pipe, and
  `process.exit` does not drain a pending async write — so on the primary development platform, run
  from a terminal rather than through `yarn`, the guard could fail the run with a bare exit 1 and no
  remedy, which is worse than the problem it exists to solve. Both messages now go through a
  `writeStderr` helper using `writeSync(2, …)`, falling back to the stream on `EAGAIN`. (This is also
  the only part of the handoff's "only run on Windows" gap that was resolvable here.)
- **Two coverage gaps closed.** `test-harness/build-freshness.test.mjs` gains a test for a manifest
  that names no built entry point at all (one of the two branches the handoff listed as untested),
  and one asserting that *every* problem is reported rather than the first — the case
  `quereus-plugin-optimystic` actually hits, where a reader shown one rebuild at a time would go
  round the loop four times. 21 tests → 23.
- **AGENTS.md understated the blast radius.** The guard covers every `--import ./register.mjs`
  invocation, not only `test` — `yarn workspace @optimystic/demo start` is now gated too, and loads
  the same compiled dependencies. Added as one clause so nobody meets it as a surprise.

### Parked as a tripwire, not filed

- **The source side is the mtimes of files under `src` and nothing else** — a `NOTE:` now sits on
  `checkBuildFreshness`. Three changes therefore leave a package reading fresh when its output is
  not: deleting a source file (only the containing directory's mtime moves, and directory mtimes are
  deliberately *not* read, because adding a spec file moves them too and would undo the test-file
  exclusion); editing `tsconfig.json` / `tsconfig.base.json`; and upgrading a dependency the output
  inlines. All three are rare beside an ordinary source edit and all three are cleared by the
  `clean &&` rebuild the message already suggests. The note says to hash build inputs rather than
  widen the mtime walk if one ever produces a wrong test result.

### Major findings: none. Two candidates were weighed and deliberately not filed

- **The invariant that would retire the whole class** is to stop consuming sibling packages through
  `dist` during test runs at all — TypeScript project references or a path mapping onto `src`, so
  there is no build for a run to be stale against. That was already weighed at plan and implement
  stage and the guard is the chosen design; nothing in the landed code argues the choice was wrong,
  and re-opening it is a design decision for a human rather than a review finding.
- **Transitive dependencies are uncovered** (`quereus-plugin-optimystic` runs `db-p2p` code which
  runs `p2p-fret` code, but `p2p-fret` is neither in that package's manifest nor resolvable from its
  `node_modules`). The implementer already parked this as a tripwire in the module header with a
  stated revisit condition — "if a transitive stale build ever costs real time" — which has not
  tripped. Confirmed still uncovered; left as is.

### Two questions the handoff asked for a second opinion on — both answered "keep"

- **An empty `OPTIMYSTIC_SKIP_BUILD_CHECK` does not skip.** Keep. It is documented, tested, and the
  harness's own child-process tests rely on `''` meaning "don't skip" so they can clear an inherited
  setting. The alternative makes the guard defeatable by an accidentally-exported empty variable.
- **Nothing exposes the derived target list.** Keep the surface narrow. Re-deriving it took a
  fifteen-line scratch script against an instrumented copy, and the failure messages already name
  every target that matters; a debug flag would be API nobody calls.

### Checked and clean, so nothing to report

- **Docs.** `AGENTS.md` § Testing is accurate as written (beyond the one clause added above).
  Everything under `docs/` was searched for `register.mjs`, "stale build" and
  `OPTIMYSTIC_SKIP_BUILD_CHECK`: no other document describes the test-run mechanics, so nothing else
  went stale. `docs/releasing.md` describes `yarn test` at a level the change does not disturb.
- **The eleven `register.mjs` edits** are byte-identical to each other apart from the two `checkSelf`
  call sites, and each puts the call above the `ts-node/esm` registration as designed.
- **Root `package.json`.** `test:harness` is chained ahead of the fan-out in `test`, and `check`
  reaches it through `test`. `test:verbose` and `test:integration` do not chain it — noted and left
  alone: `test:harness` is a unit suite rather than a guard, and adding it to every root script buys
  nothing `yarn check` does not already cover.
- **Module size and comment density.** 452 lines, 198 of them comment. Heavy, but it matches house
  style (`eslint.config.js` has the same shape) and every block explains a decision that is not
  obvious from the code. One job, one file — no split warranted.
- **`builtEntry` is not a conditional-exports resolver.** Correct as scoped: an array-valued or
  `require`-only `exports['.']` falls through to `main`, and the entry is used only to detect "not
  built at all" and to take its first path segment as the output root.

### Still open, and honestly so

- **The `lstat` failure that is not `ENOENT`/`ENOTDIR` has no test.** Not portably forceable without
  manipulating filesystem permissions from a test, which is a worse trade than the untested one-line
  branch. Unreachable in this repository today.
- **The "unbuilt sibling repository" case still has no live reproduction.** Deleting another
  repository's build output mid-run remains a bad trade for an agent. It is covered by the fixture
  test that links a consumer in one temp repository to an unbuilt package in another, and the remedy
  commands it prints are now verified runnable in both real sibling checkouts (above).
- **Only exercised on Windows.** The junction fixtures should degrade to ordinary symlinks elsewhere
  and the stderr fix removes the one platform-dependent behaviour in the output path, but no
  non-Windows run has happened. There is no CI configuration in this repository to catch it.
- **The full `yarn test:integration` fan-out was not run** — nine spec files spinning real TCP meshes
  across two packages, too long for a ticket. The guard sits on the same
  `--import ./register.mjs` line those scripts already used.

## What was run

- `yarn test` from the root: **passed, 6m13s** — `test:harness` (23 passing) plus all eleven package
  suites, including both `checkSelf` packages and all four storage packages.
- `yarn test:harness`: 23 passing.
- `yarn lint`, `yarn lint:docs`: clean.
- The live stale-build reproduction and escape-hatch runs described above, on `db-p2p`.
- A whole-tree probe of `buildFreshnessProblems` across all eleven packages, before and after the
  mtime experiment: no problems reported either time.
