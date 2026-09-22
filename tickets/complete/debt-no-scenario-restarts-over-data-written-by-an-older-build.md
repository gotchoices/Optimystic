description: A new test suite starts the current code over data that earlier published releases wrote to disk, and checks it can read all of it and keep writing — until now every test wrote and read its data with the same code, so an upgrade that broke existing data could pass every check.
files:
  - packages/upgrade-check/ (new private workspace: readme.md, writer/, scripts/write-fixture.mjs, fixtures/, test/)
  - packages/upgrade-check/test/upgrade-over-older-data.spec.ts (the suite)
  - packages/upgrade-check/writer/write-scenario.mjs (what a published build is made to write)
  - packages/upgrade-check/scripts/write-fixture.mjs (installs a published build from npm, runs the writer, packs the result)
  - docs/releasing.md (new release step 4, checklist line, a note under "Version alignment")
  - AGENTS.md (one paragraph in Testing)
  - yarn.lock (the new workspace only)
  - tickets/backlog/debt-no-scenario-runs-two-builds-in-one-cohort.md (new: the mixed-fleet arm, split off)
  - tickets/backlog/debt-optimystic-key-format-migration.md (appended: what the new fixtures do and do not reach)
----
# Complete: a suite that restarts the current build over data older releases wrote

`packages/upgrade-check` (private workspace) restarts the working tree's build over checked-in fixtures of what published releases wrote — `1.0.0-beta.3` and `1.2.0`, each for the `fs` and `leveldb` backends — and checks every row, both index trees, the unique constraint, the diary, the older build's in-flight commit, writes on top, and a second restart. It runs in plain `yarn test`, offline, in about 3 s. `yarn workspace @optimystic/upgrade-check write-fixture <version>` records a new release's fixture from npm; that is release step 4 in `docs/releasing.md`. The mixed-fleet half of the original ticket was split to `tickets/backlog/debt-no-scenario-runs-two-builds-in-one-cohort.md`. The package readme is the full description.

## Review findings

Read the implement diff (`715d1abb`) in full before the handoff: spec, fixture reader, current-build starter, writer, generator, LevelDB adapter, readme, AGENTS.md and `docs/releasing.md` changes, the two backlog tickets.

**Validation run:** `yarn workspace @optimystic/upgrade-check test` (31 passing, twice — before and after the edits), its `typecheck`, `eslint packages/upgrade-check`, `yarn lint:docs`, `yarn lint:deps`. The full root `yarn test` / `yarn check` was not run: the change adds one workspace plus docs, and nothing outside the new workspace changed.

**Correctness.** The spec's ordered steps match what the writer records (80 + 1 − 1 rows; 35 committed diary entries plus one in flight). The in-flight commit is replayed through the real `NetworkTransactor`, the pending record is checked before and after, and the implementer's negative control (a skewed declared base refused by both fixtures) shows the step is not vacuous. The documented-upgrade-step mechanism first proves the break is still there, so it cannot quietly mask a regression. The generator validates the version string before it reaches a shell and verifies the exact installed `@optimystic/*` versions. Nothing wrong found.

**Resource cleanup — fixed.** `startCurrentBuild` in `packages/upgrade-check/test/current-build.ts` left the libp2p node and the LevelDB handle open when `plugin.hydrate` threw, since the caller never received a handle to stop (`after` sees `current` undefined). It now stops them before rethrowing.

**Source hygiene — fixed.** `readRows` in the writer checked `rows.length !== INITIAL_ROWS`, which only holds because `writeTable` inserts one extra and deletes one; added a one-line comment saying so, since it reads as a mistake otherwise. File sizes are moderate (largest: generator, ~270 lines); comments say why, not what.

**Tests.** Every `it` checks a distinct read or write contract over data a different build wrote; none restates the implementation or verifies a mock. The *has a fixture* guard stops the suite passing vacuously on an empty `fixtures/`. Nothing cut, nothing added.

**Docs.** AGENTS.md (Testing), `docs/releasing.md` (new step 4, renumbered step 5, checklist line, the "Version alignment" note), the package readme, and the appended note in `debt-optimystic-key-format-migration` all match the code. Checked that nothing else in the tree refers to the old step numbering. `docs/internals.md` needs no change — the suite adds no runtime behaviour.

**Types/DRY.** `classic-level.mjs` is shared by writer, generator and reader, typed by one `.d.mts`, so the LevelDB adapter cannot drift between them. The writer's and reader's node start-up are near-duplicates by necessity (one must stay plain JS on the oldest published API); stated in both headers.

**Major / filed.** Nothing new filed. The implementer's "known gap" is confirmed by reading `isReservationAgainst` (`packages/db-p2p/src/storage/pending-claim.ts`): a pending record with no claimed revision — every record a pre-`pendingRevs` build wrote — reserves its block forever and is never swept. This is the documented conservative choice and belongs to the existing sweep ticket, so it was **appended as an arm** to `tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md` rather than filed fresh.

**Tripwires.** None new. The caret-range pairing (an old plugin resolving new `db-core`) is already parked as a `NOTE:` under "Version alignment" in `docs/releasing.md`. The fixture weight (~800 KB per release) is recorded in the readme's scope; no `NOTE:` needed until it grows.

**Considered and left alone.**
- `@optimystic/upgrade-check` declares `@libp2p/interface` without importing it directly. Left in: `db-p2p`'s type declarations reference it and the typecheck resolves through this workspace; removing it would gain nothing.
- The upgrade step's check matches the error text `/not found/`. That depends on Quereus's wording, but a changed message fails loudly rather than passing falsely, so it is acceptable.
- The generator has only been run on Windows. It uses `shell: true` only for literal commands plus a regex-validated version, which also works on POSIX; not verified there.
