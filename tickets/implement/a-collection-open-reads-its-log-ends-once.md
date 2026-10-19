description: Opening a stored collection reads its header block and its newest log block twice each, one after the other, and a table opens its index trees one at a time; read each once and open independent trees together, so attaching to a shared database waits on fewer network round trips in a row.
architecture: docs/internals.md#read-path-block-retrieval
files: packages/db-core/src/collection/collection.ts (`open`, `createOrOpen`, `probeHeader`, `attachToLog`, `readLogEnds`, `keepWhatTheRefreshRead`, `bootstrapContext`), packages/db-core/src/transform/cache-source.ts (`offerServed`, read only), packages/db-core/test/refresh-read-cost.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`initialize`, `setUniqueEnforcementIndexes`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`doInitialize`: the collection open, `getSchema`, the index-manager calls), docs/internals.md
----
# A collection open reads its log ends once

GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39), arm 2. Arm 1 (a cold read asks each member once rather than twice) is the separate implement ticket `a-cold-read-reuses-the-consults-archives`; the two are independent.

## What happens today

**Opening one collection costs four sequential requests, each of two blocks fetched twice.** Measured with the `CountingTransactor` in `packages/db-core/test/refresh-read-cost.spec.ts` on a tree with five committed rows, `Tree.createOrOpen` issued `[header] [tail] [header] [tail]`:

