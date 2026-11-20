description: A machine that reads a table over the network without storing any of it could be woken for another machine's write before that write's indexes were readable, and was never woken again. Each of the table's companion collections now gets its own network watch, so one of them wakes the table once the whole write can be read.
architecture: docs/internals.md#change-notification-reactive-wake
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, docs/internals.md, docs/reactivity.md, packages/db-p2p/src/storage/storage-repo.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----
# A network watch wake sees the whole commit — review handoff

Follow-up to GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47); second half of `a-watch-wakes-after-every-collection-of-a-commit-applies` (landed). The implement ticket is in git history at `tickets/implement/feat-a-network-watch-wake-sees-the-whole-commit.md`.

## What changed

A SQL table in this plugin is several Optimystic collections (its rows, each declared index, each synthesized unique-enforcement index, and a blob reference tree when the table has `blobref` columns). One SQL transaction writes them all, but each lands as its own storage commit, announced by the machines that store *that* collection's log tail. The vtab opened exactly one network watch, on the table's own collection, so a machine that stores none of the table (a client node) could be woken by the table's announcement before the index's commit had applied anywhere, read the index, find nothing, and never be woken again — the watch service's tick compared only the table's tail, which the write had already moved.

The vtab now opens **one network watch per collection of the table**. Every watch calls the same `handleCollectionChange()`, so a wake on any collection is the same coarse whole-table invalidation the table's own wake already was. The index's own landing therefore wakes the table a second time (prompt — within the time the index's commit takes), and because each collection is now a watched subscription in its own right, `ReactivityCollectionWatch`'s tick reads and compares its tail, so a lost or never-made announcement still wakes the watcher within one tick (30 s Core, 20 s Edge). Nothing in `@optimystic/db-p2p` changed except a comment.

### Code

All in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` unless noted.

- `closeNetworkWatch?: () => Promise<void>` → `networkWatchCloses: Map<CollectionId, () => Promise<void>>`, keeping the `CollectionFactory.dispose` `NOTE:` generalized to the map.
- New `wantedNetworkWatches()`: `getCollectionId(this.options)` unioned with `txnBridge.collectionsOf(this.qualifiedTable)`. The table's own id is in there explicitly so the change can never *lose* the watch the table had before, whatever the registry holds. The rest comes from the bridge registry rather than from `indexManager.getIndexTrees()` + `blobReferences`, because `registerTree` / `txnBridge.forgetTree` are already the single funnel every path goes through. Carries the rationale, the "a unique-enforcement tree and the blob reference tree are never read by a re-query, and are watched anyway" note, and the cost tripwire (below).
- `applyNetworkWatch()` is now a diff: open every wanted collection not already open, close every open collection no longer wanted. When the table is not armed or not tagged the wanted set is empty, so **every** entry closes — which is what `teardownChangeSubscription` and a tag flipped off rely on, and why it iterates the map rather than special-casing the table's handle.
- `openNetworkWatch(collectionId)` opens and catches **per collection**, so one failure cannot cost the others, and leaves a failed collection out of the map so the next reconcile retries it. The once-per-table "tagged but no watch service" warning stays once per table (on such a node every collection resolves `undefined`; the warning must not be multiplied by the index count). Open/close failure logs name the collection.
- `reconcileNetworkWatch()` keeps the existing serialization (`networkWatchSteps`) and adds coalescing via `networkWatchStepQueued`: a step queued and not yet started absorbs further requests. Sound because a step reads the wanted set when it *runs*, not when it was queued — so the burst of `registerTree` calls one initialization makes costs one or two reconciles, not one per index.
- Reconcile is now driven from the registration funnel: end of `registerTree`, after the `forgetTree` calls in `removeIndex` and `forgetUnmaintainedTrees`, and from `ensureChangeSubscription` **outside** its `changeSubscribed` early return (the schema-tree skip moved above the arm, so it still returns first). That last one matters: a second `doInitialize` — the upgrade after a provisional pass, a retry after a failure, `adoptCatalogEntry` taking another machine's description — used to return at that guard and reconcile nothing, so an index the re-initialization opened would have gone unwatched.
- New trace `watch:network-set table=%s opened=%o closed=%o`, emitted only by a reconcile that actually changed something.
- `collection-factory.ts`: `watchCollectionOverNetwork`'s doc now says the collection id is independent of `options.collectionUri` and that one table passes several.

### Tripwire recorded (not a ticket)

At `wantedNetworkWatches()`: a tagged table now holds one cohort registration and one watched tail per collection instead of one per table, so on a machine that stores none of them the per-tick request fan-out grows with the table's collection count. **Unmeasured and structural** — the tail reads still batch into one `readTails` per transactor (one shared `CollectionTailReader`); what grows is the request fan-out behind that call, because each collection's tail hashes to its own ring position. If it ever shows up, add a tag value that watches only the table's own collection, accepting the index gap back; backlog `feat-a-renewal-reply-carries-the-tail-revision` is the other mitigation path.

### Docs

- `docs/internals.md` §Change Notification (Reactive Wake): the *Subscription identity* bullet now scopes its "index sub-collections are not separately watched" claim to the **local** feed; the network bullet is rewritten from "has the same shape, and is not held" (which described the gap and pointed at this ticket as backlog) to the shipped shape, with the two wake arms, the tick backstop, and the index-first-wake and extra-invalidation consequences. The hold bullet's parenthesis that deferred origination holding to this ticket now records it as weighed and rejected (it only helps where the announcing machine also stores the other collections), and the `armHoldTimer` tripwire mention now says the remedy shipped for tagged tables and remains open for untagged ones.
- `packages/db-p2p/src/storage/storage-repo.ts`: the matching `NOTE:` at `armHoldTimer` and the origination parenthesis in `emitCollectionChanges` — comments only, no behaviour.
- `docs/reactivity.md`: *What a tick costs* gains the per-collection fan-out paragraph (explicitly flagged as implied by the design, not measured); *Only for a root someone subscribed to* no longer lists "an index tree" as a collection nobody watches (a tagged table's index trees are watched now — it names the untagged table's index trees instead); the "two wakes per remote commit" count in *This node's own storage* now says a tagged table multiplies the per-collection wakes by the number of collections the commit wrote; and the integration-test note records the new assertions.
- `packages/quereus-plugin-optimystic/README.md` §Network change notification: a "What it opens" paragraph (one watch per collection, and why), and the cost paragraph rewritten per collection.

## Tests

**No new unit test, deliberately.** The reconcile is registration glue over set arithmetic, and the layer that reproduces the bug needs a watcher that stores none of the table talking to a real cohort-topic substrate: the plugin's mock mesh (`test/mesh-node-harness.ts`) has no cohort-topic or `reactivityWatch` support, and `db-p2p`'s `cohort-topic-mesh-harness.ts` is not wired into it. A mocked watch service would pin the stub, not the behaviour.

**One spec extended** — `packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts`, the only one with a real watch service. Its tagged `Watched` table now carries a secondary index (`watched_by_v`), and the case asserts, through the service's existing diagnostic seams, that the watched set follows the table's collections:

| Assertion | What it verifies |
| --- | --- |
| `isAttached('network-watch/Watched')` **and** `isAttached('network-watch/Watched/index/watched_by_v')` | both of the table's collections registered with their own topic cohorts |
| `watchedCount === 2` | a tagged table watches each collection it registers, and the untagged sibling watches none |
| after `drop index`: `watchedCount === 1`, index no longer attached, table still attached | the set shrinks with the table's collections, and the drop does not take the table's own watch with it |

### Commands run (per `tickets/rules/testing.md`)

```
yarn build                 # in packages/quereus-plugin-optimystic and packages/db-p2p — both clean
yarn typecheck             # from the root — clean
yarn lint                  # from the root — clean
yarn lint:docs             # 49 documents, 850 anchored citations, 911 file mentions, 821 links — all resolve
node --import ./register.mjs node_modules/mocha/bin/mocha.js test/reactive-watch.spec.ts          # 7 passing
node --import ./register.mjs node_modules/mocha/bin/mocha.js test/index-support.spec.ts test/two-node-index-wake-consistency.spec.ts   # 27 passing
```

`yarn lint:deps` was not run: no manifest changed and no import was added (`CollectionId` was already imported).

## Known gaps — please check these

- **The extended spec was NOT run.** It is gated on `OPTIMYSTIC_INTEGRATION=1` and runs three real libp2p nodes over sockets; the implement pass did not execute it, so the new assertions are unverified. Reviewing it needs `yarn workspace @optimystic/quereus-plugin-optimystic test:integration`.
- **Two guesses inside that spec worth a second pair of eyes.** (1) The index's collection id is spelled `network-watch/Watched/index/watched_by_v` on the assumption that Quereus hands `create index watched_by_v …` to the module with that exact spelling (the name is lower-case in the DDL so case normalization cannot bite, but the derivation is `openIndexTree`'s `${collectionUri}/index/${indexName}`). (2) `watchedCount === 2` assumes the watcher node has no other watched collections — true today because only `Watched` is tagged there. Both fail loudly rather than silently if wrong.
- **The spec's "no tail read between the commit and the wake" loop now has a second subscription making event-driven tail reads.** Its first read and its post-registration re-read both happen before the loop starts (the loop waits for both attaches and for `reads.started === reads.finished`), so only ticks should intervene, and the loop already retries up to four times when a read does. Not observed either way — it has not been run.
- **The per-tick request fan-out is unmeasured.** Stated as a structural consequence in the docs and at the code site; no multiplier is claimed as measured. If review wants a number, it needs a client-node benchmark that does not exist.
- **Reconcile now runs on every `registerTree` for every table**, tagged or not. For an untagged table or a non-`network` transactor the wanted set is empty and the step is a no-op with no log, but the queued-promise chain is built. Worth a look at whether the coalescing flag is airtight: it is cleared by the `.then` callback *before* `applyNetworkWatch` reads the wanted set, so a request landing in that window queues one extra (harmless) reconcile rather than being dropped.
- **Unchanged, by design:** nothing retries a collection whose open failed until the collection set or the tag next changes (the same behaviour the single watch had); `CollectionFactory.dispose()` still closes watches behind the vtab's back (the generalized `NOTE:` records it); and the db-close leak (backlog `optimystic-vtab-watch-db-close-teardown`, which already carries an arm for this) now leaks one watch per collection instead of one per table.
- **Verified only by inspection**, as the implement ticket specified: the index-first wake being absorbed by the existing `row === undefined || !rowImpliesEntry(...)` arm in `executeIndexScan`; the five registration call sites (`addIndex`, `removeIndex` + `reassignUniqueEnforcement`, `attachBlobReferences`, `ensureEveryDeclaredIndex`/`reconcileMaintainedIndexes`) all funnelling through `registerTree`/`forgetTree`; the DROP/refused-CREATE/other-machine-dropped paths converging on `releaseRegistrations` → `teardownChangeSubscription`; and two tables sharing a collection id each getting their own set from `collectionsOf`.

## How to exercise it by hand

Any `network`-transactor table tagged `"optimystic.network_watch" = true` with at least one secondary index. With the `module` log namespace on, `watch:network-set table=… opened=[…] closed=[…]` prints once per reconcile that changed something — it should name the table's collection and each index collection at initialization, one more line on `create index`, and the index's id under `closed=` on `drop index`. `drop table` should close every id. On a node with no cohort-topic watch service the single "tagged … has no cohort-topic watch service" warning must still appear exactly once, not once per index.
