description: Editing one package and running another package's tests currently tests the previous build instead of the code on disk, with no warning — it has already produced a confidently wrong conclusion. Add a check that refuses to start a test run when a dependency's compiled output is older than its source, and tells you exactly what to rebuild.
files:
  - test-harness/build-freshness.mjs (new — the check itself; lives outside packages/ on purpose)
  - test-harness/build-freshness.test.mjs (new — its own tests, run by `node --test`)
  - packages/*/register.mjs (all 11 are byte-identical today; each gains the same two lines)
  - package.json (root — new `test:harness` script, chained ahead of the workspace fan-out in `test`)
  - packages/quereus-plugin-optimystic/register.mjs and packages/quereus-plugin-crypto/register.mjs (the two that also pass `{ checkSelf: true }`)
  - AGENTS.md (§ Testing — document the guard and its escape hatch)
  - ../sereus/test-harness/build-freshness.ts (the prior art this adapts; read its doc comment first)
difficulty: medium
----

# Refuse to start a test run against a stale build

## The problem, restated in one paragraph

Every package here resolves its workspace and sibling-repo dependencies through a `node_modules`
symlink to a working copy, whose manifest points at `dist`. So a spec that imports
`@optimystic/db-core` loads `packages/db-core/dist/src/index.js` — the *previous build* — while a
spec that imports `../src/...` loads live source. Editing `db-core/src` and running
`yarn workspace @optimystic/db-p2p test` therefore exercises code that is no longer on disk, with no
warning. Both failure directions are real: a change that should have broken something is absent from
the run (false green), or a fix that is present in source is absent from the run (false regression).
This already cost one wrong conclusion committed to the ticket board and later retracted — see the
originating plan ticket in git history (commit `560a0e17`) for the measured instance.

## What is actually installed here — measured, not assumed

`.yarnrc.yml` sets `nmHoistingLimits: workspaces`, so there is **no** `node_modules/@optimystic` at
the repo root. Every workspace has its own `node_modules`, and the dependency is a symlink back into
`packages/`:

```
packages/db-p2p/node_modules/@optimystic/db-core -> C:/projects/optimystic/packages/db-core
packages/db-p2p/node_modules/p2p-fret            -> C:/projects/Fret/packages/fret
packages/quereus-plugin-optimystic/node_modules/@quereus/quereus -> C:/projects/quereus/packages/quereus
```

Two consequences that shape the design:

- The `node_modules` walk **must stop at the first directory that has an entry.** The package-local
  copy is the one Node loads; carrying on to an ancestor would judge a copy that never runs. This is
  the trap the sibling project documents at length and it is fully live here.
- **Workspace dependencies and sibling-repo dependencies need no separate code paths.** Both arrive
  as a symlink into a working copy someone can rebuild. The sibling project needed two paths because
  its workspaces were hoisted; here one walk covers both. Do not port the split.

The sibling repos reached through the root manifest's `resolutions` are
`@quereus/quereus` → `../quereus/packages/quereus` and `p2p-fret` → `../Fret/packages/fret`, both
declared with a `portal:` prefix (the sibling project used `link:`; accept either).

## The design: derive the target list, do not hand-write it

The sibling implementation hand-writes, per suite, the list of packages that suite runs compiled code
from — and then needs a second module and a spec in every package to stop that list drifting out of
date. **None of that is necessary here.** Each `register.mjs` sits next to a `package.json` that
already names every dependency the suite can reach, and every such dependency is a symlink we can
classify at runtime. So the list is derived, and cannot drift.

For the package that owns the calling `register.mjs`:

1. Read its own `package.json`. Candidate names are the keys of `dependencies`, `devDependencies` and
   `peerDependencies` whose range starts `workspace:`, plus any name the **root** manifest's
   `resolutions` redirects with `portal:` or `link:`.
2. Resolve each candidate by walking `node_modules` upward from the `register.mjs` directory,
   stopping at the repo root (inclusive) and at the first directory that has an entry.
3. Classify that entry with `lstat`, not by name: a symlink is a working copy worth judging; a real
   directory is a registry install and is **skipped silently** (its `src`/`dist` mtimes are packing
   artifacts, so judging it would report a permanent, unfixable "stale"); nothing found anywhere is
   skipped too.
4. For a symlink, read the target's own manifest for its built entry point — `exports['.'].import`,
   else `exports['.'].default`, else `main`. Do **not** write a conditional-exports resolver. The
   entry is used for exactly two things: detecting "not built at all", and taking its first path
   segment as the output root. A slightly imprecise pick inside the same `dist` tree changes nothing.
5. Compare the newest mtime under the target's `src` against the newest mtime anywhere under its
   output root. Newer source means stale.

A `{ checkSelf: true }` option additionally applies step 5 to the calling package's own `src` versus
its own `dist`. Only `quereus-plugin-optimystic` and `quereus-plugin-crypto` pass it — their specs
import `../dist/plugin.js` and `../dist/index.js` outright. It is opt-in rather than universal
because a package whose suite never touches its own `dist` (`db-core`, `db-p2p`) would otherwise fail
on a fresh clone for a reason its tests do not care about.

### Proposed shape

```js
/** Problem lines for `packageDir`; empty means every dist-backed dependency is fresh. */
export function buildFreshnessProblems(packageDir, options = {})

