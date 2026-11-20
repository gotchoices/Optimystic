description: A machine that reads a table over the network without storing any of it could be woken for another machine's write before that write's indexes were readable, and was never woken again. Each of the table's companion collections now gets its own network watch, so one of them wakes the table once the whole write can be read.
architecture: docs/internals.md#change-notification-reactive-wake
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, docs/internals.md, docs/reactivity.md, packages/db-p2p/src/storage/storage-repo.ts, packages/quereus-plugin-optimystic/README.md
----

# A network watch wake sees the whole commit

Follow-up to GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47); second half of `a-watch-wakes-after-every-collection-of-a-commit-applies`.

A SQL table in this plugin is several Optimystic collections — its rows, each declared index, each index the plugin synthesizes to enforce a `UNIQUE` constraint, and a blob reference tree when the table has `blobref` columns. One SQL transaction writes them all, but each lands as its own storage commit, announced by the machines that store *that* collection's log tail. The vtab opened exactly one network watch, on the table's own collection, so a machine that stores none of the table (a client node) could be woken by the table's announcement before the index's commit had applied anywhere, read the index, find nothing, and never be woken again — the watch service's tick compared only the table's tail, which the write had already moved.

The vtab now opens **one network watch per collection of the table**. Every watch calls the same `handleCollectionChange()`, so a wake on any collection is the same coarse whole-table invalidation the table's own wake already was. The index's own landing therefore wakes the table a second time, within the time the index's commit takes rather than within a tick; and because each collection is now a watched subscription in its own right, `ReactivityCollectionWatch`'s tick reads and compares its tail, so a lost or never-made announcement still wakes the watcher within one tick (30 s Core, 20 s Edge). Nothing in `@optimystic/db-p2p` changed except comments.

## What landed

