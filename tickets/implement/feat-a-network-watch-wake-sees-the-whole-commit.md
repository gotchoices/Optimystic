description: A machine that reads a table over the network without storing any of it can be woken for another machine's write before that write's indexes are readable, and is never woken again, so a lookup through an index right after the wake misses the new row. Each of the table's companion collections gets its own network watch, so one of them wakes the table once it can be read whole.
architecture: docs/internals.md#change-notification-reactive-wake
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`ensureChangeSubscription`, `reconcileNetworkWatch`, `applyNetworkWatch`, `openNetworkWatch`, `registerTree`, `registerCollections`, `removeIndex`, `forgetUnmaintainedTrees`, `teardownChangeSubscription`, the `closeNetworkWatch` / `networkWatchUnavailableLogged` fields), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`watchCollectionOverNetwork` doc), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`collectionsOf`, read only), packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, docs/internals.md (§Change Notification (Reactive Wake) and its *Reactive Watch Bridge*), docs/reactivity.md (§The node's watch service), packages/db-p2p/src/storage/storage-repo.ts (the `armHoldTimer` NOTE only), packages/quereus-plugin-optimystic/README.md (§Network change notification)
difficulty: medium
----
# A network watch wake sees the whole commit

Follow-up to GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47), and the second half of `a-watch-wakes-after-every-collection-of-a-commit-applies` (landed; see `tickets/complete/a-watch-wakes-after-every-collection-of-a-commit-applies.md`).

## What is wrong today

A SQL table in this plugin is not one collection. The table's rows are one, each secondary index is another, each synthesized unique-enforcement index another, and a table with `blobref` columns has a reference tree as well. One SQL transaction writes all of them under a single action id, but a machine applies each as its own storage commit — back to back within one consensus record, or hundreds of milliseconds apart when they travel separately.

Two mechanisms wake a watching machine, and only one of them was fixed:

- **This machine's own storage** (`transactor.onCollectionChange`, the per-collection feed). Storage now holds a collection's wake until the other collections of the same action that this machine is due to store have landed, so a wake from this feed is consistent. That is the landed prerequisite.
- **The network** (`node.reactivityWatch`, opened for a table tagged `optimystic.network_watch`). The vtab opens exactly one watch, on the table's own collection. The announcement for the table's commit is sent by a member of the table's log-tail storage group as soon as the table's commit applies there — over the catch-all commit feed, which is deliberately never held, because holding it would delay tail-rotation detection too. So the wake can arrive before the index's commit has applied anywhere. The watcher re-queries, its index read is answered by a machine that does not have the index commit yet, and it finds nothing. The watch service's backstop tick then compares only the table's tail revision, which this write already moved, so nothing wakes the watcher again.

**Who is actually affected.** A machine that stores the table's blocks is covered by the storage feed above: the early network wake is a harmless extra re-query, and the held storage wake that follows is consistent. The machine left exposed is one that stores none of the table — in practice a **client node** (`servesBlocks: false`, `OptimysticClientNodeAttachments` in `packages/db-p2p/src/optimystic-node.ts`), which carries no storage repo and no local change feed at all, and which a host registers with the plugin through `CollectionFactory.registerLibp2pNode`. For such a machine the network watch is the only wake there is, and a stale index read persists until something else moves the table's own tail.

## What to build

**The vtab opens one network watch per collection of the table, not one for the table.** Every watch calls the same `handleCollectionChange()`, so a wake on any of the table's collections is the same coarse whole-table invalidation the table's own wake already is.

This closes both arms of the promise:

- **Woken again once it can be read whole.** The index's own commit is announced by its own tail's storage group, and the watcher now holds a subscription for it, so the index's landing wakes the table a second time — within the time the index's commit takes, not within a tick.
- **A backstop that sees the index.** Each index collection is now a watched subscription in its own right, so `ReactivityCollectionWatch`'s tick reads and compares its tail. If the index's announcement is lost, or is never made (a storage group of three or fewer retains a full certificate only on the member that coordinated the commit — see *What still only the coordinator announces* in `docs/reactivity.md` §Origination point, and backlog `bug-a-commit-can-go-unannounced-with-no-group-member-holding-its-certificate`), the tick still wakes the watcher within one tick interval (30 s Core, 20 s Edge). Today nothing wakes it at all.

Nothing in `@optimystic/db-p2p` changes. `ReactivityCollectionWatch` already keeps one subscription per collection id, and `CollectionFactory.watchCollectionOverNetwork` already takes the collection id as an argument independent of the options' own URI and already tracks every handle it hands out in `networkWatches` for `dispose()`. The whole change is the vtab's bookkeeping, plus docs.

