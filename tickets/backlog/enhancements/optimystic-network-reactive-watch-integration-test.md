description: The reactive-watch bridge's libp2p/network path (node.blockChangeNotifier → NetworkTransactor.localChangeNotifier → vtab → Database.notifyExternalChange) is wired and structurally verified but has no end-to-end automated test. Add an OPTIMYSTIC_INTEGRATION-gated case proving a commit hosted on a real libp2p node wakes a Database.watch consumer.
files: packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/src/libp2p-node-base.ts
----

# optimystic reactive watch: network-path integration test

> **Superseded in part** (`reactivity-e2e-mock-tier`). The *reactivity-surface* intent of this stub — a
> commit driving notification fan-out to subscribers over a network — is now covered at scale by the
> reactivity mock-tier e2e suites (`packages/db-p2p/test/reactivity/mesh-*.spec.ts` over
> `src/testing/reactivity-mesh-harness.ts`): real commits flow through the real `local-change-notifier-bridge`
> → real origination → real fan-out → real delivery, end-to-end. What remains uniquely here is the
> **real-libp2p socket** wakeup of a **Quereus `Database.watch`** consumer (the vtab →
> `notifyExternalChange` bridge over an actual libp2p node), which belongs to the real-libp2p tier
> (`substrate-e2e-real-libp2p-tier`), not the mock tier. Keep this ticket for that residual real-socket
> Quereus-bridge case; the mock tier does not duplicate it.

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

## Also lands here: reactivity tail-rotation re-registration wiring

`reactivity-rotation-host-wiring-e2e` constructs and exposes a per-node
`RotationReRegistrationScheduler` as `node.reactivityRotation`, but its
`reRegister(plan)` move is a **logged no-op** until a subscribe factory that
*constructs* `ReactivitySubscriptionManager`s exists — the same Quereus
`Database.watch` bridge this ticket covers. When that factory lands it must also:

- bind each constructed manager's `onRotation` observer to
  `node.reactivityRotation.schedule(notice)` (so a surfaced `RotationNotice` arms
  the jittered re-registration timer), and
- implement `reRegister(plan)` to build a **fresh** `ReactivitySubscriptionManager`
  under `plan.newTopicId` carrying `plan.lastRevision`, then swap the
  `ReactivitySubscriberRegistry` entry **registering the NEW-topic handler BEFORE
  unregistering the old**, so a notification arriving mid-swap is never dropped.

This ordering requirement is currently spelled out only in `libp2p-node-base.ts`
source comments (the scheduler construction site) and `docs/reactivity.md`
§Tail rotation; it is exercised end-to-end only at the mock tier
(`packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts`, which plays the
factory role via re-attach and therefore does **not** cover the registry swap).
Capture it here so the swap ordering is not lost when the factory is implemented.

## Out of scope

- Wiring `mesh-test` reactivity (separate, only if a demonstrated need appears).
- Multi-node replication-path notification (the push/replication path is tracked
  by `optimystic-churn-rereplication-persist-handlepush`).
