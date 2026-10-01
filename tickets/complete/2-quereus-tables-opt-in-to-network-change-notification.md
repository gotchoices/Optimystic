description: A Quereus table can declare in its schema that changes to it are announced across the network, so a watch on that table wakes on any machine when another machine writes to it, not only on machines that store the table.
prereq: network-collection-watch-service
architecture: docs/reactivity.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md, docs/reactivity.md
----
# Quereus tables opt in to network change notification

## What was built

A table declared `with tags ("optimystic.network_watch" = true)` subscribes through its node's cohort-topic watch service (`node.reactivityWatch`) from full initialization until DROP TABLE. A wake goes down the same `handleCollectionChange` → `Database.notifyExternalChange` path the local storage listener uses, so `Database.watch` consumers wake on a machine that stores none of the table's blocks when another machine commits.

- The tag key must be quoted (Quereus's parser rejects the unquoted dotted key), and it is read with `=== true`.
- The plugin-level `cohort_topic` config key is passed as the node's `cohortTopic` option (`declaredCohortTopic`). `registerLibp2pNode` now records the injected node's `blockChangeNotifier`.
- `CollectionFactory.watchCollectionOverNetwork` opens the watch with a stateless `readTail` over `Collection.readCommittedTail`. The factory tracks every handle it opens and closes them all in `dispose()`.
- On the vtab, `networkWatchTagged`, `networkWatchArmed` and one serial promise chain (`reconcileNetworkWatch` → `applyNetworkWatch`) open or close the watch so it matches `armed && tagged`. `OptimysticModule.followTagChanges` registers one `table_modified` listener per `Database` and calls `followTags` on it, so `alter table … set tags` starts or stops the watch on a running table.
- Docs updated: the plugin README (*Network change notification* and `cohort_topic`), `docs/internals.md` § Reactive Watch Bridge, and `docs/reactivity.md` § Real-libp2p e2e coverage.
- Test: `packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts`. It runs three real nodes, makes the watcher's storage listener inert, and accepts only a wake that has no tail read between the insert and the wake. The same test checks that an untagged sibling table stays asleep.

## Review findings

**Checked:** read the implement diff (`ticket(implement): quereus-tables-opt-in-to-network-change-notification`, the salvaged partial commit, which holds all of the source) with fresh eyes. Traced the arm/disarm lifecycle through `doInitialize` (provisional pass returns before `ensureChangeSubscription`, so it never arms), `create()`'s failure teardown, `destroy()`, and retry after a failed initialization (arming happens after the last fallible await of `doInitialize`). Verified against `@quereus/quereus` source that `TableModifiedEvent` carries `schemaName`/`objectName`/`newObject: TableSchema` and that rename emits `table_modified` under the new name (refused for this module, as the implementer said). Verified the module is constructed per `register()` call (`src/plugin.ts`). Verified `getNodeKey` matches the `${networkName}:0` key `registerLibp2pNode` uses for port-0 options. Verified `CollectionWatchHandle.close()` never rejects (`packages/db-p2p/src/reactivity/collection-watch.ts`), so `dispose()`'s loop cannot abort the lease releases after it. `applyNetworkWatch` catches everything, so the serial chain cannot reject unhandled.

**Correctness:** no defects found on the reachable paths.

**Minor, fixed inline:**
- `watchCollectionOverNetwork` built or fetched a transactor before checking whether the transactor kind could have a watch service at all. The `network` check now runs first.

**Tripwires recorded (conditional, not tickets):**
- A `dispose()` that lands while `watchCollectionOverNetwork` is awaiting the transactor empties the handle set before the new handle joins it. That handle then lives until DROP TABLE. Recorded as `NOTE:` at the `networkWatches.add` site in `collection-factory.ts`. It only matters if hosts dispose while tables are still initializing.
- After `plugin.dispose()`, a still-live table's `closeNetworkWatch` points at an already-closed handle, so a tag flip reopens nothing (the implementer listed this as a known gap). Recorded as `NOTE:` on the `closeNetworkWatch` field in `optimystic-module.ts`, with the revisit condition that dispose stops being end-of-life for the factory.

**Already tracked elsewhere, confirmed still accurate:** tag changes lost on restart (backlog `bug-optimystic-table-tag-changes-lost-on-restart`). The network watch outliving `Database.close()` without `plugin.dispose()` is recorded as an addendum in backlog `enhancements/optimystic-vtab-watch-db-close-teardown`. The integration spec casts to reach `cohortTopicHost`, which is backlog `debt-node-attachment-reads-bypass-typed-surface`.

**Accepted as designed:** a failed local subscribe leaves the network watch open (the two paths are independent, and the network watch still wakes the table). A machine that both stores and watches the table is woken twice (documented in internals and the README). The `table_modified` listener is never removed (it lives on the `Database`'s own notifier).

**Tests:** kept the single integration case. It pins the one contract that matters end-to-end and rules out the fallback tick, the local storage listener and the service's first-read wake as the source of the wake. Its spy on `Collection.readCommittedTail` is a repo-owned static, which is the same shape as the db-p2p precedent. That spy is the only way to tell the wake came from a notification, so it stays. No unit tests were added: the tag read, option passthrough and factory seam are wiring. Edge cases (provisional→full upgrade, rapid on/off/on, non-`network` transactors) were checked by reading the code above.

**Docs:** README, `docs/internals.md` and `docs/reactivity.md` were read in full against the code and match it, including the quoted tag spelling, the `clusterSize: 1` watch-but-not-announce limitation, the cost statement and the dispose behaviour. No doc changes were needed.

**Validation (this pass):** `yarn workspace @optimystic/quereus-plugin-optimystic build`; root `yarn typecheck`; eslint on both touched sources (clean); `yarn lint:docs` (all resolve); `yarn workspace @optimystic/quereus-plugin-optimystic test`: 1001 passing, 14 pending, smoke ok; the new integration spec with `OPTIMYSTIC_INTEGRATION=1`: passing (69 s). `yarn check:rn` was not re-run: this pass changed only one statement's order and added comments, and the implement pass ran it green.
