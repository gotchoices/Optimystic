description: Review the new build check that fails when parts of our networking stack get installed against different major versions of the same core library, together with the removal of the last dependency that caused such a split.
files:
  - scripts/check-libp2p-majors.mjs (new — the guard's entry point: runs yarn, prints, sets the exit code)
  - scripts/libp2p-majors.mjs (new — the guard's pure logic, imported by the tests)
  - scripts/shared-majors.cjs (new — the one list of guarded packages, read by both guards)
  - yarn.config.cjs (now requires the shared list)
  - package.json (root — `lint:deps`, `check`, `test:harness`)
  - test-harness/libp2p-majors.test.mjs (new)
  - packages/db-core/package.json, packages/db-core/test/simulation.ts, yarn.lock (peer-id-factory removal)
  - packages/db-p2p/src/libp2p-node-base.ts (comment only — accepted-tradeoff record on the `services:` cast)
  - AGENTS.md, docs/releasing.md, scripts/release-preflight.mjs
----

# Resolved libp2p major guard — review handoff

## What this change does

libp2p is split into many small npm packages that all share the type definitions in `@libp2p/interface`; two components only work together if they were built against the same major of it. Nothing checked that. `@chainsafe/libp2p-gossipsub@14` shipped here built against major 2 inside a major-3 tree and failed silently (gotchoices/Optimystic#9). The existing Yarn constraints in `yarn.config.cjs` could not have caught it: they read only the ranges our own workspaces declare, and the bad range lived in gossipsub's own manifest.

What landed:

- **Last cross-major dependency removed.** `@libp2p/peer-id-factory` was the sole dependent of `@libp2p/interface@1.7.0`, `@libp2p/crypto@4.1.9` and `@libp2p/peer-id@4.2.4`. It is gone from db-core; `packages/db-core/test/simulation.ts` now mints peer ids with `generateKeyPair('Ed25519')` plus `peerIdFromPrivateKey`, and its `as unknown as PeerId` cast is gone (the compiler accepts it). `yarn.lock` drops the three packages. This part was done by an interrupted earlier run, salvaged in commit 681d09c9, and re-verified here.
- **One list, two guards.** `scripts/shared-majors.cjs` holds the expected-major map — `@libp2p/interface` 3, `@libp2p/interface-internal` 3, `@libp2p/crypto` 5, `@libp2p/peer-id` 6, `uint8arrays` 6 — plus the reasoning that used to live in `yarn.config.cjs`, including why `multiformats` and `uint8arraylist` are deliberately left out (their 13/14 and 2/3 splits follow from the deliberate `@libp2p/interface` 3.1-versus-3.2 minor drift). `yarn.config.cjs` now `require`s it.
- **The resolved-tree guard.** `scripts/check-libp2p-majors.mjs` runs one `yarn info --all --recursive --json --dependents <packages>` and hands the output to the pure functions in `scripts/libp2p-majors.mjs`. It fails when a guarded package is installed at any major other than its declared one (naming each offending version and what pulls it in), or is not installed at all ("the list is stale"). The report always ends with a scope paragraph saying the check covers this workspace only and says nothing about a remote peer's libp2p version.
- **Wiring.** Root `lint:deps` runs `yarn constraints && node scripts/check-libp2p-majors.mjs`, and is inserted into `check` right after `lint:docs`, ahead of the build. `test:harness` is widened to `node --test "test-harness/*.test.mjs"`.
- **Accepted tradeoff recorded.** The `NOTE:` above the `services:` cast in `createLibp2pNodeBase` is now an accepted-tradeoff record: raising db-p2p's `@libp2p/interface` pin was declined (the 3.1/3.2 split is deliberate, and the libp2p packages db-p2p builds on resolve 3.1.0 regardless, so the cast would only move); revisit when that libp2p release line itself declares `@libp2p/interface@^3.2` or later.
- **Docs.** AGENTS.md § Dependencies now says which guard covers declared ranges and which covers the installed tree; the `yarn check` summaries in AGENTS.md § Testing, the `docs/releasing.md` table and checklist, and the list `scripts/release-preflight.mjs` prints all match the real `check` script. They already lacked `lint:docs`, and the preflight list also lacked `typecheck`.

## Using and exercising it

| Scenario | How | Expected |
|---|---|---|
| Healthy tree | `yarn lint:deps` | constraints silent, then `check-libp2p-majors: 5 guarded packages, 10 installed versions — each on its expected major.`, exit 0 |
| Help | `node scripts/check-libp2p-majors.mjs --help` | usage text, exit 0 |
| Unit tests (never invoke yarn) | `yarn test:harness` | 51 tests pass: 28 new, 23 existing build-freshness |
| A real two-major split | copy `scripts/check-libp2p-majors.mjs` and `scripts/libp2p-majors.mjs` into a temp dir beside a `shared-majors.cjs` of `module.exports = { SHARED_MAJOR: { '@libp2p/interface': 3, 'multiformats': 13 } }`, then run the copy with the repo root as the working directory | exit 1; `multiformats resolves to 2 majors in this project; expected only major 13.`, the `14.0.0` row lists its 9 dependents, then the explanation and scope paragraphs |
| Stale entry | same, adding `'@libp2p/peer-id-factory': 4` | exit 1; "is guarded by scripts/shared-majors.cjs … but is not installed anywhere … The list is stale." |
| Nothing matches | same, listing only a nonexistent package | exit 1; yarn's own "No package matched your request" relayed, with likely causes |
| The two lists contradict | temporarily set `@libp2p/peer-id` to 5 in `scripts/shared-majors.cjs`, run `yarn constraints`, revert | Yarn "Internal Error: yarn.config.cjs pins @libp2p/peer-id to ^6.0.4, but scripts/shared-majors.cjs expects major 5" |
| Confirm the removal | `yarn info -A -R --json --name-only '@libp2p/interface' '@libp2p/crypto' '@libp2p/peer-id'` | only 3.x, 5.x and 6.x rows |

All of the failure rows above were run in this session against the real installed tree and behaved as described. The temp-copy approach meant the tracked list was never edited except for the last contradiction check, which was reverted and re-verified.

## Validation run in this session (Windows 11, node 24.2.0, yarn 4.12.0)

- `yarn lint` passed; `yarn lint:docs` passed (45 documents); `yarn lint:deps` passed; `yarn test:harness` 51/51.
- `yarn build` passed; `yarn typecheck` passed.
- `yarn test` exit 0 in 6m22s — db-core 1640 passing, db-p2p 2705 passing / 50 pending (env-gated specs), every other workspace green.
- Cast probe: with `as unknown as NonNullable<Libp2pInit['services']>` removed, db-p2p's typecheck fails with TS2322 on `dcutr()` and `autonat()` only — their `@libp2p/interface` 3.2.x copy disagrees with db-p2p's 3.1.x on `Uint8Array<ArrayBuffer>` versus `Uint8Array<ArrayBufferLike>`. Cast restored before the build, typecheck and test runs above.
- **Not run:** `yarn test:integration` (env-gated, real sockets). No runtime code changed: db-p2p's diff is a comment, db-core's is a test helper.

## Deviations from the plan ticket

- **Pure logic in its own module**, `scripts/libp2p-majors.mjs`. The plan named only `scripts/check-libp2p-majors.mjs`. A single file needs a "was I run directly?" test so the unit tests can import it, and if that test misjudges (a symlinked path, say) `main()` never runs and the guard exits 0 having checked nothing — the exact silent pass it exists to prevent. With the split, the entry script runs unconditionally.
- **Default import of the CommonJS list** (`import sharedMajors from './shared-majors.cjs'`). A named import worked only for the exact `module.exports = { SHARED_MAJOR }` spelling; it broke the moment the export was written differently, which surfaced while proving the guard fails.
- **Windows spawn route.** `execFileSync('yarn', …)` fails with ENOENT on Windows and `yarn.cmd` with EINVAL (Node refuses to spawn `.cmd` files without a shell), and `shell: true` with an argument array is deprecated. The guard runs `cmd.exe /d /s /c yarn …` with an argument array, made safe by validating every package name against a strict regex first.
- **`yarn.config.cjs`.** The declared-major loop skips packages that are also in `SINGLE_RANGE`, which already pins them exactly and autofixably, so they are not reported twice. It also throws if a `SINGLE_RANGE` pin falls outside that package's `SHARED_MAJOR`. The file was re-indented from spaces to tabs per `.editorconfig`, so read its diff with `git diff -w`.

## Known gaps — push on these

- **The non-Windows spawn path was never executed.** On Linux and macOS the guard spawns `yarn` directly; that branch is unit-tested for argument shape only. Run `yarn lint:deps` on a non-Windows machine or in CI before trusting it there.
- **"Nothing matches" is less specific.** If every guarded package were absent, yarn itself exits 1 and the report cannot say which entries are stale. Partial absence, the realistic case, is reported per package.
- **The contradiction check throws**, which Yarn prints as "Internal Error" with a stack trace. The first line is the real message; a constraints-native report would read better if one fits.
- **Locator rendering** handles `npm:`, `workspace:`, `portal:`/`link:`/`file:`, `patch:` (shown as "(patched)", without a version) and `virtual:` wrappers; any other protocol renders as `name (protocol)`. Only npm, workspace, portal and virtual locators occur in the tree today.
- **The `yarn check` step list is hand-maintained in three places** — the root `check` script, `docs/releasing.md`, and `scripts/release-preflight.mjs`. A `NOTE:` in the preflight says to change them together; nothing enforces it.
- **The tests check that the real list is well-formed, not what it contains.** Adding `multiformats` or `uint8arraylist` is caught by `yarn lint:deps` failing on the first run, not by a unit test.

## Tripwires parked in code

- `NOTE:` above `SCOPE` in `scripts/libp2p-majors.mjs` — the remote-peer scope paragraph is load-bearing, and a test fails if it is removed.
- `NOTE:` in `scripts/release-preflight.mjs` — its step list mirrors `check` and `docs/releasing.md`.
- `NOTE: accepted tradeoff` above the `services:` cast in `packages/db-p2p/src/libp2p-node-base.ts`.

Deliberately out of scope, and already tracked elsewhere: the sibling `../sereus` relay/bootstrap container on `libp2p@^2` (`sereus/tickets/backlog/debt-relay-container-is-a-libp2p-major-behind-its-clients`), and `debt-mixed-version-identify-incompatibility` in this repo's backlog.
