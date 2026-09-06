----
description: Several test suites here run compiled output rather than source, so editing one package and re-running another package's tests quietly tests the previous build instead. Nothing warns about it, and it has already produced a confidently wrong conclusion. The sibling project next door solved this and its solution can be adapted.
prereq:
files:
  - packages/db-p2p/test/*.spec.ts (import `@optimystic/db-core`, which resolves to that package's `dist/src/index.js`)
  - packages/quereus-plugin-optimystic/test/*.spec.ts (import `../dist/plugin.js` and `../dist/index.js` outright, plus `@optimystic/db-core`)
  - packages/reference-peer/test (same `@optimystic/db-core` resolution)
  - packages/db-core/package.json (`exports` — the `./dist/src/index.js` entry that makes this so)
  - packages/db-p2p/register.mjs and each package's `test` script (where a mocha-side guard would attach)
  - ../sereus/test-harness/build-freshness.ts (a complete, working implementation of exactly this guard, in the sibling checkout)
difficulty: medium
repro: verified
----

# A test run can silently exercise a stale build, and nothing says so

## What happens

A package's own specs load its own source — `db-p2p`'s specs import
`../src/testing/mesh-harness.js`, so editing `db-p2p` source and re-running `db-p2p` tests does what
you expect. But the moment a spec reaches a *sibling* package it goes through that package's
`exports`, which point at `dist`:

| suite | how it reaches the code under test |
| --- | --- |
| `db-p2p` specs → `db-p2p` source | `../src/...` — live |
| `db-p2p` specs → `db-core` | `@optimystic/db-core` → `dist/src/index.js` — **built output** |
| `quereus-plugin-optimystic` specs → the plugin | `../dist/plugin.js`, `../dist/index.js` — **built output** |
| `reference-peer` specs → `db-core` | `@optimystic/db-core` → **built output** |

So editing `db-core/src` and running `yarn workspace @optimystic/db-p2p test` runs the *previous*
build of `db-core`. No warning, no error — the suite simply reports on code that is no longer on
disk. The inconsistency is what makes it dangerous: within one package no rebuild is needed, which
teaches the habit that gets it wrong across packages.

## Both failure directions are real

- **False green.** A change that should have broken something is not present in the run, so the
  suite passes and the change looks safe.
- **False regression.** A fix that is present in source is absent from the run, so a test that
  guards it appears not to.

## The measured instance

`repro: verified`, from a tending pass on 2026-09-06.

Verifying `complete/1-a-failed-attempt-must-discharge-its-own-pend`, the awaited-cancel change in
`db-core`'s pend failure path was reverted at its site and `db-p2p`'s suite re-run. Result: 2581
passing, 0 failing — read, reasonably, as *the test does not guard this change*. That conclusion was
written up, filed as an arm on a backlog ticket, and committed (`af94d4df`).

It was wrong. `db-core` had not been rebuilt, so nothing was ever disarmed. Re-run with
`yarn workspace @optimystic/db-core build` in between, the same spec fails immediately, with the
message it promises and the downstream fingerprint in its output. The finding was retracted
(`e978e347`).

Cost: one wrong conclusion committed to the ticket board and later reversed. It was caught only
because the sibling repository's own guard fired on an unrelated run minutes later.

## What already exists next door

`../sereus/test-harness/build-freshness.ts` is a finished implementation. It compares each target's
newest `src` mtime against its compiled entry point and fails the run **before any test starts**:

```
Stale build detected: these tests run real compiled output.
  - @optimystic/db-p2p: dist is stale — src was edited after the last build.
    Run in C:\projects\optimystic: yarn workspace @optimystic/db-p2p build
```

The message names the package, the reason, and the exact command — that specificity is most of its
value. Points worth taking from its design, whichever shape this ends up in:

- It distinguishes **workspace** targets from **linked** siblings, and locates a linked one the way
  Node itself would — walking the `node_modules` chain up from the calling module — because a
  package with `hoistingLimits: "workspaces"` gets a package-local copy that is the one its suite
  actually loads. Searching past the first hit would judge a copy that never runs.
- It deliberately lives **outside** any package and is imported by relative path, because a shared
  workspace package would itself be consumed from its own `dist` — "the guard against stale builds
  could be defeated by its own stale build".
- Each consuming suite declares the list of packages *it* runs compiled code from, rather than one
  global list.

## The one real design question, to settle during planning

Sereus attaches the guard through vitest's `globalSetup`. This repo runs **mocha** (see each
package's `test` script and `register.mjs`), which has no direct equivalent. The candidates:

- A mocha **root hook plugin** (`--require`) exporting a `beforeAll` root hook — closest analogue,
  runs in-process before any spec.
- A **pretest step** in each package's `test` script — simplest and completely independent of the
  test runner, at the cost of one more moving part per package.
- Fold it into each package's existing **`register.mjs`**, which is already `--import`ed.

Pick one and say why. Also decide whether `db-core` (which imports no sibling and needs no guard
today) gets one anyway for uniformity, and what the guard should do in CI, where a clean build
always precedes the tests and the check is pure cost.

## Scope

Not in scope: changing how packages resolve each other, or making specs import sibling `src`. The
`dist` resolution is correct — it is what consumers get. This ticket is only about **saying so** when
the built output no longer matches the source it was built from.

## TODO

- Decide the attachment mechanism above; record the reasoning in the implement ticket.
- Port or adapt `../sereus/test-harness/build-freshness.ts`. Read its doc comment first — it records
  two traps (the `node_modules` walk, and the guard-defeats-itself point) that cost that project
  real time.
- Wire it into the suites that actually run compiled sibling output: `db-p2p`,
  `quereus-plugin-optimystic`, `reference-peer`. Confirm the per-suite target lists rather than
  guessing them.
- Cover: a stale sibling `dist` fails the run; a fresh one passes; a **missing** entry point is
  reported as stale rather than crashing; the message names the package and the exact rebuild
  command.
- Verify the guard by reproducing the measured instance above — edit `db-core` source, run `db-p2p`
  tests without rebuilding, and confirm the run refuses to start instead of reporting green.
