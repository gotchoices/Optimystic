description: When an app applies its whole database schema at once, our plugin used to save the table catalog separately after every table and index and re-read the growing catalog each time. It now holds the catalog changes in memory for the whole apply and saves them in one commit at the end, and catalog reads no longer grow with the number of tables. Reviewed: the in-memory overlay, its per-statement rollback, and the deliberate choice to commit what landed even when the apply fails part-way.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (CatalogBatch: the overlay, one committed tree opened once, checkpoint/restore, the one-commit flush with re-merge)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (beginBatch / commitBatch / checkpointBatch / restoreBatch; every catalog read and write routes through the batch while one is open)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule.beginSchemaBatch / endSchemaBatch / underBatchCheckpoint; OptimysticVirtualTable.markSchemaUnpersisted and catalogManager)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (18 cases after review)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (re-baselined; gates 5 and 6 pin non-growth at the transactor seam)
  - docs/transactions.md (section "APPLY SCHEMA coalesces catalog writes")
difficulty: hard
----

# Complete: catalog writes and reads coalesced across one `APPLY SCHEMA`

## What landed (implement stage, commit 36ebe7a2)

Quereus brackets the migration-DDL loop of `apply schema` with `beginSchemaBatch` / `endSchemaBatch`, fired inside its execution lock only when the plan is non-empty. The plugin implements both. Between them each `SchemaManager` holds a `CatalogBatch`: writes go into an insertion-ordered in-memory overlay keyed by table name; every catalog read (table lookup, gravestone lookup, the storage-adoption guard's walk by URI, and the write paths' own re-reads) is answered from the overlay first and otherwise from one committed catalog tree opened and refreshed once per batch. At `endSchemaBatch` each manager re-merges every pending live record with the latest committed one (the same index union the unbatched write does at every write) and stages plus syncs the whole set in one commit. A manager with nothing pending does no I/O, and the catalog is created only at that commit and only when something is pending.

Each `create`, `createIndex` and `destroy` runs under a per-statement checkpoint: a throw restores the overlay to what it was before the statement. The batch commits on error too, on purpose: Quereus keeps the statements that landed when an apply fails part-way, so discarding the overlay would leave tables in the engine's catalog with no persisted record. If the end-of-batch commit itself fails, every table created or altered through that manager is marked unpersisted and re-persists itself (indexes included, refreshed from its `IndexManager`) on its next touch.

Measured on the cold-apply cost spec (1-node mesh, coordinated commit path): commits went from `T + 2·I` to `1 + I` (35 → 14 small, 80 → 14 large); transactor gets per object from 40.9 / 55.0 (growing with scale) to 2.5 / 1.5 (falling with scale). The remaining `I` commits are the invented index-tree flushes, which `schema-batch-index-tree-flush-deferral` (in `implement/`) removes.

## Review findings

### What was checked

- The implement diff read first, fresh, before the handoff: `catalog-batch.ts` (new), the batched arms of `schema-manager.ts`, the module's hooks, checkpoint wrapper, `markSchemaUnpersisted`, and the three wrapped DDL sites.
- The Quereus side of the contract (`runBatchedMigrationLoop` / `beginSchemaBatchAll` / `endSchemaBatchAll` in the installed `@quereus/quereus` dist): end fires in a `finally`, receives the loop error, swallows an end-error when there was a loop error and rethrows the first one otherwise. The implementation's throw-on-unmatched-end and commit-on-error reasoning match that contract; loud on a missing begin is right, since the engine only ever calls end after a successful begin.
- The db-core tree API the one-commit flush rests on: `stage` = act only, `sync` = `updateAndSync`, `replace` = act + `updateAndSync`. The explicit `update()` before the re-merge is needed (pending actions replay on top of a refresh, so a merge after staging would be too late). `[name, undefined]` entries are the same delete shape the unbatched tombstone write uses.
- The transactor captured at the batch's first open is the collection factory's cached, long-lived transactor per configuration, so reusing it across statements and for the end commit is sound in both autocommit and session mode. The batch's tree instance is a fresh open (the factory caches per transaction state, and the manager builds a fresh one per open), so a failed commit's staged actions die with the discarded batch.
- `markSchemaUnpersisted`'s index refresh reads `IndexManager.getDeclaredIndexes()`, which returns only `schema.indexes`, never the synthesized uniqueness-enforcement trees, so a recovery cannot persist those as real indexes. Hydrated tables carry declared columns (hydrate registers the persisted columns with Quereus), so the recovery's declared-columns arm covers them too.
- `getSchemaFresh`'s fallback to the per-instance cache behaves identically inside and outside a batch (a committed gravestone reads as absent in both, and `deleteSchema` clears the cache before staging), so no new stale-read path was introduced.
- Every site's `NOTE:`s and the sibling tickets touching these files (`2-schema-batch-index-tree-flush-deferral`, `debt-optimystic-vtab-class-is-too-big-to-review`); nothing here re-files a decided tradeoff.
- Lint (eslint on the touched files), typecheck, `yarn lint:docs`, the two spec files, and the full plugin suite. All pass after the fixes below; see "Pre-existing failure" for the one unrelated flake.