1. `Collection.probeHeader` reads the header through `TransactorSource.tryGet` — around the handle's `CacheSource`, so nothing is cached.
2. `Collection.attachToLog` reads the log tail block with `readLogTail` (around the cache, because `bootstrapContext` needs the raw entry's `state.latest`).
3. `Log.open` reads the header again, through the tracker, and misses.
4. The chain open reads the tail again, and misses.

Opening, refreshing and reading one row cost six requests. On a peer-to-peer node each request a machine cannot answer from its own storage is a cohort consult (and today an acquisition — arm 1), so these sequential reads are what a joiner attaching to a shared database waits on, one relay round trip after another.

**A table opens its trees one after another.** `OptimysticVirtualTable.doInitialize` opens the main collection, then reads the catalog record (`SchemaManager.getSchema`) — independent of the collection — then `IndexManager.initialize` opens each declared index tree in a `for … await` loop, then `setUniqueEnforcementIndexes` opens each unique-enforcement tree the same way.

## The change

### db-core: one read of each log end per open

`probeHeader` reads the log ends with `Collection.readLogEnds(transactor, id, undefined)` — the same function every refresh uses — instead of `source.tryGet(id)` and the separate tail read. That is two requests (the header, then the tail it names; the tail id is only known from the header, so on an open they cannot share one request the way a refresh's can). `attachToLog` takes the `LogEnds` and no longer reads the tail itself: `bootstrapContext(source, ends.tail)`, then the served header and tail go into the handle's own `sourceCache` before `Log.open`, which then reads both from the cache.

The keep uses the rule `keepWhatTheRefreshRead` already applies, factored into one helper both sites call (an open has no constructed `Collection` yet, so the helper takes the cache, the floors and the context rather than `this`): keep a served block only when the handle holds a context, the served revision is at or below it, and it meets any applicable floor (none exist at open). `readLogEnds` already applies `answeredBlock` to the header and `checkedLogTail` to the tail, so a flagged header or tail throws `BlockUnavailableError` / `BlockPossiblyStaleError` exactly as `TransactorSource.tryGet` and `readLogTail` did; check that `answeredBlock(id, entry, undefined)` is the whole of what an unpinned `TransactorSource.tryGet` decided for the header, and say so in the helper's comment.

`open` returns `undefined` when `readLogEnds` does (an authoritatively absent header); `createOrOpen` invents the collection in the same case, as today. `logTailId` is set from the header as today, so the first `update()` after an open stays one request.

Result: an open costs two requests and fetches no block twice; open + first refresh + one point read costs four instead of six.

### One guard the shared rule needs

The header is read in one request and the tail in the next. If a commit that fills the tail lands between the two, the header read names the old tail while the context adopted from the tail is at the roll-over's revision — and that roll-over rewrote the header. Keeping that header would serve, at the adopted revision, a header older than the revision says. The chain walk tolerates it (it follows `nextId` from whichever tail the header names), but a write that rolls the log over again would stage header edits over the stale copy and be refused by storage's base guard, costing a retry. So the helper keeps the header only when the tail block it read names no `nextId` — it is still the last block, so nothing rolled over after the header was read; otherwise it keeps the tail alone and `Log.open` reads the header pinned at the adopted revision. The refresh's two-request branch (`readLogEnds` with a stale `knownTailId`) has the same exposure and gets the same guard by sharing the helper.

### Plugin: open independent trees together

- `doInitialize`: run `collectionFactory.createOrGetCollection(this.options, …)` and `schemaManager.getSchema(…)` with `Promise.all`; neither reads the other's result. Everything after them (`guardStorageAdoption`, the schema branches) is unchanged.
- `IndexManager`: one private `openTrees(descriptors, transactor)` opens every descriptor whose tree is not yet open with `Promise.all`, then inserts the trees into `indexTrees` **in descriptor order** after all resolve, so `getIndexTrees()` order — which the bridge's collection registration follows — does not depend on which open finished first. `initialize(transactor, uniqueEnforcement)` takes the unique-enforcement descriptors, records them, and opens declared and enforcement trees in one `openTrees` call; `setUniqueEnforcementIndexes` (still called by the attach path in `optimystic-module.ts` that adds missing enforcement indexes) uses `openTrees` too. `doInitialize` computes `buildUniqueEnforcementIndexes(storedSchema)` before calling `initialize` and drops its separate `setUniqueEnforcementIndexes` call.

B-tree descent stays level by level — each level's block id comes from the one above it.

### Not in this ticket

The vtab refreshes every tree it reads (`collection.update()`) on each query, including right after the open that read the same two blocks; that refresh is one request and is what keeps reads live (`docs/internals.md` § Quereus vtab read path). Leave it. The catalog being opened several times per `create table` is backlog `feat-a-single-create-table-opens-the-catalog-four-times`.

## Edge cases & interactions

- **Absent header** (`readLogEnds` → `undefined`): `open` returns `undefined` with nothing staged; `createOrOpen` invents. Covered by existing `collection.spec.ts` / `tree.spec.ts` open tests.
- **Header naming no tail, or a tail with no `state.latest`**: no context is adopted, the helper keeps nothing, `Log.open` reads as today. By inspection.
- **Header or tail flagged unavailable / possibly stale**: throws from `readLogEnds` as it did from the probe and `readLogTail`. Existing specs for `open` throwing `BlockUnavailableError` (`packages/db-core/test/`, grep `BlockUnavailableError`) must stay green.
- **Roll-over between the header and tail reads**: the `nextId` guard above. By inspection; the guard's comment states why.
- **Read dependencies**: the probe used to record the header through the source's collector; now `Log.open`'s cache hit records it (the handle's `CacheSource` carries the collector, and `offerServed` records the revision a hit reports). Confirm by inspection that a transaction's read set still names the header at the same revision.
- **`attachToLog`'s `site=attach` lineage check** still compares the tail's claim with the walk's context; the walk now reads cached blocks from the same two reads. By inspection.
- **Plugin, concurrent opens failing part-way**: `Promise.all` rejects with the first error; the other opens finish unawaited and can only fill `CollectionFactory`'s per-URI cache, which is harmless. `doInitialize` already publishes `collection`, `rowCodec` and `indexManager` only after its last `await`, so a failed pass leaves no half-opened manager (`docs/internals.md` § A failed first open is retried, not remembered). By inspection.
- **Plugin, concurrent opens of one URI**: the table, catalog and index URIs are distinct, so no two concurrent opens race on `CollectionFactory`'s cache entry for one URI. By inspection.
- **Provisional (committed-read) pass** runs the same opens: unchanged otherwise.

## Test

One budget, beside the existing ones in `packages/db-core/test/refresh-read-cost.spec.ts`:

- `it('opening an existing tree costs two requests and fetches no block twice')`: write five rows through one handle, then `net.cost(() => Tree.createOrOpen(net, id, keyOf))` — `requests` at most **2**, `expectNoBlockFetchedTwice`. Today: 4, header and tail each fetched twice.

No test for the plugin's `Promise.all` (wiring); the existing plugin suite covers initialization behaviour.

## TODO

- Factor `keepWhatTheRefreshRead`'s rule into a helper callable before construction; add the `nextId` guard on the header; use it from both the refresh and the open.
- Rework `probeHeader` / `attachToLog` to read through `readLogEnds` and seed the handle's cache.
- Add the budget test; run `yarn test` in `packages/db-core`.
- Plugin: `Promise.all` the collection open and `getSchema` in `doInitialize`; `IndexManager.openTrees`, `initialize(transactor, uniqueEnforcement)`, `setUniqueEnforcementIndexes` via `openTrees`; drop the separate call. Rebuild db-core first (the build-freshness guard refuses a stale build), then run `yarn test` in `packages/quereus-plugin-optimystic`.
- `docs/internals.md` § Read Path: one sentence that an open reads the header and tail once each (two requests) and seeds the handle's cache with them.
