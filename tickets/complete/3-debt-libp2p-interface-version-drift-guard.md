description: A build check now fails when parts of our networking stack get installed against different major versions of the same core library, and the last dependency that caused such a split has been removed.
files:
  - scripts/check-libp2p-majors.mjs (the guard's entry point: runs yarn, prints, sets the exit code)
  - scripts/libp2p-majors.mjs (the guard's pure logic, imported by the tests)
  - scripts/shared-majors.cjs (the one list of guarded packages, read by both guards)
  - yarn.config.cjs (requires the shared list; reports a contradiction between the two lists)
  - package.json (root — `lint:deps`, `check`, `test:harness`)
  - test-harness/libp2p-majors.test.mjs
  - packages/db-core/package.json, packages/db-core/test/simulation.ts, yarn.lock (peer-id-factory removal)
  - packages/db-p2p/src/libp2p-node-base.ts (accepted-tradeoff record on the `services:` cast)
  - AGENTS.md, docs/releasing.md, scripts/release-preflight.mjs
----

# Resolved libp2p major guard

## What landed

libp2p is split into many small npm packages that share the type definitions in `@libp2p/interface`, and two components only work together if they were built against the same major of it. `@chainsafe/libp2p-gossipsub@14` once shipped here built against major 2 inside a major-3 tree and failed silently (gotchoices/Optimystic#9). The existing Yarn constraints could not have caught that, because they only read the ranges our own workspaces declare.

- **Last cross-major dependency removed.** `@libp2p/peer-id-factory` was the only thing pulling in `@libp2p/interface@1.7.0`, `@libp2p/crypto@4.1.9` and `@libp2p/peer-id@4.2.4`. db-core's simulation helper now mints peer ids with `generateKeyPair('Ed25519')` plus `peerIdFromPrivateKey`, with no cast.
- **One list, two guards.** `scripts/shared-majors.cjs` maps each guarded package to its expected major (`@libp2p/interface` 3, `@libp2p/interface-internal` 3, `@libp2p/crypto` 5, `@libp2p/peer-id` 6, `uint8arrays` 6). It also explains why `multiformats` and `uint8arraylist` are deliberately left off. `yarn.config.cjs` requires it to check declared ranges, and `scripts/check-libp2p-majors.mjs` uses it to check the installed tree through `yarn info --all --recursive --json --dependents`.
- **What the guard reports.** It fails when a guarded package is installed at any other major, naming each version and what pulls it in, or when a guarded package is not installed at all (the list is stale). Every major-mismatch report ends with a paragraph saying it covers this workspace only, not a remote peer's libp2p build.
- **Wiring.** `yarn lint:deps` runs `yarn constraints` and then the guard. `check` runs it after `lint:docs`, ahead of the build. `test:harness` now runs every `test-harness/*.test.mjs`.
- **Docs.** AGENTS.md § Dependencies explains which guard covers what. The `yarn check` step lists in AGENTS.md, `docs/releasing.md` and `scripts/release-preflight.mjs` now match the real script.

## Review findings

Reviewed the implement diffs (681d09c9 salvage, a7686808) against the plan ticket's requirements before reading the handoff.

**Validation run in review** (Windows 11, node 24.2.0, yarn 4.12.0): `yarn lint`, `yarn lint:docs` (45 documents) and `yarn lint:deps` passed. `yarn test:harness` passed 51/51. `yarn constraints` passed on the real config, and on a temporary contradictory pin (reverted) it exited 1 with the expected message. `yarn info -A -R --json --dependents @libp2p/interface` shows only 3.1.0, 3.2.3 and 3.2.4. The 3.1.0 row has 27 dependents, including `libp2p`, identify, kad-dht, tcp, websockets, circuit-relay-v2, bootstrap, noise and yamux, which confirms the reasoning behind the accepted tradeoff. There is no `peer-id-factory` left in source, manifests or docs (only in test fixtures, on purpose). I did not rerun build, typecheck or unit tests: my code edits are a TypeScript comment, a JSON script string and the constraints file, none of which is compiled. The implementer's full `yarn test` pass (db-core 1640, db-p2p 2705) stands.

**Plan requirements.** All met. The pure logic sits apart from the shell-out. The version is read from `children.Version`, not the locator. Empty yarn output and a missing guarded package both fail. Prereleases and multi-digit majors are handled. Workspace, portal and virtual locators render readably. A test checks that the scope sentence is present. The `SINGLE_RANGE` comment no longer calls transitive skew unguarded. The peer-id-factory removal landed before the wiring. Splitting the logic into `scripts/libp2p-majors.mjs` differs from the plan but is sound, and it removes a "was I run directly?" check that could have failed silently.

**Fixed in this pass (minor):**
- `package.json` `check` had `&&yarn typecheck` (missing space). Fixed.
- `yarn.config.cjs` threw when a `SINGLE_RANGE` pin contradicted the shared major, so Yarn printed "Internal Error" with a stack trace, a gap the handoff itself named. It now reports through `Yarn.workspace().error(...)` and skips that package's `dep.update`, so `yarn constraints --fix` can never write a pin in the wrong major. Verified: the output is `└─ @optimystic/optimystic@workspace:. └─ yarn.config.cjs pins @libp2p/peer-id to ^5.0.0, but scripts/shared-majors.cjs expects major 6`, exit 1.
- The comment above the `services:` cast in `packages/db-p2p/src/libp2p-node-base.ts` was 17 lines and re-derived the reasoning already in `scripts/shared-majors.cjs`. It is now 8 lines. The accepted-tradeoff `NOTE:` still states what was declined, why, and when to revisit.
- AGENTS.md § Dependencies did not say where the guard's logic and tests live, and the § Testing paragraph on `yarn test:harness` only covers build freshness. Added one sentence naming `scripts/libp2p-majors.mjs` and `test-harness/libp2p-majors.test.mjs`.

**Checked, no issue found:**
- *Correctness:* the locator regex matches Yarn's grammar, including `patch:` references that embed a second `@`. Grouping puts the expected major first. Semver parsing rejects `v3.2.4` and `workspace:^`. Non-JSON output from yarn (e.g. a Corepack notice) throws instead of being skipped.
- *Security:* the Windows `cmd.exe /d /s /c` route is safe because every package name must match a strict regex that rules out shell metacharacters, and a test covers `& calc`.
- *Error handling:* when yarn fails, the guard relays everything yarn printed to stdout and stderr and exits 1.
- *Type safety:* the `.mjs` files are untyped but JSDoc'd, which matches `check-doc-citations.mjs`. `shared-majors.cjs` is `@ts-check`'d.
- *Performance:* one `yarn info` call, and the logic is linear in the number of installed versions. No concerns at this size.
- *Resource cleanup:* nothing to clean up (synchronous process, no temp files).
- *Tests:* they cover the happy path, a second major, a tree wholly on the wrong major, stale entries, empty output, non-semver versions, locator rendering, truncation, parse errors, and command shape on both platforms. The one gap: the tests check the shape of the real list, not its contents, so a bad addition is caught only when `yarn lint:deps` runs. That is acceptable because `check` runs it.
- *Docs:* `docs/releasing.md`, `scripts/release-preflight.mjs`, and AGENTS.md § Testing/§ Dependencies all match the real `check` script.

**Known gaps accepted as-is (no ticket):**
- The non-Windows spawn path (`execFileSync('yarn', …)`) has never run. The repo has no CI to run it. It is the standard form, and a test covers its argument shape, but the first Linux or macOS `yarn lint:deps` is its first real run.
- If every guarded package were missing, yarn itself exits 1 and the report can't name which entries are stale. Its "likely causes" text covers that case, and partial absence is still reported per package.
- The `yarn check` step list is kept by hand in three places. The existing `NOTE:` in `scripts/release-preflight.mjs` is the tripwire, and I didn't add one.
- The quoted `node --test "test-harness/*.test.mjs"` glob needs Node 21 or later, and the repo has no `engines` field. Node 20 reached end of life in April 2026, so I made no change.

**Tripwires:** no new ones. The existing `NOTE:`s above `SCOPE` in `scripts/libp2p-majors.mjs` and in `scripts/release-preflight.mjs` are still accurate.

**Major findings / new tickets:** none. Nothing found needed more than an inline fix.

**Outside this ticket, noted for the record:** commit a7686808 also contains an unrelated React Native bundling change: the `NO_STATIC_BLOCK` lint rule in `eslint.config.js`, and `packages/db-p2p/src/storage/block-latch.ts` moving its `static { }` block to a `static #wired` field initializer. Most likely it came from the concurrent RN debugging work described in `tickets/.garden-report.md` and was committed in the same working tree. I didn't review it in depth, but `yarn lint` passes with it, and the implementer's build, typecheck and full `yarn test` ran with it in place.
