description: The reactive-watch bridge's libp2p/network path (node.blockChangeNotifier → NetworkTransactor.localChangeNotifier → vtab → Database.notifyExternalChange) is wired and structurally verified but has no end-to-end automated test. Add an OPTIMYSTIC_INTEGRATION-gated case proving a commit hosted on a real libp2p node wakes a Database.watch consumer.
files: packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/src/libp2p-node-base.ts
----

# optimystic reactive watch: network-path integration test

## Problem

The `optimystic-vtab-reactive-watch-bridge` work made optimystic-backed Quereus
tables wake `Database.watch` consumers on commit. The in-process `local`/`test`
transactor path is fully covered by `test/reactive-watch.spec.ts` (7 cases), and
that path shares the exact vtab → `Database.notifyExternalChange` code with the
network path.

The **network-specific plumbing is untested end-to-end**:

- `libp2p-node-base` exposing `(node as any).blockChangeNotifier = storageRepo`,
- `CollectionFactory.createNetworkTransactor` reading it and passing it as
  `NetworkTransactor`'s `localChangeNotifier`,
- `NetworkTransactor.onCollectionChange` delegating to that notifier.

Each link is verified structurally (present in src + dist), but no automated test
drives a real commit through a libp2p node and observes a watcher fire.

## Expected behavior / requirements

Add an `OPTIMYSTIC_INTEGRATION`-gated case (alongside the existing gated libp2p
specs) that:

- stands up a hosting libp2p node (the `network` transactor) backing an
  optimystic table,
- registers a `Database.watch` over a query on that table,
- drives a commit that lands on the hosting node's storage (local author, or a
  second peer if the harness supports it),
- asserts the watcher fires via the notification bridge (not via the local
  commit's own post-commit path — distinguish, as the in-process specs do, so the
  test actually exercises `notifyExternalChange`).

## Context

- Gated behind `OPTIMYSTIC_INTEGRATION` because it needs real libp2p; the 4
  currently-pending specs in this package are the existing gated cases.
- `mesh-test` is intentionally NOT wired for reactive watch (no
  `localChangeNotifier`), so it cannot stand in for this — it would need the
  mesh's per-node `StorageRepo` threaded through the testing harness first.

## Out of scope

- Wiring `mesh-test` reactivity (separate, only if a demonstrated need appears).
- Multi-node replication-path notification (the push/replication path is tracked
  by `optimystic-churn-rereplication-persist-handlepush`).