Shipped by `ticket(implement): feat-a-network-watch-wake-sees-the-whole-commit`; all in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` unless noted.

- `closeNetworkWatch?: () => Promise<void>` → `networkWatchCloses: Map<CollectionId, () => Promise<void>>`.
- New `wantedNetworkWatches()`: `getCollectionId(this.options)` unioned with `txnBridge.collectionsOf(this.qualifiedTable)`. The table's own id is explicit so the change can never *lose* the watch the table had before, whatever the registry holds. The rest comes from the bridge registry rather than from `indexManager.getIndexTrees()` + `blobReferences`, because `registerTree` / `txnBridge.forgetTree` are already the single funnel every path goes through — so the watched set cannot drift from the collections the table maintains, and a future kind of child collection is watched without anyone adding it here.
- `applyNetworkWatch()` is a diff: open every wanted collection not already open, close every open collection no longer wanted. When the table is not armed or not tagged the wanted set is empty, so **every** entry closes — which is what `teardownChangeSubscription` and a tag flipped off rely on.
- `openNetworkWatch(collectionId)` opens and catches **per collection**, so one failure cannot cost the others, and leaves a failed collection out of the map so the next reconcile retries it. The once-per-table "tagged but no watch service" warning stays once per table.
- `reconcileNetworkWatch()` keeps the existing serialization (`networkWatchSteps`) and coalesces via `networkWatchStepQueued`, so the burst of `registerTree` calls one initialization makes costs one or two reconciles rather than one per index.
- Reconcile is driven from the registration funnel: end of `registerTree`, after the `forgetTree` calls in `removeIndex` and `forgetUnmaintainedTrees`, and from `ensureChangeSubscription` **outside** its `changeSubscribed` early return — so a second `doInitialize` (the upgrade after a provisional pass, a retry after a failure, `adoptCatalogEntry` taking another machine's description) no longer returns at that guard with a newly opened index unwatched.
- New trace `watch:network-set table=%s opened=%o closed=%o`, emitted only by a reconcile that changed something.
- `collection-factory.ts`: `watchCollectionOverNetwork`'s doc now says the collection id is independent of `options.collectionUri` and that one table passes several.
- Docs: `docs/internals.md` §Change Notification (Reactive Wake) — the local-subscription bullet's "index sub-collections are not separately watched" claim is scoped to the local feed, and the network bullet is rewritten from the gap to the shipped shape (the two wake arms, the tick backstop, the index-first wake, the extra invalidations). The origination-hold parenthesis now records holding-for-origination as weighed and rejected, matching the `NOTE:` at `armHoldTimer` and `emitCollectionChanges` in `packages/db-p2p/src/storage/storage-repo.ts` (comments only, no behaviour). `docs/reactivity.md` gains the per-collection fan-out paragraph in *What a tick costs* and corrects *Only for a root someone subscribed to*. `packages/quereus-plugin-optimystic/README.md` §Network change notification gains a "What it opens" paragraph and a per-collection cost paragraph.

### Tripwire recorded, not ticketed

At `wantedNetworkWatches()`: a tagged table now holds one cohort registration and one watched tail per collection instead of one per table, so on a machine that stores none of them the per-tick request fan-out grows with the table's collection count. **Unmeasured and structural** — the tail reads still batch into one `readTails` per transactor; what grows is the request fan-out behind that call, because each collection's tail hashes to its own ring position. If it ever shows up, add a tag value that watches only the table's own collection, accepting the index gap back; backlog `feat-a-renewal-reply-carries-the-tail-revision` is the other mitigation path.

## Review findings

Read the `ticket(implement): feat-a-network-watch-wake-sees-the-whole-commit` diff before the handoff summary.

### Fixed in this pass

- **The reconcile step chain could be poisoned by a throw.** `reconcileNetworkWatch` chained `.then` with no `.catch`, where the pre-change `applyNetworkWatch` had one try/catch around its whole body. In the new shape the wanted-set read and the trace sit outside any try, so a throw there would leave `networkWatchSteps` rejected — every later `.then` would skip its step, so the table would never reconcile its watches again — and would surface as an unhandled rejection, since nothing awaits that chain. Fixed by catching and logging at the end of the chain. No reachable trigger today (`parseCollectionId` throws only on an empty URI, which options parsing has already rejected, and `collectionsOf` cannot throw), so this restores a property the old code had rather than fixing an observed failure.
- **`docs/internals.md` *Lifetime* still described one watch with one span.** "Opened by full initialization, closed by DROP TABLE" is still true of the span, but within it the *set* now follows the table's collections. Added that `create index` opens one more and `drop index` closes it.
- **`docs/reactivity.md` *Copied to the rest of the root group when it changes* understated its own cost.** The bullet above it was edited to say a *tagged* table's index collections now have direct subscribers; the consequence two bullets down — "an idle watched table costs each member one frame every 30 s" — was not. It is now per collection of a tagged table, each at its own root group.
- **`packages/quereus-plugin-optimystic/README.md`:** the tag paragraph still said `alter table … set tags` "starts or stops the network watch" (singular), two paragraphs above the new plural wording.

### Checked, no defect

- **The spec the implement pass never ran, runs and passes.** `OPTIMYSTIC_INTEGRATION=1 … test/network-change-notification.integration.spec.ts` — 3/3 runs, ~46 s each. That settles all three of the handoff's unverified guesses: the index's collection id is spelled `network-watch/Watched/index/watched_by_v` as the spec assumed, `watchedCount === 2` holds, and the "no tail read between the commit and the wake" loop is not disturbed by the second subscription (it passed on the first attempt in each run).
- **The coalescing flag is airtight in the direction that matters** — the handoff asked. `networkWatchStepQueued` is cleared at the start of the queued callback, *before* `applyNetworkWatch` reads the wanted set, so a request landing during a running step queues one extra, harmless reconcile rather than being dropped.
- **Every mutation of the collection set reaches a reconcile.** `registerTree` is the only `txnBridge.registerCollection` call in the module, and all three `forgetTree` call sites (`forgetUnmaintainedTrees` twice, `removeIndex`) reconcile. The five registration paths the handoff listed do funnel through `registerTree`: `registerCollections`, `reconcileMaintainedIndexes` (which is what `addIndex` registers through), `reassignUniqueEnforcement`, `attachBlobReferences`.
- **Arming before the subscribe-once guard changes only the case it was moved for.** No state exists with `changeSubscribed` true and `networkWatchArmed` false — `teardownChangeSubscription` clears both. The comment's ordering claim holds: `registerCollections` → `forgetUnmaintainedTrees` → … → `ensureChangeSubscription` is the last step of `doInitialize`, and the provisional pass returns before any of it, so a provisional table registers nothing and arms nothing.
- **`watchedCount === 2` is the right number, not a lucky one.** `buildUniqueEnforcementIndexes` skips a constraint whose column set is the primary key's, and the spec's index is not unique, so the table has exactly two collections; `watchedCount` is `subscriptions.size`, keyed by collection id with listener refcounting.
- **The serial `await` in the open loop costs nothing.** `ReactivityCollectionWatch.watch()` returns synchronously and the only await in `watchCollectionOverNetwork`, `getOrCreateTransactor`, is cached after the first collection — so N collections are not N round trips.
- **The index-first-wake consequence the docs now assert is real:** the `row === undefined || !rowImpliesEntry(row, entry, indexKeyOf)` arm is at `packages/quereus-plugin-optimystic/src/optimystic-module.ts:2843`.
- **Comments say what the code cannot.** The new jsdoc is dense but each paragraph carries a why or a constraint (why the table's own id is explicit, why the registry and not the index manager, why the queued flag is cleared where it is, why the warning must not multiply by the index count). No run of narrated statements to extract into a subroutine.

### Deliberately not filed

- **No ticket filed.** The one defect found was fixable in this pass and the rest were docs; nothing reached the filing bar (no unserved current-release anchor, no class-level invariant).
- **No new tripwire.** The implement pass's two `NOTE:`s — the per-tick fan-out at `wantedNetworkWatches` and "nothing retries a failed collection until the next reconcile" at `openNetworkWatch` — are the right shape and the right sites; they stay as written.
- **No test added or cut.** The three assertions added to the integration spec go through the watch service's real diagnostic seams (`isAttached`, `watchedCount`) rather than a mock, and pin the contract this ticket exists for, so they earn their place. Nothing was added: the reconcile itself is set arithmetic over a registration funnel, and the defect found above is unreachable from any public path, so a test for it would have to inject a throw into a private method — the wrong layer.
- **File size: already claimed.** `optimystic-module.ts` is 7801 lines (`wc -l`), claimed by `backlog/debt-optimystic-vtab-class-is-too-big-to-review`. This change added 21 net lines and no new split boundary, so no arm was added.
- **The db-close leak arm is already recorded.** `backlog/enhancements/optimystic-vtab-watch-db-close-teardown` carries the implement pass's addendum for the multiplied leak (one watch per collection, not one per table). Verified; nothing to add.
- **Unchanged by design, as the implement handoff said:** nothing retries a collection whose open failed until the collection set or the tag next changes; `CollectionFactory.dispose()` still closes watches behind the vtab's back (the generalized `NOTE:` records it); and the close path deletes a collection from the map before awaiting its close, as the single watch always did.

### Validation

| Command | Result |
| --- | --- |
| `yarn workspace @optimystic/quereus-plugin-optimystic build`, `yarn workspace @optimystic/db-p2p build` | clean |
| `yarn typecheck`, `yarn lint`, `yarn lint:docs` | clean (49 documents, 850 anchored citations, 911 file mentions, 821 links all resolve) |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` | 1429 passing, 14 pending, 0 failing |
| `yarn workspace @optimystic/db-p2p test` | 3852 passing, 84 pending, 0 failing |
| `yarn workspace @optimystic/quereus-plugin-optimystic test:integration` | 1435 passing, 8 pending, 0 failing |
| `yarn workspace @optimystic/db-p2p test:integration` | 60 passing, 2 pending, 0 failing |
| the ticket's own spec, three times | 1 passing each, ~46 s |

No pre-existing failure surfaced, so `tickets/.pre-existing-error.md` was not written. `yarn check:rn` was not run (no import added or changed); `yarn lint:deps` was not run (no manifest changed).

## How to exercise it by hand

Any `network`-transactor table tagged `"optimystic.network_watch" = true` with at least one secondary index. With the `module` log namespace on, `watch:network-set table=… opened=[…] closed=[…]` prints once per reconcile that changed something — it names the table's collection and each index collection at initialization, one more line on `create index`, and the index's id under `closed=` on `drop index`. `drop table` closes every id. On a node with no cohort-topic watch service the single "tagged … has no cohort-topic watch service" warning appears exactly once, not once per index.