### Which collections

The wanted set is the union of:

- `this.collectionFactory.getCollectionId(this.options)` — the table's own collection, so this change can never *lose* the watch the table has today, whatever the registry holds; and
- `this.txnBridge.collectionsOf(this.qualifiedTable)` — every collection this instance registered with the transaction bridge under this table's name: the main tree, each declared index tree, each synthesized unique-enforcement tree, and the blob reference tree.

Take the registry rather than rebuild the list from `indexManager.getIndexTrees()` and `this.blobReferences`: `registerTree` and `txnBridge.forgetTree` are already the one funnel every path goes through (`registerCollections`, `addIndex`, `attachBlobReferences`, `ensureEveryDeclaredIndex`, `removeIndex`, `forgetUnmaintainedTrees`), so there is no second list to keep in step, and a table that grows a new kind of child collection is watched without anyone remembering to add it here.

Two kinds of collection in that set are never read by a watcher's re-query — a unique-enforcement tree is consulted only while staging a write, and the blob reference tree is write-side bookkeeping, since reading a blob's bytes goes through the blob service by id. Watching them anyway is deliberate: each costs one registration and one extra whole-table invalidation per write that touches it, which is cheaper than a narrower rule that has to be re-derived every time the table's shape changes. Say so at the site.

### The reconcile

`applyNetworkWatch` today opens or closes a single watch held in `closeNetworkWatch`. Replace that field with a map from collection id to its close, and make the step a diff:

