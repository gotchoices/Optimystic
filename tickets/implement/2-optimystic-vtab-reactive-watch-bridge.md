----
description: Wire the optimystic Quereus vtab to subscribe to collection change notifications and translate them into Quereus watch invalidations, replacing the need for reactive consumers to poll
prereq: optimystic-block-change-notification, quereus-external-change-watch-api
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md
----

# Bridge optimystic collection-change notifications to Quereus watch invalidation

Closes the loop: a remote (or local) commit to an optimystic-backed collection
wakes Quereus `Database.watch`/subscribe consumers through the normal reactive
path, so `StrandWatcher` (Sereus, separate repo) and any other consumer can drop
polling.

## Prerequisites (assume landed)

- `optimystic-block-change-notification`: db-core `IBlockChangeNotifier` /
  `CollectionChangeEvent` contract; `StorageRepo` emits per-collection events from
  the commit funnel; `node.blockChangeNotifier` exposed; `NetworkTransactor`
  accepts an optional `localChangeNotifier` and implements `onCollectionChange`.
- `quereus-external-change-watch-api`: `Database.notifyExternalChange(tableName,
  schemaName?)` fires watchers for a table as a global change.

## Design

### 1. Feed the local notifier into the network transactor

In `CollectionFactory.createNetworkTransactor`
(`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:106-158`),
the node already yields `coordinatedRepo` (`collection-factory.ts:128`). Also read
`(node as any).blockChangeNotifier` and pass it as `localChangeNotifier` into the
`NetworkTransactor` config (`collection-factory.ts:151-157`). Store it on the
cached `nodeInfo` (`collection-factory.ts:133,320-323`) so it survives node reuse.

For the `local` and `test` transactors (`collection-factory.ts:165-215`) the
factory constructs the `StorageRepo` inline — that repo IS the notifier. Return
transactors that also implement `IBlockChangeNotifier` by delegating to their
`storageRepo` (the simplest: spread `onCollectionChange:
storageRepo.onCollectionChange.bind(storageRepo)` onto the returned object). This
makes single-process multi-collection scenarios (and the tests below) reactive
without libp2p. `mesh-test` builds via `buildNetworkTransactor`
(`collection-factory.ts:223-230`) — wire its `localChangeNotifier` from the mesh's
storage repo if readily available; otherwise leave it unsupported and note it.

### 2. Resolve the collection id for a table

The collection id used in block headers equals the path of the collection URI as
parsed by `CollectionFactory.parseCollectionId`
(`collection-factory.ts:270-283`) — e.g. `tree://myapp/users` → `myapp/users` —
which is also the collection's header block id and therefore the
`CollectionChangeEvent.collectionId` value. The vtab already holds
`this.options.collectionUri` (`optimystic-module.ts:96,841`).

