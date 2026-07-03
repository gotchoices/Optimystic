description: Verify a docs/scripts polish pass — stale package docs corrected, two missing READMEs added, a misleadingly-named file renamed, and the root build/test/publish scripts replaced with automatic workspace iteration so no package is silently dropped.
prereq:
files: package.json, packages/db-p2p/README.md, packages/db-p2p-storage-rn/README.md, packages/demo/README.md, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts
difficulty: easy
----

Polish pass from review finding **eh-11** (+ **eh-7**). Four independent, mostly-mechanical items — **no behavioral code changes**. The only source change is a file rename (import-path churn); everything else is docs and root `package.json` scripts. Build and the full test suite are green post-change.

## What changed

### 1. `db-p2p` README retargeted for the storage split
`packages/db-p2p/README.md` previously presented filesystem storage as a built-in feature. Reality (verified in source): `db-p2p` owns `StorageRepo` (`src/storage/storage-repo.ts`) and `BlockStorage` (`src/storage/block-storage.ts`) plus the storage *interfaces* (`IRawStorage`, `IBlockStorage`, `IKVStore`) and an **in-memory** backend (`src/storage/memory-storage.ts`). `BlockStorage` reads/writes through an **injected `IRawStorage`** (`block-storage.ts:14`), so the backend is pluggable. The filesystem backend `FileRawStorage` moved to `@optimystic/db-p2p-storage-fs` (`packages/db-p2p-storage-fs/src/file-storage.ts:19`).

Edits: intro line, overview bullet, a new "Storage is pluggable" callout, the "Storage Layer" summary, the detailed `StorageRepo`/`BlockStorage`/`IRawStorage` component section (the `FileRawStorage` on-disk layout is now labelled as the `-storage-fs` backend), the db-core relationship block, the coordinator-setup usage example, the four mermaid subgraphs (`FileRawStorage`→`IRawStorage backend`, `Local Filesystem`→`Backend store`), and "Related Packages" (added pointers to all four `-storage-*` packages).

### 2. Two missing READMEs added
- `packages/db-p2p-storage-rn/README.md` — React Native LevelDB backend; documents the `rn-leveldb` peer dep, the caller-injects-the-constructor pattern (keeps unit tests runnable under Node via `classic-level`), exports (`LevelDBRawStorage`, `LevelDBKVStore`, `loadOrCreateRNPeerKey`, `openOptimysticRNDb`), and a pointer back to `db-p2p`. Modelled on the `-storage-ns` sibling README.
- `packages/demo/README.md` — private hello-world "messages" app; documents what it exercises (`MessageApp` over `db-core` collections against `TestTransactor`) and `yarn start` → `src/run.ts`.

### 3. Rename `restoration-coordinator-v2.ts` → `restoration-coordinator.ts`
No v1 ever existed; the class was already `RestorationCoordinator`. Renamed via `git mv` (history preserved). All 6 importers updated (`src/index.ts`, `src/rn.ts`, `src/libp2p-node-base.ts`, `src/cluster/block-transfer.ts`, `test/block-transfer.spec.ts`, `test/rebalance-reaction.spec.ts`). Confirmed no `restoration-coordinator-v2` references remain in `*.ts`/`*.js` outside `docs/` and `tickets/` (those are historical — left alone).

### 4. Root scripts → `yarn workspaces foreach`
Replaced ~50 hand-chained `cd <pkg> && yarn <task>` links (plus per-package sub-scripts) with derived iteration. Deleted every obsolete `build:*`/`clean:*`/`test:*`/`test:*:verbose`/`pub:*` sub-script. Deleted `scripts/publish-package.js` (confirmed via ripgrep it had no callers other than the removed `pub:*` scripts). Kept `bump`, `release`, `lint`, `upgrade:*`.

Final scripts:
```
clean:        yarn workspaces foreach -Ap  --exclude '@optimystic/optimystic' run clean
build:        yarn workspaces foreach -At  --exclude '@optimystic/optimystic' run build
test:         yarn workspaces foreach -At  --exclude '@optimystic/optimystic' run test
test:verbose: yarn workspaces foreach -At  --exclude '@optimystic/optimystic' run test:verbose
pub:          yarn build && yarn workspaces foreach -Apt --no-private npm publish --access public
```

