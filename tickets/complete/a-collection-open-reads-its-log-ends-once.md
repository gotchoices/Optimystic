description: Opening a stored collection now reads its header block and its newest log block once each instead of twice, and a table opens its catalog record and its index trees together rather than one after another, so attaching to a shared database waits on fewer network round trips in a row.
architecture: docs/internals.md#read-path-block-retrieval
files: packages/db-core/src/collection/collection.ts (`probeHeader`, `attachToLog`, `keepLogEnds`, `headerCurrentThroughTail`, `entryChanges`, `forgetAndAdopt`, `readLogEnds`), packages/db-core/test/refresh-read-cost.spec.ts, packages/db-core/test/tree.spec.ts, packages/db-core/test/collection.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts (`doInitialize`), packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`initialize`, `setUniqueEnforcementIndexes`, `openTrees`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`getOrCreateTransactor`, `transactorsInFlight`), packages/quereus-plugin-optimystic/test/local-transactor-storage.spec.ts, docs/internals.md, docs/debugging.md, packages/db-core/docs/collections.md
----
# A collection open reads its log ends once

GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39), arm 2. Landed across the runner's resume-note commit (`tess: agent error on a-collection-open-reads-its-log-ends-once — added resume note`) and `ticket(implement): a-collection-open-reads-its-log-ends-once`.

## What landed

- **db-core.** `Collection.probeHeader` reads the header and the log tail through `Collection.readLogEnds` (two requests; the tail id is known only from the header). `attachToLog` bootstraps the context from that tail and keeps both blocks in the new handle's cache before `Log.open`, through one static keep rule, `Collection.keepLogEnds`, shared with the refresh's `forgetAndAdopt`. The header is kept only when `Collection.headerCurrentThroughTail` holds: the tail read has no `nextId` (no roll-over since) and none of its entries above the header's served revision changed the header (`Collection.entryChanges` — an action naming it, or an invalidation reverting it). That second arm covers a tree whose root moved between the two reads, which rewrites the header without rolling the log over. A refused header is re-read pinned at the adopted revision.
- **Plugin.** `doInitialize` opens the table's collection and reads its catalog record with `Promise.all`; `IndexManager.initialize` opens declared and unique-enforcement trees concurrently (`openTrees`), registering them in descriptor order only after all resolve. `CollectionFactory.getOrCreateTransactor` shares one in-flight construction per transactor key (`transactorsInFlight`), closing the race the concurrent opens would otherwise hit: two transactors — two libp2p nodes, or two `local` stores — for one table's first touch.
- **Budget.** Opening an existing tree costs at most two requests with no block fetched twice (was four).

## Review findings

**Diff read first, both commits.** Checked against the handoff afterwards; the handoff matches the code.

**Correctness — header keep guard (the main judgement call).** Reasoned through the interleavings: roll-over between the reads (caught by `nextId`); root split between the reads (caught by the entry arm); tail served by a machine behind the header's machine (header revision above the adopted context, refused by the existing revision test); header served by a lagging machine with a header-changing entry in the tail above it (refused); a consistent lagging snapshot (kept, and sound, since no entry between the header's and the tail's revisions changed the header). In the ordinary case a header's served revision is its own last change, so no later entry in the tail can name it and the keep succeeds — the guard costs a read only in the genuine race or lag, so no budget in `refresh-read-cost.spec.ts` is at risk from it in normal use. Verified both arms are pinned: disabling the entry arm fails the tree spec ("row 3: expected undefined"), disabling the `nextId` arm fails the reworked collection spec (the open fulfils instead of throwing). Source restored afterwards.

**Correctness — probe equivalence.** Read `TransactorSource.tryGet`: for an opening handle (no context, no floors) it decides nothing beyond `answeredBlock(id, entry, undefined)` plus recording the read dependency at `servedRevision`. `readLogEnds` makes the same `answeredBlock` call, and the walk's cache hit records the dependency at the same revision (`CacheSource.offerServed` keeps the revision with a clone). Nothing lost.

**Correctness — `blockIds` completeness.** The entry arm relies on every header-changing commit listing the header in its entry's `blockIds`. Not re-verified beyond the implementer's reading of `Collection.sync` and the coordinator path; the tree spec exercises the `sync` path end to end.

**Plugin concurrency.** Checked that the catalog tree (`tree://optimystic/schema`) and the table resolve the same transactor key (`transactor:keyNetwork`), which is why the shared construction matters, and that the concurrent opens in `doInitialize` and `openTrees` are for distinct URIs, so `createOrGetCollection`'s own check-then-create is never raced on one key by this change. Unique-enforcement descriptor names are deduplicated by column set in `buildUniqueEnforcementIndexes`; a user index explicitly named in the synthesized `_uniq_…` form would now be opened twice with the second handle kept — contrived, and both handles are fresh opens of one collection, so harmless; no change. A failed `Promise.all` leaves the indexes unregistered on a manager that is never published. `IndexManager.initialize`'s only caller is `doInitialize`.

**Found and fixed (minor).**
- `docs/internals.md`, tail-floor section ("The header carries none"), still said the header is rewritten only on a roll-over; corrected to include the collection changing it itself (a tree's root moving), matching the code comment the implementer had fixed.

**Tripwire parked.**
- `dispose()` / `clearCache()` do not touch `transactorsInFlight`, so a construction in flight across a dispose still lands in `transactors` afterwards — the same shape as the old await-then-set, so not a regression. `NOTE:` at `transactorsInFlight` in `collection-factory.ts`.

**Tests.** Kept all four new or reworked tests: the open budget, the root-split-in-the-gap reproduction, the reworked vanishing-header test (which now also pins the `nextId` arm), and the concurrent-first-caller transactor test (pins a defect; the implementer confirmed it fails without the fix). None restate the implementation or verify a mock. Added none. No test for the plugin's `Promise.all` wiring, deliberately — it is wiring.

**Source hygiene.** `collection.ts` is 2412 lines (`wc -l`); its size is already tracked by backlog `debt-collection-write-retry-logic-outgrew-its-file`, so nothing filed. The comments the change added explain why (the guard's race, the probe equivalence), not what.

**Docs.** Read `docs/internals.md` (read path and the tail-floor section), `docs/debugging.md` (collection-id paragraph) and `packages/db-core/docs/collections.md`; all reflect the change after the one fix above. The "open + first refresh + one point read costs four" figure in internals is derived, not asserted, as the handoff says.

**Validation.**
- db-core `yarn test`: 1904 passing.
- quereus-plugin-optimystic `yarn test` (after rebuilding db-core and the plugin): 1054 passing, 14 pending, smoke ok; `yarn typecheck` clean.
- `yarn lint:docs` clean; eslint clean on the four changed source files.
- Not run: the db-p2p suite (this ticket changes nothing under db-p2p; the implementer ran it and reported one unrelated failure, already triaged) and `yarn test:integration`.

**Filed.** Nothing — no finding cleared the filing bar.