/** Prints those lines to stderr and exits 1. `registerUrl` is the caller's `import.meta.url`. */
export function assertBuildFresh(registerUrl, options = {})
```

Splitting the pure part out is what makes the module testable without a child process.

### What the derivation produces today

Verified by running the algorithm over the whole repo:

| suite | targets it derives |
| --- | --- |
| `db-core` | *(none — no dist-backed dependency; the guard is a no-op)* |
| `db-p2p` | `@optimystic/db-core`, `p2p-fret` |
| `db-p2p-storage-fs` / `-ns` / `-rn` / `-web` | `@optimystic/db-core`, `@optimystic/db-p2p` |
| `demo` | `@optimystic/db-core` |
| `quereus-plugin-crypto` | `@quereus/quereus`, **self** |
| `quereus-plugin-optimystic` | `@optimystic/db-core`, `@optimystic/db-p2p`, `@optimystic/db-p2p-storage-fs`, `@quereus/quereus`, **self** |
| `reference-peer` | `@optimystic/db-core`, `@optimystic/db-p2p`, `@optimystic/db-p2p-storage-fs` |
| `substrate-simulator` | `p2p-fret` |

This is a wider surface than the originating ticket named — it listed three suites, and eight of the
eleven actually run compiled output. Wire all eleven anyway: the edit is the same two lines
everywhere, `db-core` costs nothing today, and it becomes live the day `db-core` gains a workspace
dependency.

The known gap: a **transitively** reached package is not covered. `quereus-plugin-optimystic` runs
`db-p2p` code which runs `p2p-fret` code, but `p2p-fret` is not in that package's manifest and is not
resolvable from its `node_modules` — a fabricated entry would report "not installed" and send someone
to a build that would not help. Record this in the module doc comment as a `NOTE:` rather than
building machinery for it.

## Where it attaches: `register.mjs`

**Decision: extend each package's existing `register.mjs`.** All eleven are byte-identical today
(`import { register } from 'node:module';` then `register('ts-node/esm', import.meta.url);`) and
every test script in every package already runs `node --import ./register.mjs …`. Put the guard call
*above* the `register(...)` call so a stale build fails before ts-node is even set up:

```js
import { register } from 'node:module';
import { assertBuildFresh } from '../../test-harness/build-freshness.mjs';

// Refuses the run when a dependency's `dist` is older than its `src` — see that module's header.
assertBuildFresh(import.meta.url);

