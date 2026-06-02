description: REVIEW — optimystic Quereus vtab now bridges collection-change notifications to Quereus watch invalidation (Database.notifyExternalChange), so reactive consumers wake on commits without polling. Implemented + built + tested (196 passing, 0 failing); review the gaps below.
prereq: optimystic-block-change-notification, quereus-external-change-watch-api
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md
----

# Review: optimystic vtab → Quereus reactive-watch bridge

Closes the loop: a commit on an optimystic-backed collection (local or remote)
wakes Quereus `Database.watch` consumers through the normal reactive path.

Flow: `StorageRepo.commit → CollectionChangeEvent → transactor.onCollectionChange
→ OptimysticVirtualTable listener → Database.notifyExternalChange(table) → watchers`.

## What shipped

### `collection-factory.ts`
- **Network transactor wiring.** `createNetworkTransactor` reads
  `(node as any).blockChangeNotifier` (the hosting node's `StorageRepo`, exposed by
  db-p2p's `libp2p-node-base`) and passes it as `localChangeNotifier` into the
  `NetworkTransactor` config. Cached on `nodeInfo` (the `libp2pNodes` map gained a
  `blockChangeNotifier?` field) so it survives node reuse.
- **Local/test transactors are now `IBlockChangeNotifier`s.** Both
  `createLocalTransactor` and `createTestTransactor` return objects that add
  `onCollectionChange: storageRepo.onCollectionChange.bind(storageRepo)`, making
  single-process multi-collection scenarios reactive without libp2p.
- **`getCollectionId(options): CollectionId`** — public helper returning
  `parseCollectionId(collectionUri)` (the URI path). **Verified** this equals
  `header.collectionId` (stamped by `TransactorSource.createBlockHeader` with the
  id passed to `Collection.createOrOpen`) and therefore equals
  `CollectionChangeEvent.collectionId`. No hashing/prefixing — the assumption in
  Design §2 holds; a test pins it.
- **`subscribeToCollectionChanges(options, collectionId, listener): Promise<() => void>`**
  — resolves the transactor via `getOrCreateTransactor`, feature-detects
  `isBlockChangeNotifier`, registers, and returns a logged no-op unsubscribe when
  the transactor doesn't implement it. (Returns a Promise — minor deviation from
  the ticket's `() => void` signature, because `getOrCreateTransactor` is async;
  the *unsubscribe* is still `() => void`.)
- **`mesh-test` left unwired** (sanctioned by the ticket): `buildNetworkTransactor`
  passes no `localChangeNotifier`, so its `NetworkTransactor.onCollectionChange` is
  an inert no-op. Documented in `createMeshTestTransactor`'s JSDoc.

### `optimystic-module.ts` (`OptimysticVirtualTable`)
- New fields `changeUnsubscribe?`, `changeSubscribed` (subscribe-once guard).
- `doInitialize` calls `ensureChangeSubscription()` after init completes
  (self-isolating — a wiring failure never blocks init).
- `ensureChangeSubscription`: subscribes once to the **main** collection id; skips
  `tree://optimystic/schema`; does NOT subscribe to index sub-collections
  (`<uri>/index/<name>` carry their own ids; whole-table invalidation re-queries
  them anyway).
- `handleCollectionChange`: calls `this.db.notifyExternalChange(tableName,
  schemaName)` with full error isolation (sync try/catch + `.catch` on the returned
  promise so an async rejection can't escape the synchronous storage callback).
- `teardownChangeSubscription()` (public) called from `OptimysticModule.destroy`
  (DROP TABLE).

## ⚠️ Deviations / gaps the reviewer should scrutinize

1. **Teardown is in `destroy()`, NOT `disconnect()` (intentional deviation from the
   ticket TODO).** This vtab's `disconnect()` is a per-statement no-op that
   deliberately keeps the table initialized across statements/scans (pre-existing
   design, see its comment). Unsubscribing there — as the ticket literally said —
   would kill reactivity after the very first scan. So the subscription lives for
   the table's lifetime and is released on `destroy`. Rationale is in code comments
   on `teardownChangeSubscription` and `disconnect`. **Confirm you agree this is the
   right hook.**

2. **No db-close teardown → benign listener leak.** If a `Database` is closed
   without `DROP TABLE`, the storage listener stays attached until the
   `CollectionFactory` is GC'd. After close, an external commit drives
   `handleCollectionChange → db.notifyExternalChange → checkOpen() throws`, which is
   caught and logged (one warning per stale listener per commit). Benign but noisy.
   There's no vtab hook for db-close today (only `connection.disconnect()` and
   `module.destroy`). A clean fix would need a Quereus-side close hook or
   module-level connection tracking — out of scope here; flag if you want a ticket.