- When `networkWatchArmed && networkWatchTagged` is false, close every open watch (not just the table's) — this is what `teardownChangeSubscription` and a tag flipped off rely on.
- Otherwise open every wanted collection not already open, and close every open collection no longer wanted.

Keep the existing serialization: `reconcileNetworkWatch` chains each step onto `networkWatchSteps`, so a tag flip or a DROP arriving mid-step is applied after it rather than beside it. Add coalescing — if a step is queued and has not started, do not queue another — so the burst of `registerTree` calls one initialization makes collapses into one or two reconciles rather than one per index.

Drive the reconcile from the registration funnel so the set can never drift:

- at the end of the vtab's private `registerTree`, after `txnBridge.registerCollection`;
- after each `txnBridge.forgetTree` of this table's trees (`removeIndex`, `forgetUnmaintainedTrees`);
- from `ensureChangeSubscription`, with `networkWatchArmed = true` and the reconcile moved **outside** the `changeSubscribed` early return. Today a second `doInitialize` — the upgrade after a provisional pass, a retry after a failure, or `adoptCatalogEntry` taking a description another machine changed — returns at that guard and reconciles nothing, so an index the re-initialization opened would go unwatched.

A `reconcileNetworkWatch` that runs before the table is armed sees an empty wanted set and does nothing, so the calls from `registerTree` during initialization are free.

### Reporting

- The once-per-table "tagged but no watch service" warning (`networkWatchUnavailableLogged`) stays once per table, not once per collection: on a node with no `reactivityWatch` every collection resolves `undefined`, and the warning must not be multiplied by the index count.
- The open/close failure log should name the collection it was opening or closing, not only the table.
- Add one trace line per reconcile that actually changed something, naming the table and the collection ids opened and closed — `watch:network-set table=%s opened=%o closed=%o`, in the module's existing `<area>:<event>` log style (as `index:tree-open` is). An operator reading a stale-read report needs to see which collections a table was actually watching.

### Cost, and what is accepted

A tagged table now holds one subscription per collection instead of one. On the machine that matters — a client that stores nothing — the documented per-tick cost (`docs/reactivity.md`, *What a tick costs*) is one tail-read request per coordinator its watched blocks map to, plus one renewal request per distinct primary of the roots it is registered under. Each collection's tail hashes to its own ring position, so both counts grow with the number of collections a tagged table has rather than with the number of tables. That is a structural consequence of the design, not a measured figure — do not write a multiplier as if it had been measured. The tail reads still batch into one `readTails` call per transactor, because every watch goes through the same shared `CollectionTailReader`; it is the request fan-out behind that call that grows. Backlog `feat-a-renewal-reply-carries-the-tail-revision` would fold the tail read into the renewal, and is the mitigation path if this ever bites.

Record as a tripwire at the wanted-set site, not as a ticket: *if a client's per-tick cost for a tagged table ever shows up, add a tag value that watches only the table's own collection, accepting the index gap back.*

### Directions considered and rejected

- **Hold the announcement until the action's other collections land on the announcing machine** (reuse the storage hold for origination). It needs a second, held catch-all feed on `StorageRepo`, because the existing one must stay unheld for tail-rotation detection, and it delays every multi-collection announcement. Worse, it only helps when the machine announcing the table also stores that table's indexes. Where the table's tail group and the index's tail group are disjoint it holds nothing and the gap is exactly as it is today, so it does not close the hole. If announcement promptness in the coinciding-group case ever becomes the complaint, that is a separate optimization on top of this change, not a substitute for it.
- **Teach the watch service about a subscription's companion collections and compare their tails on the tick.** Zero extra registrations and renewals, and it does produce a second wake — but only ever one tick later (30 s Core, 20 s Edge). The common shape of the bug is the table's wake arriving while the index is a few hundred milliseconds behind, which would leave a reactive query showing stale results for half a minute. Watching the collections gets the same backstop as a side effect, with a prompt wake as well, and needs no new API in `@optimystic/db-p2p`.

## Edge cases & interactions

- **An index-first wake.** With per-collection watches, the index's wake can arrive before the table's, so a re-query can see an index entry whose row is not visible yet. The read path already handles this: the index-driven scan skips an entry whose row is missing or no longer implies it (the `row === undefined || !rowImpliesEntry(...)` arm in `optimystic-module.ts`, counted as `rejected` on the `index:seek` trace). The state is reachable today anyway, since the table and its indexes are read as independent collections with no cross-collection snapshot. *Verified by inspection; no change, and no test — the arm exists and is already traced.*
- **The index set changing under an open watch.** `CREATE INDEX` (`addIndex`), `DROP INDEX` (`removeIndex`, plus the unique-enforcement tree `reassignUniqueEnforcement` then synthesizes), `ALTER TABLE ADD COLUMN` giving a table its first `blobref` column (`attachBlobReferences`), and `ensureEveryDeclaredIndex` adopting an index another machine created. Each goes through `registerTree` or `forgetTree`, so each must reconcile. *By inspection of those five call sites after the change; the integration assertion below covers `CREATE INDEX` and `DROP INDEX` end to end.*
- **Re-initialization.** `doInitialize` runs more than once per table. The reconcile must not sit behind the `changeSubscribed` guard (above), and it must run after `registerCollections` and `forgetUnmaintainedTrees` have settled the registry — which the existing order already does, since `ensureChangeSubscription` is the last step of `doInitialize`. *By inspection of that ordering.*
- **DROP TABLE, a refused CREATE, and a catalog showing another machine dropped the table.** All converge on `releaseRegistrations` → `teardownChangeSubscription`, which disarms and reconciles. The reconcile must then close **every** entry in the map; a leftover entry is a watch that keeps renewing and keeps driving `notifyExternalChange` for a table that is gone. *By inspection — make the disarmed arm iterate the map rather than special-case one handle.*
- **A tag flipped off and on again** (`followSchemaTags`). Closes all, then reopens all, each through the serialized step chain so the two never interleave. *By inspection.*
- **Partial failure opening the set.** `watchCollectionOverNetwork` only rejects if the transactor cannot be built — `ReactivityCollectionWatch.watch` itself never fails for network reasons — so in practice a failure is all-or-nothing. Still, open each collection independently and catch per collection, so one failure cannot cost the others, and leave a failed collection out of the map so the next reconcile retries it. Note at the site that nothing retries on its own until the collection set next changes, which is how the single watch behaves today. *By inspection.*
- **Two tables sharing a collection** (a table deliberately declared at another's `<uri>/index/<name>`). `collectionsOf` filters by qualified table name, so each table's set is its own; both open a watch on the shared id, the watch service shares one subscription between them, and both are woken. *By inspection.*
- **One extra invalidation per new watch at initialization.** Each newly opened watch wakes its listeners once on its first committed-tail read — that is the service's documented "open the watch, then read" promise. A tagged table with three indexes therefore fires four whole-table invalidations as it initializes instead of one. Coarse invalidation, so the cost is re-queries; say so in the docs rather than trying to suppress it. *By inspection.*
- **A non-`network` transactor, or a node built without `cohortTopic.enabled`.** Every collection resolves `undefined`; the table keeps its local storage subscription and logs once. *By inspection.*
- **`CollectionFactory.dispose()` closing watches behind the vtab's back.** The existing `NOTE:` on the `closeNetworkWatch` field records this; generalize it to the map — a tag flip on a table still live after `plugin.dispose()` finds entries set and reopens nothing. *By inspection; keep the note, do not try to fix dispose here.*
- **The db-close leak.** A `Database` closed without `plugin.dispose()` already leaks its watches (backlog `optimystic-vtab-watch-db-close-teardown`); this change multiplies the leaked count by the table's collection count. An arm has been appended to that ticket. Out of scope here.

## Verification

Per `tickets/rules/testing.md`, the package suite runs once, in review.

**No new unit test.** The reconcile is registration glue over set arithmetic, and the layer that reproduces the bug needs a watcher that stores none of the table talking to a real cohort-topic substrate — no harness models that. The plugin's mock mesh (`test/mesh-node-harness.ts`) has no cohort-topic or `reactivityWatch` support at all, and `db-p2p`'s `cohort-topic-mesh-harness.ts` is not wired into it. Do not reach for a mocked watch service to manufacture a test; it would pin the stub, not the behaviour.

**Extend the one spec that has a real watch service**: `packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts`. Give its tagged `Watched` table a secondary index, and assert through the service's existing diagnostic seams (`ReactivityCollectionWatch.isAttached`, `watchedCount`) that the watcher is attached to the index's collection id — `network-watch/Watched/index/<name>`, the table URI's path plus `/index/<name>`, as `openIndexTree` derives it — as well as the table's, and that a `drop index` leaves it watching the table alone. One behaviour: the watched set follows the table's collections.

That spec is gated on `OPTIMYSTIC_INTEGRATION=1` and runs over real sockets, so the implement pass **cannot** run it — say so in the handoff rather than claiming it passed. Run lint, the doc-citation lint and typecheck, which the implement pass can.

## Docs

- `docs/internals.md` §Change Notification (Reactive Wake) → *Reactive Watch Bridge*: the *Subscription identity* bullet still says index sub-collections "are NOT separately watched", and the *The network watch has the same shape, and is not held* bullet describes the gap this ticket closes and points at this ticket as backlog. Rewrite both: the local storage subscription is still the table's collection alone (held by storage, unchanged), while the network watch covers the table's whole collection set — with the two wake arms, the tick backstop, and the index-first-wake and extra-invalidation consequences named.
- `docs/internals.md` §Change Notification: the parenthesis in the hold bullet that defers origination holding to "backlog `feat-a-network-watch-wake-sees-the-whole-commit`", and the `armHoldTimer` tripwire whose remedy is "to have the vtab subscribe to its index collections too", both now describe shipped behaviour. Update them, and the matching `NOTE:` at `armHoldTimer` in `packages/db-p2p/src/storage/storage-repo.ts`.
- `docs/reactivity.md` §The node's watch service: the *What a tick costs* paragraph, and the plugin note around the `optimystic.network_watch` tag that describes one watch per tagged table. Say that a tagged table's watch count is its collection count, and what that does to the per-tick request fan-out on a machine that stores none of them.
- `packages/quereus-plugin-optimystic/README.md` §Network change notification: what the tag now opens, and the cost line.

## TODO

- Replace the vtab's single `closeNetworkWatch` with a map from collection id to its close; keep the field's `dispose()` `NOTE:`, generalized to the map.
- Add the wanted-set computation: `getCollectionId(this.options)` unioned with `txnBridge.collectionsOf(this.qualifiedTable)`, with the rationale and the cost tripwire `NOTE:` at the site.
- Make `applyNetworkWatch` a diff — close all when disarmed or untagged, otherwise open the missing and close the surplus — opening each collection independently with per-collection error isolation.
- Add coalescing to `reconcileNetworkWatch` so a queued, unstarted step absorbs further requests.
- Call `reconcileNetworkWatch` from `registerTree`, after each `txnBridge.forgetTree` of this table's trees (`removeIndex`, `forgetUnmaintainedTrees`), and from `ensureChangeSubscription` outside its `changeSubscribed` guard.
- Keep the "tagged but no watch service" warning once per table; name the collection in the open/close failure log; add the `watch:network-set` trace for a reconcile that changed something.
- Update `watchCollectionOverNetwork`'s doc comment in `collection-factory.ts`: the collection id is independent of the options' own URI, and one table passes several.
- Extend `network-change-notification.integration.spec.ts` as above (env-gated; not run in this pass).
- Update `docs/internals.md`, `docs/reactivity.md`, the `armHoldTimer` `NOTE:` in `storage-repo.ts`, and the plugin README as listed.
- Run lint, doc-citation lint and typecheck. Hand off naming the integration spec as not run, and the per-collection request fan-out as unmeasured.