**Deliberate deviation from the ticket's proposed `-Apt` on the run tasks.** `yarn workspaces foreach --help` (Yarn 4.12) confirms `-p,--parallel` **buffers** each workspace's output and prints it only after that process exits — real-time streaming requires `-i,--interlaced` *in addition*. Bare `-Apt` would therefore go silent during a long single-package build and risk the runner's 10-min idle timeout. The ticket explicitly sanctions the fix: "drop `-p` and rely on `-t` alone. Ordered + streaming is the priority." So build/test/test:verbose use `-At` (sequential, topological, live-streamed, ordered). Tradeoff: no cross-package parallelism → slower wall-clock (full build ~25s, full test ~6m46s observed). If a reviewer wants parallel speed back, `-Apti` streams-but-interleaves (output no longer per-package ordered); `pub` keeps `-Apt` since publish output is short and idle-timeout is a non-issue there.

## Validation performed (this is the floor, not the ceiling)

- `yarn build` → **exit 0, 25s**, all 11 packages produced `dist/` (db-core, db-p2p, db-p2p-storage-{fs,ns,rn,web}, demo, quereus-plugin-{crypto,optimystic}, reference-peer, substrate-simulator). No errors in log. Proves no infinite root-recursion, exclude works, topological order works, and the renamed file + updated imports compile.
- `yarn test` → **exit 0, "Done in 6m 46s"**, all suites green (db-core 1136, db-p2p 1103/36 pending, storage-ns/rn/web + plugins + reference-peer + substrate-simulator all passing). Streamed throughout (no idle gap).
- db-p2p tests run standalone first → **1103 passing, 36 pending** — directly exercises the two specs that import the renamed `restoration-coordinator.js`.
- **Coverage cross-check (the eh-7/eh-11 point).** Enumerated which packages define `test`/`test:verbose`:
  - New `test` set == old hand-list set (nothing lost). `db-p2p-storage-fs` has no `test` script yet → correctly skipped with a warning; it self-heals into the set once `storage-fs-tests-readme-ci` adds one.
  - New `test:verbose` now **includes `substrate-simulator`** — the old hand-list dropped it. Gain, no loss.
- `--no-private` on `pub` → cross-checked package `private` flags: publishes exactly the 9 non-private packages (db-core, db-p2p, db-p2p-storage-{fs,ns,rn,web}, quereus-plugin-{crypto,optimystic}, reference-peer); demo, substrate-simulator, and root are private → excluded. Matches the old `pub` set exactly.
- `package.json` re-parsed as valid JSON.

## Known gaps / things for the reviewer to weigh

- **`pub` / `npm publish` path is NOT executed** — it publishes to the public npm registry, inherently un-runnable inside a ticket. Flags were verified against `foreach --help` and the `--no-private` *selection* was cross-checked, but the actual publish (build → `npm publish --access public` per package, topological) has not been run. Old `publish-package.js` also did an explicit `yarn clean` per package; the new `pub` relies on tsc overwriting `dist/` (no explicit clean). If a stale-artifact concern surfaces, prepend `yarn clean &&` to `pub`.
- **`-At` vs `-Apt` is a speed/streaming tradeoff, documented above** — flagging it because it departs from the ticket's literal proposal. If the monorepo grows and sequential build/test wall-clock becomes painful, revisit `-Apti`.
- **db-p2p README filename case.** Git tracks the file as lowercase `readme.md`; the two new files use conventional uppercase `README.md`. Harmless on the case-insensitive dev FS, but a case-sensitive CI checkout would see the mismatch. Not introduced by this ticket (db-p2p's was already lowercase) — noting for awareness.
- **db-p2p README "Related Packages" still lists `@optimystic/db-quereus` (`../db-quereus`) and `p2p-fret` (`../fret`)** — the former has no matching package in this monorepo and looks stale, but retargeting those was out of scope (the ticket scoped only the *storage* claims). Left untouched; a reviewer may want a follow-up.
- **No new tests added** — this ticket is docs + script mechanics; the existing suite is the regression guard. No tripwires were parked (no conditional concerns arose).

## Suggested review focus
1. Read `packages/db-p2p/README.md` end-to-end as a newcomer: does it now correctly convey "filesystem storage is a separate package"? Spot-check the mermaid diagrams render.
2. Sanity-check the two new READMEs for accuracy against their packages' actual exports/`package.json`.
3. Re-run `yarn build` and `yarn test` to reproduce green. Optionally `yarn workspaces foreach -At --exclude '@optimystic/optimystic' --dry-run run test` to eyeball the selected set.
4. Decide the `-At` vs `-Apt(i)` question and whether `pub` needs an explicit `yarn clean &&`.