register('ts-node/esm', import.meta.url);
```

Why not the alternatives:

- **A mocha root hook plugin** runs as a `beforeAll`, which is *after* mocha has loaded every spec
  file — so the stale sibling has already been imported and executed by the time the hook fires, and
  the message lands buried in reporter output. `--import` runs before the main entry module, which is
  the only point early enough.
- **A `pretest` step in each `test` script** works and is runner-independent, but costs an extra node
  process in each of the eleven packages, adds a moving part per package that must be kept in sync
  across `test`, `test:verbose` and `test:integration`, and does not cover a hand-run
  `node --import ./register.mjs … mocha.js`.

Two constraints on the module follow from this choice, both non-obvious:

- **It must be plain `.mjs`, not TypeScript.** A `register.mjs` static import is evaluated *before*
  that module's body calls `register('ts-node/esm', …)`, so there is no TypeScript loader available
  at the moment the guard is loaded.
- **It must live outside `packages/` and be imported by relative path.** A shared workspace package
  would itself be consumed from its own `dist` — the guard against stale builds would be defeatable
  by its own stale build. `test-harness/` is not matched by the root `workspaces` glob (`packages/*`),
  needs no `package.json` of its own (the `.mjs` extension already makes it ESM), and is never built
  or published.

## Failure behaviour

Print to stderr and `process.exit(1)` — verified to abort before the main entry module runs, with
exit code 1, which is what makes `yarn workspaces foreach -At` halt. Prefer this over `throw`: a
thrown error makes node echo the offending source line and a five-frame stack above the message,
which buries the one thing the reader needs.

Target shape, one line per problem:

```
Stale build detected: these tests run real compiled output.
  - @optimystic/db-core: dist is stale — src was edited after the last build.
    Run in C:\projects\optimystic: yarn workspace @optimystic/db-core build
  - @quereus/quereus: not built (missing dist/src/index.js).
    Run in C:\projects\quereus: yarn workspace @quereus/quereus build
```

Naming the package, the reason, **and the directory to run the command in** is most of the value —
`yarn workspace` only reaches the current repo, so a sibling's remedy has to say where to go. Derive
that directory by walking up from the resolved package root to the nearest `package.json` declaring
`workspaces`.

### Escape hatch

`OPTIMYSTIC_SKIP_BUILD_CHECK=1` skips the check. The sibling project deliberately shipped no hatch;
add one here for one specific reason it documents: a sibling checkout's `src` mtimes can be bumped by
an ordinary `git checkout` with the bytes unchanged, after which the TypeScript compiler's
content-based change detection makes a rebuild a no-op and the guard keeps reporting stale — a
rebuild that appears not to work. Without an escape, an optimystic developer is stuck on a repo they
are not even editing. So:

- The stale remedy line should suggest the forced rewrite first —
  `yarn workspace <name> clean && yarn workspace <name> build`.
- When the variable is set, still print one line to stderr on **every** run
  (`build-freshness: skipped by OPTIMYSTIC_SKIP_BUILD_CHECK`) so a hatch left in a shell profile
  stays visible rather than silently killing the guard forever.

### There is no CI to accommodate

`.github/workflows` does not exist; there is no CI in this repository. The originating ticket asked
what the guard should do there — the answer is that the question is moot. The one scripted path that
matters is root `yarn check` (`lint`, `lint:docs`, `build`, `typecheck`, `test`, `test:integration`),
where `build` precedes `test`, so the guard passes and costs only the walk.

## Cost — measured

Walking the full `src` and output trees of every package involved is **5710 files in 56 ms** (a node
script walking `db-core`, `db-p2p`, `../quereus/packages/quereus` and `../Fret/packages/fret`, both
`src` and `dist` for each, calling `statSync` per file). The heaviest single suite is
`quereus-plugin-optimystic` at four targets plus self — roughly 50 ms, against a suite that runs
~2m46s. Negligible; do not optimise it. If it ever does show up, the cheap move is comparing the
newest `src` entry against a single always-rewritten output artifact instead of walking the whole
tree — record that as a `NOTE:` at the walk, not as work.

Note that the compiler here is configured neither `incremental` nor `composite`
(`tsconfig.base.json` sets neither), so every build rewrites the whole output tree and the
newest-output-file rule is exact. Keep the whole-tree rule anyway rather than judging the entry point
alone: under `incremental` an entry point keeps its old mtime across rebuilds that do not touch it,
which would report a package stale forever.

## Testing the guard itself

`test-harness/build-freshness.test.mjs`, run by node's built-in test runner. Root `package.json`
gains a `test:harness` script (`node --test test-harness/build-freshness.test.mjs`) and chains it
ahead of the existing workspace fan-out in `test`.

`node --test` is chosen over mocha so the harness pulls in **no dependency at all** — the module whose
whole job is to be un-defeatable by the build system should not acquire a stake in it. Point it at the
file explicitly rather than at the directory: node's default test-file globs do not include
`*.spec.mjs` on every supported version, and naming the file sidesteps the question.

Tests build temp fixtures with `mkdtempSync` and control mtimes with `utimesSync`. **Create fixture
symlinks with `symlinkSync(target, link, 'junction')`** — a plain directory symlink needs elevation on
Windows, whereas a junction does not, and `lstatSync(link).isSymbolicLink()` returns `true` for a
junction while `realpathSync` resolves it (verified on this machine). This is also why the production
code must classify by `lstat`, not by inspecting names.

## Edge cases & interactions

Each of these should be a named test unless marked otherwise.

- **Stale dependency** — target's `src` newer than its output → one problem line, exit 1, run does not
  start.
- **Fresh dependency** — no problems, run proceeds.
- **Missing entry point** — target has `src` but no built entry → reported as "not built", not a crash
  or an unhandled `ENOENT`.
- **Target has no `src`** (a copy consumed without sources) → reported fresh. A package that cannot be
  shown stale must not fail, and hard-failing there gives the caller nothing to act on.
- **Registry install** — `node_modules/<name>` is a real directory, not a symlink → skipped silently.
- **Dangling symlink** — sibling checkout moved or deleted → reported with the raw link target and
  `Run: yarn install`, never a thrown `ENOENT`.
- **Walk stops at the first hit** — a package-local `node_modules` entry wins over an ancestor's, even
  when that entry turns out to be a registry copy or a dangling link. Test with a two-level fixture;
  this is the single most important behaviour to pin, and it is live in this repo.
- **Walk is bounded above by the repo root** — a `node_modules` outside the repository is never
  consulted. In a fixture with no ancestor declaring `workspaces`, the walk must terminate at the
  filesystem root rather than looping or throwing.
- **Editing a spec must not mark anything stale** — `*.spec.ts` / `*.test.ts` files and `test/` and
  `__tests__/` directories are excluded from the source side. This matters concretely: `db-core`'s
  `tsconfig.json` has `include: ["src", "test"]`, so its `dist` contains compiled tests and its output
  mtimes move when specs change.
- **`checkSelf`** — editing `packages/quereus-plugin-optimystic/src/plugin.ts` without rebuilding must
  fail that package's own suite, whose specs import `../dist/plugin.js`. Note the bundler used by the
  two plugin packages writes a flat `dist/` with no `src/` under it, so the output-root derivation
  must handle both `dist/index.js` and `dist/src/index.js`.
- **`db-core` derives zero targets** — its suite must run exactly as before. Confirm by running it.
- **Unbuilt sibling repository** — with `../quereus/packages/quereus/dist` absent, every
  `quereus-plugin-*` run must fail with a message naming that checkout, rather than the current
  `ERR_MODULE_NOT_FOUND` raised from somewhere inside a spec.
- **mtime is not content** (no test; a `NOTE:` at the comparison) — a git operation in a sibling can
  bump `src` mtimes with bytes unchanged, the compiler no-ops, and the guard still says stale. The
  remedy line's `clean` suggestion and the escape hatch are the two answers.
- **The other two test scripts inherit the guard for free** — `test:verbose` and `test:integration`
  use the same `--import ./register.mjs`. Confirm `test:integration` is not broken by it.
- **Exit code is 1** so `yarn workspaces foreach -At` stops rather than continuing to the next
  package.
- **Escape hatch is loud** — with `OPTIMYSTIC_SKIP_BUILD_CHECK=1` set, the check is skipped *and* a
  one-line stderr warning is printed on every run.
- **Transitive targets are out of reach** (no test; a `NOTE:` in the module header) — see the gap
  described under the derivation above.

## Scope

Not in scope: changing how packages resolve one another, or making specs import a sibling's `src`.
The `dist` resolution is correct — it is what a consumer gets. This ticket only makes the mismatch
**say so**.

## TODO

- Write `test-harness/build-freshness.mjs` with the two exports above. Read
  `../sereus/test-harness/build-freshness.ts`'s doc comment before starting — it records the two
  traps (the `node_modules` walk stopping at the first hit, and the guard being defeatable by its own
  build) that cost that project real time. Adapt it; do not port its workspace/linked split.
- Carry the `NOTE:` comments named above to their sites: transitive targets in the module header,
  mtime-versus-content at the comparison, and the whole-tree walk cost at the walk.
- Write `test-harness/build-freshness.test.mjs` covering the edge cases marked as tests above, using
  `mkdtempSync`, `utimesSync` and `symlinkSync(..., 'junction')` fixtures.
- Add `test:harness` to the root `package.json` and chain it ahead of the workspace fan-out in `test`.
- Add the same two lines to all eleven `packages/*/register.mjs`, with `{ checkSelf: true }` in
  `quereus-plugin-optimystic` and `quereus-plugin-crypto` only.
- Update AGENTS.md § Testing: what the guard does, that it fires before any spec loads, and the
  escape hatch. Keep citations in house style — `yarn lint:docs` checks that every backticked path
  names a tracked file, so create the module before running it.
- Verify the originating measured instance: touch a file under `packages/db-core/src`, run
  `yarn workspace @optimystic/db-p2p test` **without** rebuilding, and confirm the run refuses to
  start instead of reporting green. Then run `yarn workspace @optimystic/db-core build` and confirm
  the same command proceeds. For the passing direction, run a single spec file rather than the full
  2581-test suite — only that mocha starts needs confirming.
- Run `yarn lint`, `yarn lint:docs`, `yarn test:harness`, and at least the `db-core`, `db-p2p` and
  `quereus-plugin-crypto` suites (the no-target, dependency-target and `checkSelf` cases) before
  handing off. Note in the review handoff which suites you did not run and why.