3. **Network/libp2p path is wired but NOT covered by an automated test.** Verified
   structurally (node exposes `blockChangeNotifier` in src+dist; `NetworkTransactor`
   accepts `localChangeNotifier`), but the libp2p integration spec is gated behind
   `OPTIMYSTIC_INTEGRATION` and doesn't exercise reactive watch. The in-process
   `local` path is fully tested and shares the exact same vtab→Quereus code; only
   the `node.blockChangeNotifier` plumbing is network-specific and untested
   end-to-end. Consider an `OPTIMYSTIC_INTEGRATION` reactive-watch case as
   follow-up.

4. **Redundant self-wakeup accepted in v1.** A node that hosts AND authors a write
   fires watchers twice: precisely via Quereus's post-commit path, and coarsely via
   the storage funnel. Harmless (over-firing only re-queries; no loop — re-query
   doesn't write). Documented in `docs/internals.md`. No author-suppression in v1.

5. **`mesh-test` reactive watch is a silent no-op** (see above). If a consumer
   expects reactivity on `mesh-test`, it won't get it.

## How to validate

> `dist` is **gitignored** — the tests import from `../dist/`, so build first.

```
cd packages/quereus-plugin-optimystic
yarn build            # tsup; regenerates dist from src (+ portal-linked Quereus)
yarn typecheck        # tsc --noEmit; clean
yarn test 2>&1 | tee /tmp/qpo-test.log
```

Last run: **196 passing, 4 pending, 0 failing** (~2m). The 4 pending are the
`OPTIMYSTIC_INTEGRATION`-gated libp2p cases. No pre-existing failures surfaced.

### Test coverage (`test/reactive-watch.spec.ts`, 6 cases, all green)
Drive everything in-process with the `local` transactor; an external commit is a
direct `factory.createOrGetCollection(...).replace(...)` (bypasses the Database SQL
path → models a remote author, so only the notification bridge can wake a watcher).

- **End-to-end wake** — `full` watch over `select * from t` fires on an external
  commit to the same collection; matched covers `t`.
- **Collection scoping** — a commit to a *different* collection (a 2nd subscribed
  table `u`) does NOT wake the `t` watcher (proves table-level routing, not just
  "nothing fired").
- **Row-scoped watch** — `select * from t where id = 'x'` surfaces `'x'` in `hits`
  (confirms the vtab yields a `rows` change scope; the analyzer-derived scope was
  used, not a hand-built one).
- **Unsubscribe** — after `sub.unsubscribe()`, further external commits don't wake.
- **Destroy / no leak** — spies on `db.notifyExternalChange`; after `DROP TABLE`,
  an external commit does NOT call it (storage listener removed).
- **collectionId mapping** — `getCollectionId === 'reactive-map/c'` AND the emitted
  `CollectionChangeEvent.collectionId` equals it.

### Suggested adversarial review angles
- **Feature-detection edge:** a custom/injected transactor lacking
  `onCollectionChange` (see `catalog-hydration.spec.ts`'s mock) → confirm the
  `console.debug` no-op fires and nothing breaks. (It does — those debug lines in
  the test output are expected, not a regression.)
- **Subscribe-once race:** is the `changeSubscribed = true`-before-await guard
  sufficient given `initialize()` is already serialized by `initializationPromise`?
- **Error isolation:** force `db.notifyExternalChange` to throw / reject and confirm
  the storage commit still succeeds and no unhandled rejection escapes.
- **Index/schema scoping:** confirm an index-tree commit doesn't separately wake
  (only the main collection is subscribed) and the schema tree is skipped.

## Out of scope (do not expand)
- Edge/client nodes that don't host blocks (no push; still poll).
- Persisting/emitting on the push/replication path
  (`optimystic-churn-rereplication-persist-handlepush`).
- Per-row precise invalidation (Quereus API is coarse by design).
- Sereus `StrandWatcher` migration (separate `cadre-core` repo).