**Verify while implementing** that `block.header.collectionId` for a data block
equals `parseCollectionId(collectionUri)` (open a collection, commit a row, assert
the emitted event's `collectionId` matches). If `Tree.createOrOpen` derives the
header id differently (hashing, prefixing), expose the canonical id from the
factory (a small `getCollectionId(options): CollectionId` helper) and use that for
both subscription matching and any assertions — do not hard-code the assumption.

### 3. Subscribe in the vtab; invalidate on change

In `OptimysticVirtualTable` (`optimystic-module.ts:90`), after `doInitialize`
binds the collection (`optimystic-module.ts:147-255`):

- Obtain the notifier for the table's transactor. Add a factory helper, e.g.
  `CollectionFactory.subscribeToCollectionChanges(options, collectionId, listener):
  () => void` that resolves the transactor (reusing `getOrCreateTransactor`),
  feature-detects `isBlockChangeNotifier(transactor)`, and registers — returning a
  no-op unsubscribe (with a debug log) when the transactor doesn't support it
  (e.g. a custom transactor, or `mesh-test` if left unwired). This keeps the
  network-vs-local resolution inside the factory, where it already lives.
- On each `CollectionChangeEvent` for **this** collection id, call
  `this.db.notifyExternalChange(this.tableName, this.schemaName)`. Swallow/log
  errors — a watch-dispatch failure must not crash the storage callback.
  - Subscribe to the **main table** collection id only. Index sub-collections
    (`${collectionUri}/index/${name}`, `optimystic-module.ts:235,705`) mutate
    under the same `actionId` but carry their own collection id; table-level
    invalidation does not need them.
  - Skip entirely for the schema tree (`tree://optimystic/schema`) — schema
    changes are not data-watch events.
- Store the unsubscribe handle on the table; call it in `disconnect`
  (`optimystic-module.ts:262-264`) and in `OptimysticModule.destroy`
  (`optimystic-module.ts:1290-1308`). Subscribe once (guard against
  double-subscribe across repeated `initialize`/`connect`).

`this.db` is available on the base `VirtualTable` (constructor takes `db`,
`optimystic-module.ts:104-120`); confirm `notifyExternalChange` is reachable on
that `Database` type after the Quereus bump.

### 4. Avoid redundant self-wakeups (acceptable, but note it)

On a node that both hosts AND authors a write, the local Quereus commit fires
watchers precisely (tuple-level) via the normal path, AND the storage funnel fires
a coarse `notifyExternalChange`. The second is redundant but harmless (over-firing
only re-queries). Do not attempt author-suppression in v1; document the behavior in
`docs/internals.md`. (A future refinement could tag events with the authoring
peer/actionId and let the vtab skip events it just authored.)

## Docs

- Update `packages/quereus-plugin-optimystic/README.md` with a short "Reactive
  watching" section: tables backed by optimystic now drive `Database.watch`
  consumers on remote commits (coarse, whole-table invalidation), no polling
  needed; note the host node must host the collection's blocks.
- Add a subsection to `docs/internals.md` (near "Observability") describing the
  notification flow: `StorageRepo.commit → CollectionChangeEvent → transactor
  onCollectionChange → vtab → Database.notifyExternalChange → watchers`, including
  the coarse-invalidation and redundant-self-wakeup notes.

## Key tests (`packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts`)

Drive everything in-process with the `local` (or `test`) transactor so two
`Database`s / two collections share one `StorageRepo` (models a remote author):

- **End-to-end wake:** open a table on Database A backed by a shared local
  transactor; register `dbA.watch(scope, handler)` over `select * from t`;
  commit a row to the **same** collection id through a second collection/Database B
  on the shared store; assert A's handler fires (no polling, bounded wait) with a
  `WatchEvent` covering `t`.
- **Collection scoping:** a commit to a different collection/table does not wake
  the watcher.
- **Row-scoped watch:** `select * from t where id = 'x'` surfaces `'x'` in `hits`
  after an external commit to `t`.
- **Unsubscribe / teardown:** dropping the table (`destroy`) or
  `subscription.unsubscribe()` stops wakeups; no leaked storage listeners.
- **collectionId mapping** assertion from Design §2 (event id ==
  factory-resolved id).

Streamed: `cd packages/quereus-plugin-optimystic && yarn test 2>&1 | tee /tmp/qpo-test.log`.

## Out of scope (do NOT expand)

- Edge/client nodes that don't host the collection's blocks (no push subscription
  here — they still fetch/poll).
- Persisting + emitting on the push/replication path (tracked in
  `optimystic-churn-rereplication-persist-handlepush`; the breadcrumb is left by
  the prereq ticket).
- Per-row precise invalidation (the Quereus API is coarse by design).
- Sereus `StrandWatcher` changes — that lives in the separate `cadre-core` repo
  and will switch from polling to `Database.watch` once this capability ships; its
  polling remains acceptable until then.

## TODO

- [ ] Thread `localChangeNotifier` (`node.blockChangeNotifier`) into
      `NetworkTransactor` config in `createNetworkTransactor`; cache on `nodeInfo`.
- [ ] Make `local`/`test` transactors implement `IBlockChangeNotifier` (delegate
      to their `StorageRepo`); wire `mesh-test` if trivial, else note unsupported.
- [ ] Add `CollectionFactory.subscribeToCollectionChanges(options, collectionId,
      listener)` (+ a `getCollectionId(options)` helper) with feature-detection
      and no-op fallback.
- [ ] Verify `block.header.collectionId === parseCollectionId(uri)`; use the
      canonical factory id if it differs.
- [ ] Subscribe in `OptimysticVirtualTable` post-init (main collection only, skip
      schema/index trees, subscribe-once guard); on event call
      `this.db.notifyExternalChange(tableName, schemaName)` with error isolation;
      unsubscribe in `disconnect` + `destroy`.
- [ ] Tests per "Key tests".
- [ ] Update `README.md` + `docs/internals.md`.
- [ ] `yarn build` + `yarn test` green for `quereus-plugin-optimystic` (streamed),
      against the bumped portal-linked Quereus.
