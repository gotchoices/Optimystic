description: A Quereus table can now declare in its schema that changes to it are announced across the network, so a watch on that table wakes on any machine when another machine writes to it — not only on machines that store the table. Review the implementation, its docs and its real-network test.
prereq: network-collection-watch-service
architecture: docs/reactivity.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md, docs/reactivity.md
----
# Review: Quereus tables opt in to network change notification

## What was built

A table declared `with tags ("optimystic.network_watch" = true)` subscribes, for as long as it is initialized, through its node's cohort-topic watch service (`node.reactivityWatch`, from the prerequisite `network-collection-watch-service`). A wake from that service goes down the same `handleCollectionChange` → `Database.notifyExternalChange` path the local storage listener already used, so `Database.watch` consumers on a machine that stores none of the table's blocks now wake when another machine commits.

**Spelling deviates from the plan, out of necessity.** The plan wrote the tag unquoted (`optimystic.network_watch = true`). Quereus's parser rejects that ("Expected '=' after tag key 'optimystic'. Got '.'"), so the key must be quoted: `("optimystic.network_watch" = true)`. Read `=== true`; any other value (the string `'true'` included) is off, with no warning. README, internals and the spec all use the quoted form.

### Pieces

- **Node option.** `LibP2PNodeOptions.cohortTopic?: NodeOptions['cohortTopic']` (`packages/quereus-plugin-optimystic/src/types.ts`; `NodeOptions` was already exported by `@optimystic/db-p2p`). Plugin-level config key `cohort_topic`, parsed by `declaredCohortTopic` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`: absent → undefined; an object whose `enabled` is a boolean → passed through; anything else throws naming the key. Passed to `createLibp2pNode` in `CollectionFactory.createNetworkTransactor`.
- **`registerLibp2pNode`** now records the injected node's `blockChangeNotifier` (previously dropped, so an injected node also lost local wakes).
- **Factory seam.** `CollectionFactory.watchCollectionOverNetwork(options, collectionId, listener)` resolves `undefined` for a non-`network` transactor, a node without `reactivityWatch`, or a transactor registered with no node behind it; otherwise calls `watch({ collectionId, readTail, onChange })` with a stateless `readTail` over `Collection.readCommittedTail(transactor, id, knownTailId)`. Handles are tracked in a set and closed by `dispose()` (and so by `plugin.dispose()`).
- **Vtab.** `OptimysticVirtualTable` gained `networkWatchTagged` (from the declaration, then from every `table_modified`), `networkWatchArmed` (true from full initialization until DROP TABLE), and one serial promise chain (`reconcileNetworkWatch` → `applyNetworkWatch`) that opens or closes the watch to match `armed && tagged`. Arming happens in `ensureChangeSubscription` (reached only by full initialization, after the last await of a successful pass, never by the provisional committed-read pass); disarming in `teardownChangeSubscription`. `followTags(tags)` is the live-follow setter. No watch service → one warning per table, local wakes unchanged. Open/close failures are logged, never thrown.
- **Module.** `OptimysticModule.followTagChanges(db)` registers one `table_modified` listener per `Database` (`WeakSet` guard) on `db.schemaManager.getChangeNotifier()` and calls `followTags(event.newObject.tags)` on a table it holds. Called from `instantiateTable`. The module is per-`Database` (one per `register()` call), so the `schema.name` lookup cannot cross databases.
- **Docs.** README § Reactive Watching (new *Network change notification* subsection: the tag, what it needs, what it costs, watch-but-not-announce on a plugin-built `clusterSize: 1` node) and § Plugin-Level Configuration (`cohort_topic`); `docs/internals.md` § Reactive Watch Bridge ("Host requirement", "Lifetime", new "Double wake from storage and network" bullet), plus the `node.reactivityWatch` bullet under the origination bridge; `docs/reactivity.md` § Real-libp2p e2e coverage (the `Database.watch` half is no longer deferred).

## Test added

- `packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts` (gated on `OPTIMYSTIC_INTEGRATION`, ~65 s): three real libp2p nodes, `clusterSize` = `wantK` = 3, `cohortTopic.enabled`, each node handed to its own plugin through `registerLibp2pNode`. The watcher's `blockChangeNotifier` is replaced with an inert one, so no wake can come from its storage. It waits for `isAttached`, then for the watcher's registration to reach the writer's cohort engine, then subscribes `Database.watch` (so the service's one-time first-read wake is not counted). It spies on `Collection.readCommittedTail` for the watcher's transactor and accepts only a wake with **no tail read** between the insert and the wake — so the fallback tick cannot pass it — retrying the insert up to 4 times when a tail read overlapped or no wake arrived within 10 s. Same case: an untagged sibling's watch does not fire within 10 s of an insert into it.

No unit tests, per the plan: the tag read, option passthrough and factory seam are wiring.

## Validation run (all green)

- `yarn workspace @optimystic/quereus-plugin-optimystic build`, then `yarn typecheck` (root).
- `yarn workspace @optimystic/quereus-plugin-optimystic test`: 1001 passing, 14 pending, smoke ok.
- `yarn check:rn`: passed.
- Plugin integration suite with `OPTIMYSTIC_INTEGRATION=1`: 6 passing, including the new case.
- `yarn lint:docs` and eslint on the touched sources were run by the interrupted prior pass of this ticket, after its last doc edit; docs have not changed since.

## Known gaps and things worth a reviewer's eye

- **A failed local subscribe still leaves the network watch open.** `ensureChangeSubscription` arms the network watch before awaiting the storage listener, and the catch resets only `changeSubscribed`. The two paths are independent, so this seemed right (the network watch still wakes the table), but it is a choice.
- **After `plugin.dispose()`, a still-live table's tag flip does not reopen its watch**: `dispose()` closes the handles behind the vtabs' backs, and each vtab still holds its (now no-op, idempotent) close, so `applyNetworkWatch` sees "already open". Dispose is end-of-life for the factory, so this was left alone.
- **The spec spies on a repo-owned static** (`Collection.readCommittedTail`) to count tail reads, and casts to reach `cohortTopicHost` — both the same shape as the db-p2p precedent (`collection watch over real libp2p` in `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`); the cast is tracked by backlog `debt-node-attachment-reads-bypass-typed-surface`.
- **The `table_modified` listener is never removed**; it lives on the `Database`'s own notifier, so it goes with the `Database`.
- **Tag changes do not survive a restart** — pre-existing, tracked by backlog `bug-optimystic-table-tag-changes-lost-on-restart`. The README says so.
- **`Database.close()` without `plugin.dispose()`** keeps a tagged table's network watch renewing until the node stops; recorded as an arm in backlog `optimystic-vtab-watch-db-close-teardown` (already present from planning, still accurate).
- **Double wake** on a machine that both stores and watches the table is accepted and documented, not suppressed.
- Edge cases from the plan (retry after a failed initialization, provisional→full upgrade, rapid on/off/on, two `Database`s on one injected node, non-`network` transactors) are covered by inspection only.
