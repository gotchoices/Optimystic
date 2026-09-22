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
# Review: a suite that restarts the current build over data older releases wrote

## What was built

`packages/upgrade-check`, a private workspace. Its readme is the full description; in short:

- **Fixtures** — `fixtures/<version>/<backend>.json`, checked in, one per release and per storage backend. Each is the stored bytes a *published* build left behind after running one scenario, plus a manifest of what a reader must find. Checked in: `1.0.0-beta.3` and `1.2.0`, each for `fs` (`FileRawStorage` + `FileKVStore`, what `reference-peer` runs) and `leveldb` (`LevelDBRawStorage` + `LevelDBKVStore` over `classic-level`, the React Native app's layout). About 400 KB each, ~45 KB gzipped; one stored value per line so a diff shows which changed.
- **The scenario** (`writer/write-scenario.mjs`, plain JS, run inside a scratch install of the published packages): one solo libp2p node; a SQL table with a `unique` column and a declared index, 80 rows in one statement (splits the B-tree), updates to both indexed columns and a delete; a 35-entry diary (log spans two chain blocks); then one more append whose pend lands and whose commit is captured into the manifest and never sent, and the node is stopped.
- **The generator** (`yarn workspace @optimystic/upgrade-check write-fixture <version> [--force]`): npm-installs `@optimystic/*@<version>` into a temp dir with exact-version `overrides`, verifies every `@optimystic/*` package is installed once at exactly that version (a plain install of plugin `1.0.0-beta.3` resolves `db-core`/`db-p2p` 1.2.0 — verified), runs the writer once per backend, packs. Needs the network; refuses to overwrite an existing version without `--force`. Takes about 15 s per version.
- **The suite** runs in plain `yarn test` (and so `yarn check`), offline, ~3 s. It uses the sibling workspaces' `dist`, guarded by the usual `register.mjs` build-freshness check.

## Answers to the ticket's open questions

- **Where build A comes from:** npm, at fixture-generation time only; the test reads the checked-in result. Regenerating re-installs the same published packages, so a fixture cannot drift into describing the working tree. `writtenBy` in each manifest records every package version that wrote it (beta.3's writer ran on Quereus 4.19.4, the newest its peer range allowed at generation time, not whatever beta.3 was originally tested with).
- **Which data directory:** both deployed backends. The shared value encoding (`KvRawStorage`) means SQLite and IndexedDB are covered for *what* is stored, not for their own table/object-store layout — stated in the readme.
- **Should the gate run it:** yes, the read side is fast and offline, so it is in `yarn test`. Recording a new release's fixture is release step 4 in `docs/releasing.md`.

## Tests added

All in `packages/upgrade-check/test/upgrade-over-older-data.spec.ts`; one `describe` per fixture (four today). Its `it`s are ordered steps over one data directory — they are not independent, by design, and say so in the header.

- *has a fixture to run against* — fails if `fixtures/` is empty rather than passing vacuously.
- *takes the documented upgrade step: re-declare each table…* (beta.3 only) — proves the current build still does not read beta.3's bare-name catalog records (the plugin README's "Format-break caveat"), then re-runs the DDL the writer recorded. If a later build starts reading the old key, this step fails and should be deleted (`DOCUMENTED_UPGRADE_STEPS`).
- *reads every row…, and both indexes agree* — full scan equals the manifest; `verifyIndexes` reports no missing/orphaned entries in the declared and unique-enforcement trees.
- *finds rows through the unique index and the declared index* — including that a value the older build moved away no longer finds its old row.
- *refuses a duplicate of a unique value the older build wrote.*
- *reads the diary without the append that was in flight.*
- *lands the append that was in flight* — the older build's pending record exists, the manifest's commit is delivered through the current `NetworkTransactor`, it succeeds, the record is promoted, the diary shows the entry. For beta.3 this is the only test anywhere that commits a pending record with **no stored base** (`pendingRevs`/`pendingBases`/`lineageFloor` are all absent in beta.3 metadata). Checked by a manual negative control, not left in the suite: skewing the manifest's declared base by one made beta.3's commit fail with "local latest 35 is not the **declared** base 34" (the fallback arm in `StorageRepo.guardCommitBase`) and 1.2.0's with "stored base 35 disagrees with declared base 34".
- *writes on top of the older data* — new rows, edits of old rows in both indexed columns, delete of an old row and reuse of its unique value, a diary append; index agreement rechecked.
- *reads the older data and the new writes back after restarting again* — second node start over the same store; for beta.3 this also proves the re-declared table's new-format catalog record hydrates.

Validation run: the suite (31 passing), `yarn typecheck` for the workspace, eslint, `yarn lint:docs`, `yarn lint:deps`, `yarn test:harness`, and the fs and rn storage suites. The full root `yarn test` / `yarn check` was **not** run: the change adds a workspace and docs only, and the lockfile diff adds only the new workspace entry.

## Findings, and where each went

- **beta.3 → current loses tables from the catalog until re-declared.** Already a documented format break (plugin README); the suite now proves the documented remedy actually works — rows, the declared index tree and the unique-enforcement tree all reattach. No ticket.
- **Our caret ranges let npm pair an old plugin with a new db-core.** Verified with a plain `npm install`. The writer ran without error on exactly that mix (plugin beta.3 over db-core/db-p2p 1.2.0), so nothing is broken today; recorded as a `NOTE:` tripwire under "Version alignment" in `docs/releasing.md`.
- **The `transact` return-value flip is not a mixed-fleet risk**, contrary to the original ticket: its only caller is `Collection` inside db-core, so each process runs a consistent pair. The in-process pairing above is the real shape; said so in the new backlog ticket.
- **Mixed fleet (the ticket's second arm)** was not built — it needs a live published build at run time (network, a child process, a two-member cohort on real sockets), so it can only be a manual pre-release step and has its own open questions. Filed `tickets/backlog/debt-no-scenario-runs-two-builds-in-one-cohort.md`, which reuses this workspace's install/verify code.
- **`debt-optimystic-key-format-migration`**: all three format changes it lists predate beta.3, so no fixture reaches them; appended that note to the ticket.

## Known gaps — please weigh these

- **A leftover pending record whose writer never came back** is not tested. On a solo local node it blocks the next write to that block in any version (the known `debt-unpromotable-pending-records-need-a-sweep`). Separately, by reading `isReservationAgainst` in `packages/db-p2p/src/storage/pending-claim.ts` (static, not run): a beta.3 leftover carries no claimed revision, which the rule treats as the strongest claim, so it keeps reserving its block even after the collection moves past — where a 1.x leftover stops. That is the documented conservative choice ("an old record can only refuse more than it should"), so not filed; a reviewer may disagree.
- **The in-flight commit is replayed from the manifest**, modelling a remote writer's commit arriving at a storage node that restarted. A writer in the same process as the node loses its in-flight write on restart; that case is not modelled.
- **Solo-node data only**: multi-signer proofs and a ledger owing copies to real peers never appear in a fixture.
- **The generator was run only on Windows** (npm via `shell: true`, which Node requires for the `.cmd` shim). It uses only literal commands plus a regex-validated version string.
- **Fixture weight**: ~1.7 MB across the four files in the working tree, and each release adds ~800 KB. If that grows uncomfortable, the diary's 35 commits (there only to span two chain blocks) are most of it.
- **`DOCUMENTED_UPGRADE_STEPS` is keyed by explicit fixture version strings**, deliberately (no semver parsing); a new pre-1.0 fixture would need adding to the list by hand.
