description: Opening a stored collection now reads its header block and its newest log block once each instead of twice, and a table opens its catalog record and its index trees together rather than one after another, so attaching to a shared database waits on fewer network round trips in a row.
architecture: docs/internals.md#read-path-block-retrieval
files: packages/db-core/src/collection/collection.ts (`probeHeader`, `attachToLog`, `keepLogEnds`, `headerCurrentThroughTail`, `entryChanges`, `forgetAndAdopt`, `readLogEnds`), packages/db-core/test/refresh-read-cost.spec.ts, packages/db-core/test/tree.spec.ts, packages/db-core/test/collection.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts (`doInitialize`), packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`initialize`, `setUniqueEnforcementIndexes`, `openTrees`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`getOrCreateTransactor`, `transactorsInFlight`), packages/quereus-plugin-optimystic/test/local-transactor-storage.spec.ts, docs/internals.md, docs/debugging.md, packages/db-core/docs/collections.md
----
# A collection open reads its log ends once — review handoff

GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39), arm 2. The work spans two commits: the runner's resume-note commit `cb7c746a` (an interrupted first run's `collection.ts` and budget-test changes) and the commit that lands this handoff. Review both.

## What changed

### db-core: an open reads the header and the log tail once each

- `Collection.probeHeader` reads through `Collection.readLogEnds(transactor, id, undefined)` — the reader every refresh uses — instead of `source.tryGet(id)` plus a separate tail read. Two requests (the tail id is known only from the header). `open` returns `undefined` / `createOrOpen` invents when it returns `undefined`, as before.
- `Collection.attachToLog` takes the `LogEnds`, bootstraps the context from `ends.tail`, then keeps the header and tail in the new handle's `sourceCache` before `Log.open`, so the walk reads both from the cache.
- The keep rule is one static helper, `Collection.keepLogEnds(cache, floors, context, ends)`, called from the open and from the refresh (`forgetAndAdopt`, where it replaced `keepWhatTheRefreshRead`). It keeps a served block only when the handle holds a context, the served revision is at or below it, and it meets any applicable floor.
- **The header guard is wider than the ticket asked for.** The ticket's guard kept the header only when the tail read names no `nextId` (no roll-over between the two reads). That is not enough: a tree's header names its B-tree root, so a commit that splits the root rewrites the header without rolling the log over. `Collection.headerCurrentThroughTail` therefore also refuses the header when any entry in the tail block above the header's served revision changed the header (`Collection.entryChanges`: an action naming it in `blockIds`, or an invalidation reverting it). A refused header is re-read by `Log.open`, pinned at the adopted revision. The guard applies on the refresh path too (both its one-request and two-request branches), since a batched read can also be answered by two machines.
- The `probeHeader` comment records that `answeredBlock(id, entry, undefined)` is the whole of what an unpinned `TransactorSource.tryGet` decided for the header (an opening handle has no floors), and that the header's read dependency is now recorded by the walk's cache hit, at the same served revision (`CacheSource` records the kept revision on a hit).
- Two comments corrected that said the header changes only on a roll-over (`readLogEnds`' `tailFloor` paragraph, and the refresh's per-walk cache seed).

### Plugin: independent opens run together

- `doInitialize` runs `collectionFactory.createOrGetCollection` and `schemaManager.getSchema` with `Promise.all`. Everything after is unchanged; the publish of `collection` / `rowCodec` / `indexManager` is still one synchronous step after the last `await`.
- `IndexManager.initialize(transactor, uniqueEnforcement)` records the unique-enforcement descriptors and opens declared and enforcement trees in one private `openTrees` call: `Promise.all` over the descriptors with no tree yet, then registered in descriptor order after all resolve, so `getIndexTrees()` order does not depend on which open finished first. If one open fails, none is registered. `setUniqueEnforcementIndexes` (still used by `reassignUniqueEnforcement`, the DROP INDEX path) uses `openTrees` too. `doInitialize` builds the enforcement descriptors before `initialize` and no longer calls `setUniqueEnforcementIndexes`.
- **Not in the ticket: `CollectionFactory.getOrCreateTransactor` now shares an in-flight construction per transactor key** (`transactorsInFlight`). The catalog read and the table open resolve the same transactor key, and the old check-then-create had an `await` between the check and the set, so running them together on a table's first touch could build two transactors — two libp2p nodes for `network`, or two separate `local` stores, neither seeing the other's writes. A construction that fails is not remembered. No existing plugin test caught the race (checked by disabling the memo: a six-file subset stayed green).

## Tests

- `refresh-read-cost.spec.ts` › "opening an existing tree costs two requests and fetches no block twice" — the ticket's budget: at most 2 requests, no block fetched twice (was 4, header and tail each twice).
- `tree.spec.ts` › "should read every row when a commit that moves the root lands between the open's two reads" — reproduces the root-move arm of the header guard: a writer's commit that splits the root runs between the open's header read and its tail read (`HeaderReadGapTransactor`), and the opened tree must read all nine rows. Confirmed to fail (row 3 missing) with that arm disabled.
- `collection.spec.ts` › "should throw, not read empty, when a probed header's log will not open" — **reworked**, because its premise (an open reads the header twice) no longer holds once the header is kept. It now fills one log block, rolls the log over between the open's two reads so the open declines its header copy, and hides the header from the re-read; the open must throw `Log not found`. This also pins the `nextId` arm of the guard (with only the entry arm, the header would be kept and the open would succeed).
- `local-transactor-storage.spec.ts` › "builds one transactor, over one store, for concurrent first callers" — two concurrent `getOrCreateTransactor` calls on a fresh factory return one transactor and call `rawStorageFactory` once. Confirmed to fail without the shared construction.

No test for the plugin's `Promise.all` wiring itself; the plugin suite covers initialization behaviour.

## Validation run

- db-core: `yarn test` — 1904 passing. `tsc --noEmit` clean.
- quereus-plugin-optimystic (after rebuilding db-core, db-p2p and the plugin): `yarn test` — 1053 passing, 14 pending, smoke ok. `yarn typecheck` clean.
- db-p2p full suite (run because it opens collections over real meshes): 3484 passing, 73 pending, 1 failing — `commit-round-carries-coordinator-commit-vote.spec.ts` › "the other member's refusal of the carried pend answers the commit as a retryable conflict". That spec never opens a collection and this ticket changes nothing under db-p2p; it passes 6/6 run alone, three times. Reported in `tickets/.pre-existing-error.md` for triage.
- `yarn lint:docs` clean; eslint clean on every changed file.
- Integration suites (`yarn test:integration`) not run.

## For the reviewer

- The wider header guard is the main judgement call. It is cautious by design: a tail entry above the adopted revision, or a header served by a machine behind the log, also refuses the keep, costing one pinned header read and never keeping a wrong header. Check whether any budget in `refresh-read-cost.spec.ts` could be hit by that in normal use; all current budgets pass.
- `headerCurrentThroughTail` relies on every commit that changes the header listing it in its entry's `blockIds`. Checked by reading: `Collection.sync` passes `tracker.transformedBlockIds()`, and the coordinator path passes `blockIdsForTransforms(collection.tracker.transforms)` — a live reference evaluated after the log append — so both include a header changed by the action or by the append.
- The "open + first refresh + one point read costs four" figure in `docs/internals.md` is derived (open 2, idle refresh 1, point read 1), not asserted by a test.
- The concurrent-open edge cases in the ticket (a failed `Promise.all` leaving unawaited opens that can only fill per-transaction caches; distinct URIs so no two opens race on one cache entry) were checked by reading the code, not by test.
