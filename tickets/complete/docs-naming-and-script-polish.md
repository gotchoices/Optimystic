description: A docs/scripts polish pass — corrected stale package docs, two new READMEs, one file rename, and root build/test/publish scripts rewritten to iterate workspaces automatically — reviewed and landed.
prereq:
files: package.json, packages/db-p2p/readme.md, packages/db-p2p-storage-rn/README.md, packages/demo/README.md, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts
----

Polish pass from review finding **eh-11** (+ **eh-7**): stale docs, missing READMEs, a mis-named file, and hand-chained root scripts. Implemented in `cb73f41`, reviewed and completed here.

## What landed

1. **`db-p2p/readme.md` retargeted for the storage split** — filesystem storage is now correctly presented as a separate package (`@optimystic/db-p2p-storage-fs`); `db-p2p` owns the interfaces + an in-memory backend. Intro, overview, pluggable-storage callout, component sections, four mermaid subgraphs, and Related Packages updated.
2. **Two new READMEs** — `db-p2p-storage-rn` (React Native LevelDB backend) and `demo` (private hello-world messages app).
3. **Rename** `restoration-coordinator-v2.ts` → `restoration-coordinator.ts` (no v1 ever existed) via `git mv`; all 6 importers updated.
4. **Root scripts → `yarn workspaces foreach`** — replaced ~50 hand-chained `cd <pkg> && yarn <task>` links + per-package sub-scripts with derived iteration; deleted `scripts/publish-package.js` (no other callers). `build`/`test`/`test:verbose`/`clean` use `-At`/`-Ap` with `--exclude '@optimystic/optimystic'`; `pub` uses `-Apt --no-private`.

## Review findings

Read the implement diff (`cb73f41`) first, then verified against source.

**Checked — correct:**
- **Rename fully propagated.** All 6 `restoration-coordinator-v2` imports updated (`src/index.ts`, `src/rn.ts`, `src/libp2p-node-base.ts`, `src/cluster/block-transfer.ts`, and 2 specs). Grep confirms zero `restoration-coordinator-v2` references remain in `*.ts`/`*.js`; the 7 hits are all in `docs/`/`tickets/` (historical — correctly left alone).
- **Script workspace selection.** Enumerated all 12 package.json files: `--exclude '@optimystic/optimystic'` correctly drops only the private root from build/test/clean; `--no-private` on `pub` publishes exactly the 9 non-private packages (excludes `demo`, `substrate-simulator`, root) — matches the old hand-list. `db-p2p-storage-fs` has no `test` script → correctly skipped by `foreach` with a warning.
- **db-p2p README accuracy.** `MemoryRawStorage` (`src/storage/memory-storage.ts:5`) exists as claimed; `FileRawStorage` correctly attributed to `-storage-fs`.
- **demo README accuracy.** `MessageApp`, `src/run.ts`, `src/message-app.ts`, and `TestTransactor` from `@optimystic/db-core/test` all match source.

**Found + fixed inline (minor):**
- **RN README usage example was wrong and would crash on copy-paste.** It passed `writeBatchCtor: LevelDBWriteBatch`, but the actual option field is `WriteBatch` (`rn-opener.ts:61`) — the given name is ignored, leaving `WriteBatch` undefined, which throws the moment `db.batch()` is called. Also used `await openOptimysticRNDb(...)` though the function is synchronous (returns `LevelDBLike`, not a Promise). Corrected both (`packages/db-p2p-storage-rn/README.md`).

**Noted, not fixed (pre-existing, out of scope):**
- db-p2p README "Related Packages" still lists **`@optimystic/db-quereus (../db-quereus)`** and **`p2p-fret (../fret)`**. Neither `packages/db-quereus` nor `packages/fret` exists; `p2p-fret` is a real *external* dependency (portal to `../Fret/packages/fret`, outside this repo), so its `../fret` link is also wrong. These predate this ticket, which scoped only the *storage* claims. Not fixed here: correcting `db-quereus` needs knowledge of whether it's a planned/external package (intent unclear), and I won't guess a doc target. A future docs pass on that section can resolve it — too minor and speculative for its own ticket.

**Tests / lint:**
- `yarn lint` → **exit 0**.
- `yarn build` (new `foreach -At` script) → **exit 0, 27s**, all 11 packages produced `dist/` — proves the rename compiles, exclude works, and topological iteration works.
- `yarn test` (new `foreach -At` script) → **exit 0, "Done in 6m 54s"**, all suites green (db-core 1136, db-p2p 1103/36 pending, storage-ns/rn/web + plugins + reference-peer + substrate-simulator). Streamed throughout, no idle gap. The two specs importing the renamed `restoration-coordinator.js` are exercised here.
- My README edit is docs-only; no code path changed, so the green suite is unaffected.

**No new tests:** this is docs + script mechanics; the existing suite is the regression guard. Confirmed appropriate — the only source change (rename) is a pure import-path move already covered by the compile + the two db-p2p specs.

**Tripwires:** none parked. No conditional/latent concerns arose — the `-At` vs `-Apt(i)` speed/streaming tradeoff is already documented in the script region and the implement handoff, and is a deliberate, correct choice (streaming ordered output avoids the runner's idle timeout).

**Not executed:** `pub` / `npm publish` — inherently un-runnable inside a ticket (publishes to the public npm registry). Flags verified against `foreach --help` and `--no-private` selection cross-checked against package `private` flags; the actual publish was not run. Same caveat the implementer flagged.
