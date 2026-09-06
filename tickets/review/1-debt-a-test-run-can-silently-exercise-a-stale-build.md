description: A test run that would have quietly tested a previous build now refuses to start and tells you which package to rebuild and where. Review the new check, its tests, and the eleven call sites that now use it.
files:
  - test-harness/build-freshness.mjs (new — the check)
  - test-harness/build-freshness.test.mjs (new — 21 tests, `node --test`)
  - packages/*/register.mjs (all eleven now call it; the two `quereus-plugin-*` pass `{ checkSelf: true }`)
  - package.json (root — new `test:harness`, chained ahead of the workspace fan-out in `test`)
  - AGENTS.md (§ Testing — new paragraphs on the guard and its escape hatch)
difficulty: medium
----

# Review: refuse to start a test run against a stale build

## What landed

Every package resolves its workspace and sibling-repo dependencies through a `node_modules` symlink
into a working copy whose manifest points at `dist`. So editing `packages/db-core/src` and running
`yarn workspace @optimystic/db-p2p test` used to exercise the *previous* build of `db-core`, silently
— a false green or a false regression depending on which way the edit cut. That mismatch now aborts
the run.

`assertBuildFresh` in `test-harness/build-freshness.mjs` is called from every package's
`register.mjs`, above its `register('ts-node/esm', ...)` line, so it fires before ts-node is set up
and long before the first spec is imported. It prints to stderr and exits 1.

The list of packages it checks is **derived**, not hand-written: candidate names are the calling
package's own `workspace:`-ranged dependencies plus every name the root manifest's `resolutions`
redirects with `portal:`/`link:`; each is located by walking `node_modules` upward from the
`register.mjs` directory, stopping at the first directory that has an entry and bounded above by the
repository root; each hit is classified by `lstat` (symlink → a working copy worth judging; real
directory → a registry install, skipped silently; nothing found anywhere → skipped); and for a
symlink, the newest mtime under the target's `src` is compared against the newest mtime anywhere
under its build-output root.

`{ checkSelf: true }` additionally compares the calling package's own `src` against its own `dist`.
Only `quereus-plugin-optimystic` and `quereus-plugin-crypto` pass it — their specs import
`../dist/plugin.js` and `../dist/index.js` outright.

`OPTIMYSTIC_SKIP_BUILD_CHECK` set to any non-empty value skips the check and prints
`build-freshness: skipped by OPTIMYSTIC_SKIP_BUILD_CHECK` to stderr on every run.

## Use cases to exercise while reviewing

**The originating instance — verified during implementation, and worth re-running.**

```
touch packages/db-core/src/index.ts          # mtime only; no content change
yarn workspace @optimystic/db-p2p test
```

Observed output, exit code 1, before mocha started:

```
Stale build detected: these tests run real compiled output.
  - @optimystic/db-core: dist is stale — src was edited after the last build.
    Run in C:\projects\optimystic: yarn workspace @optimystic/db-core clean && yarn workspace @optimystic/db-core build
```

After `yarn workspace @optimystic/db-core build`, the same command proceeds normally (confirmed on a
single spec file, then on the full suite: 2581 passing).

**The derived target list.** The check should produce exactly this, and it did when measured against
the working tree during implementation:

| suite | targets |
| --- | --- |
| `db-core` | *(none — the guard is a no-op there)* |
| `db-p2p` | `@optimystic/db-core`, `p2p-fret` |
| `db-p2p-storage-fs` / `-ns` / `-rn` / `-web` | `@optimystic/db-core`, `@optimystic/db-p2p` |
| `demo` | `@optimystic/db-core` |
| `quereus-plugin-crypto` | `@quereus/quereus`, self |
| `quereus-plugin-optimystic` | `@optimystic/db-core`, `@optimystic/db-p2p`, `@optimystic/db-p2p-storage-fs`, `@quereus/quereus`, self |
| `reference-peer` | `@optimystic/db-core`, `@optimystic/db-p2p`, `@optimystic/db-p2p-storage-fs` |
| `substrate-simulator` | `p2p-fret` |

Nothing in the shipped module exposes this list, so re-deriving it means either instrumenting a
scratch copy of the module or inferring it from failure messages. That is the deliberate tradeoff of
not widening the public surface; if the reviewer thinks the list deserves a permanent way to inspect
it, that is a reasonable finding.

**The escape hatch.**

```
OPTIMYSTIC_SKIP_BUILD_CHECK=1 yarn workspace @optimystic/db-p2p test
```

should run the suite *and* print the skip warning. Note that an **empty** value does not skip — the
guard tests `(process.env[...] ?? '') !== ''`, which is what lets the harness's own child-process
tests clear an inherited setting. Whether an empty string ought to mean "skip" is a judgement call
worth a second opinion.

**The harness's own tests.** `yarn test:harness` from the root. 21 tests, node's built-in runner, no
dependencies — deliberately, since the module whose job is to be un-defeatable by the build system
should not acquire a stake in it. Fixtures are temp trees with mtimes stamped by `utimesSync` and
directory links created as Windows junctions (`symlinkSync(target, link, 'junction')`), which need no
elevation and which `lstatSync` reports as symbolic links.

## What was run

- `yarn test` from the root: **passed, 6m23s** — the new `test:harness` step plus all eleven package
  suites. This is the broadest evidence in the ticket; it covers every suite the guard was wired
  into, including the two `checkSelf` packages and the four storage packages.
- `yarn test:harness`: 21 passing.
- `yarn lint`, `yarn lint:docs`: clean.
- `yarn workspace @optimystic/db-core test` (1605 passing), `@optimystic/db-p2p` (2581 passing),
  `@optimystic/quereus-plugin-crypto` (125 passing) individually — the no-target, dependency-target
  and `checkSelf` cases.
- Integration path: `test:integration`'s command line was run with a `--grep` that matches nothing
  (mocha booted past the guard, exit 0), and `two-node-convergence.integration.spec.ts` was run for
  real (3 passing). The full `yarn test:integration` fan-out was **not** run — it spins real TCP
  meshes across nine spec files in two packages and was judged too long for one ticket. The guard is
  the same `--import ./register.mjs` line those scripts already used, so the risk is low, but it is
  unverified.

## Known gaps — treat this as a floor, not a finish line

- **The "unbuilt sibling repository" case was never reproduced live.** The ticket asked for it
  (delete `../quereus/packages/quereus/dist`, confirm every `quereus-plugin-*` run fails with a
  message naming that checkout). Deleting another repository's build output mid-run was judged too
  risky to do from an agent, so it was verified two other ways instead: a fixture test
  (`sends a sibling repository's remedy to that repository, not to this one`) that links a consumer
  in one temp repo to an unbuilt package in another, and a direct call confirming that the real
  `C:\projects\quereus\packages\quereus` resolves its remedy directory to `C:\projects\quereus` and
  that checkout has both `clean` and `build` scripts. A reviewer willing to rebuild afterwards should
  do the real thing.
- **Two branches have no test.** The `lstat` failure that is *not* `ENOENT`/`ENOTDIR` (an
  unreadable entry, reported as a problem rather than continuing the walk), and a manifest that names
  no built entry point at all. Both are one-line branches; neither is reachable in this repo today.
- **Only run on Windows.** The junction fixtures should degrade to ordinary symlinks elsewhere
  (node ignores the `type` argument off Windows), but that is untested.
- **Cost was not re-measured.** The plan measured 5710 files in 56 ms for the four heaviest targets;
  nothing in the implementation changed the walk, and no per-suite timing was taken here.
- **Transitive dependencies are out of reach by design.** `quereus-plugin-optimystic` runs `db-p2p`
  code which runs `p2p-fret` code, but `p2p-fret` is neither in that package's manifest nor
  resolvable from its `node_modules`. Fabricating it would report "not installed" and send someone to
  a build that would not help.
- **`git status` after this work should show exactly** the eleven `register.mjs` files, `AGENTS.md`,
  root `package.json`, and the new untracked `test-harness/` — nothing else.

## Tripwires parked in code

- `test-harness/build-freshness.mjs` module header — transitive dependencies are not covered; if a
  transitive stale build ever costs real time, walk each resolved target's own manifest rather than
  hard-coding names.
- `checkBuildFreshness` doc comment — mtime is not content: a `git checkout` in a sibling can bump
  source mtimes with bytes unchanged, the compiler no-ops, and the check keeps saying stale. The
  answers are the `clean &&` in the remedy line and the escape hatch.
- `checkBuildFreshness` doc comment — the whole-tree walk cost, and what to do instead (compare
  against a single always-rewritten output artifact) if it ever shows up.
- `checkBuildFreshness` doc comment — why the whole output tree is walked rather than the entry point
  alone, even though nothing here is built `incremental` today.

## Design decisions a reviewer may want to push on

- **`register.mjs` rather than a mocha root hook or a `pretest` step.** A root hook runs as a
  `beforeAll`, after mocha has already imported every spec — too late. A `pretest` step costs a
  process per package and does not cover a hand-run `node --import ./register.mjs ... mocha.js`.
- **`process.exit(1)` rather than `throw`.** A thrown error makes node echo the offending source line
  and five stack frames above the message, burying the remedy.
- **Plain `.mjs`, outside `packages/`.** A `register.mjs` static import evaluates before that file
  installs the ts-node loader, so TypeScript is not available; and a shared workspace package would
  itself be consumed from its own `dist`, making the stale-build guard defeatable by its own stale
  build.
- **`builtEntry` is not a conditional-exports resolver** (`exports['.'].import` → `.default` →
  `main`, and nothing else). The entry is used only to detect "not built at all" and to take its
  first path segment as the output root, so an imprecise pick inside the same `dist` tree changes
  neither answer.
- **The stale remedy suggests `clean && build`, the missing remedy suggests plain `build`.** The
  plan's example output shows plain `build` for both; the `clean` was added because a plain rebuild
  is the one that can appear not to work (see the mtime tripwire).