### What was found and fixed inline (minor)

- **Dropped tables were invisible in the end-commit-failure path.** `destroy` ran under the checkpoint but recorded nothing, so when the one catalog commit failed the log named only the created/altered tables while the gravestones of every table dropped in that apply were lost silently. That loss is the same failure direction as the unbatched, best-effort drop (the record outlives its DROP, the next hydrate resurrects the table, a later CREATE over the same URI is unchecked), but the unbatched path logs it and the batched one did not. The batch now records `dropped` per manager alongside `written`, `underBatchCheckpoint` takes the effect explicitly, and the log names both sets. Pinned by a new case: warm database, apply that drops one table and creates another, catalog sync refused; a fresh `Database` resurrects the dropped table and lacks the new one, the new one heals on its next touch, and a re-apply from the resurrected `Database` drops it for real. `docs/transactions.md` "End-commit failure" says so too.
- **Session mode was untested inside a batch** (the handoff said so). Added a case that enables the `TransactionCoordinator` on the harness `Database`, applies two tables plus an index, and asserts one catalog commit, at most two catalog opens, hydration of 2 tables / 1 index in a fresh `Database`, and a session-mode insert visible from shared storage. Green.
- **Dead code**: `CatalogBatch.hasWrites()` had no caller; removed.

### Tripwires recorded (conditional; not tickets)

- `OptimysticModule.resolveConnectedTable` (new `NOTE:`): a first touch of a hydrated table mid-apply re-persists its record from outside the per-statement checkpoint, so that write would survive a later throw in the same statement. Fine today: no plugin DDL hook reaches connect mid-apply (no alter/rename hooks are implemented), and before the batch that write committed before the throw anyway. Wrap it if a mid-apply statement ever connects and can fail after initialize.
- Already recorded by the implementer and confirmed as the right shape: `CatalogBatch.recordForUri` re-derives the overlay per call (cache it if it ever profiles); `SchemaManager.catalogEntries` is not routed through the batch because hydrate never runs mid-apply; `SchemaManager.getSchema` can serve a pending record to a committed read outside the lock (the engine's catalog already exposes it); the cost spec's gate 4 ratio rose while its absolute count fell.

### Considered and left alone

- `CatalogBatch.checkpoint` copies the whole pending map per statement, so an apply of T tables copies on the order of T²/2 entries in memory. At any realistic schema size this is microseconds; the method's doc already states the cost per checkpoint. Not worth an undo log.
- `commit()` refreshes the tree twice (its own `update()` and the one inside `sync()`); the read cache absorbs the second, the unbatched `replace` has the same shape, and the cost spec's gets-per-object figure already includes it.
- `endSchemaBatch` throws when no batch is open. Agreed with the handoff: a wiring bug should be loud, and it is unreachable through Quereus.
- `optimystic-module.ts` is 4183 lines. Its split is already filed as `debt-optimystic-vtab-class-is-too-big-to-review` in `backlog/`; this ticket added about 180 lines of module code and is evidence for that ticket, not a new one.
- The handoff's other admitted gaps: an apply inside an explicit `begin … commit` is still untested here (the batch takes no part in the enclosing transaction, so nothing about it changes), and the pre-batch round-trip total for gate 6 was never measured (the before-column for gets and commits is enough to show the direction).

### Major findings

None. The design does what it claims, the atomicity reasoning is grounded in the Quereus test it cites, and every failure path the review could construct either leaves no catalog trace (checkpoint) or heals on the next touch (end-commit failure), with the one exception (lost gravestones) now logged and pinned.

### Pre-existing failure

One full-suite run failed `test/legacy-commit-atomicity.spec.ts` ("second-tree commit failure … index untouched") on a 20-second timeout over `FileRawStorage`, with its `afterEach` then hitting `ENOTEMPTY` on the temp directory. The same command passed minutes earlier at the same state of that spec, the spec passes alone in under a second, and it never runs `apply schema`. Recorded in `tickets/.pre-existing-error.md` for triage; not in `.pre-existing-known.md` beforehand.

## How to validate

```
yarn workspace @optimystic/quereus-plugin-optimystic build
cd packages/quereus-plugin-optimystic
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/schema-batch.spec.ts" "test/cold-apply-cost.spec.ts" --reporter spec --exit
yarn typecheck
yarn workspace @optimystic/quereus-plugin-optimystic test    # 786 passing, 13 pending, smoke ok (2026-09-10)
yarn lint:docs                                               # from the repo root
```

## What this does not buy (unchanged)

Index-tree flushes (`schema-batch-index-tree-flush-deferral`, in `implement/`), seed data (runs after `endSchemaBatch` as DML), one cross-collection atomic commit (`feat-cross-collection-atomic-commit`, backlog), and session-mode carriage of the catalog tree.
