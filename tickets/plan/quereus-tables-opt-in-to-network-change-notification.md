description: A Quereus app watching an optimystic table only hears about changes that happen to be stored on its own machine; a table should be able to declare, in its schema, that its changes are pushed across the network, so watchers on any machine are woken when another machine writes to it.
architecture: docs/reactivity.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/reactivity/subscriber-registry.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/src/reactivity/origination-manager.ts, packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, docs/reactivity.md, docs/internals.md, packages/quereus-plugin-optimystic/README.md
----

# Quereus tables opt in to network change notification

Replaces the backlog stub `optimystic-network-reactive-watch-integration-test`, whose remaining content
(the rotation re-registration requirements) is carried below.

## Where things stand

Two change-notification paths exist, and nothing joins them.

**Local wake, working today.** `OptimysticVirtualTable.ensureChangeSubscription` subscribes each table
to its transactor's `onCollectionChange` and turns every event into a whole-table
`Database.notifyExternalChange`. For the `network` transactor the notifier is the node's own
`StorageRepo`, so a watcher wakes only when a commit is *applied on this machine*, which happens only
when the machine is one of the storage machines for that table's blocks. A phone or laptop that does
not store the table never wakes and has to poll. (`docs/internals.md` § Reactive Watch Bridge, "Host
requirement".)

**Network notification, built and tested but never used by a table.** With `cohortTopic.enabled`, a
commit on one of the storage machines for a collection's log tail sends a signed notification that
reaches remote subscribers over real sockets, with resume/backfill for subscribers that were asleep
(`docs/reactivity.md` § Real-libp2p e2e coverage). The node exposes everything a subscriber needs:
`cohortTopicHost.service`, `reactivitySubscribers`, `reactivityRecover`, `reactivityRecoverSigners`,
`reactivityCohortHintCache`, `reactivityRotation`. What is missing is the last mile:

1. Nothing outside the test harness (`src/testing/reactivity-mesh-harness.ts`) constructs a
   `ReactivitySubscriptionManager`.
2. The plugin never enables the network path: `CollectionFactory.createNetworkTransactor` calls
   `createLibp2pNode` without `cohortTopic`, and `LibP2PNodeOptions` has no field for it.
3. A delivered notification has no route to `Database.notifyExternalChange`.
4. The vtab cannot supply what a subscription is keyed on: the topic is `H(tailId ‖ "reactivity")`,
   so it needs the collection's current log tail id and its last seen revision. `Collection` holds
   `logTailId` privately.
5. Tail rotation re-registration is a logged no-op: `reRegister(plan)` in `libp2p-node-base.ts`
   says "no subscribe factory is wired yet".
6. There is no way to choose which tables take part. Sending is all-or-nothing per node: every
   collection on an enabled node is sent, including index sub-collections and the schema tree.

## What to build

A table declares in its schema that it takes part in network change notification. When it does, a
`Database.watch` on that table, on any machine on the network, fires after another machine commits to
the table, through the same `notifyExternalChange` path local wakes already use. A table that does not
declare it behaves exactly as today.

### The declaration: a table tag

Quereus tables already carry `with tags (…)`, and the plugin already persists table tags in the
catalog record and restores them on `hydrate` (`schema-manager.ts`). Keys outside the `quereus.`
prefix are free-form, so the plugin can own an `optimystic.` key without an engine change. The
precedent is Quereus's own per-table opt-in, `quereus.sync.replicate = true`.

Proposed default (the plan stage may refine the spelling):

```sql
create table orders (…) using optimystic('tree://app/orders') with tags (optimystic.reactive = true);
```

A tagged table subscribes for its whole lifetime once initialized, and releases the subscription where
it releases the local one today (`teardownChangeSubscription`, on DROP TABLE). Quereus gives a vtab no
notice when a watch is added or removed, so subscribing only while watches exist would need an engine
change. The tag is the explicit "I want this" that makes a table-lifetime subscription acceptable.

### Design questions the plan must settle

**Who reads the tag on the sending side?** Notifications are sent by the storage machines for the
collection's log tail. Those machines may run no Quereus and never see the catalog. Today, on an
enabled node, `ReactivityForwarderHost.ingest` creates per-collection state (a replay ring and a dedupe
set) for every collection whose tail it serves, whether or not anyone subscribes. Options:

- (a) The tag only controls subscribing. Sending stays node-wide under `cohortTopic.enabled`.
  Simplest; the cost is per-collection state on tail machines for collections nobody watches.
- (b) The flag travels with the data the tail machines already hold, for example a field in the
  collection header or the log entry, so senders skip collections that did not opt in. This is a
  format change, and the header and the tail are stored on different machines.
- (c) Sending is driven by demand: a tail machine keeps per-collection state only once a subscriber
  has registered for that topic. No flag is needed on the storage side, and the tag becomes the
  subscriber's opt-in. A subscriber that registers late already adopts a baseline
  (`mesh-cold-to-hot.spec.ts`, "late subscriber adopts baseline"), so nothing is lost by not
  buffering before the first registration. Confirm this before relying on it.

Leaning (c): it needs no format change and costs nothing for untagged tables. Check whether "publish"
still needs any meaning separate from "someone subscribed". If the specification turns out to need a
real publish permission (a table whose changes must *not* be sent even to a subscriber who asks),
route that question to `blocked/`.

**How the plugin enables the node's network path.** Add `cohortTopic` passthrough to
`LibP2PNodeOptions` / the plugin-level config. A node injected through `registerLibp2pNode` may or may
not have it. A tagged table on a node without a cohort-topic host should fall back to local wakes
only, with one warning, not fail.

**Double wakes.** On a machine that both stores the tail and subscribes, the local storage listener
and the network notification both fire. Both are harmless (coarse invalidation, one extra re-query).
Decide whether to suppress one, and record the decision either way.

## Requirements carried over from the replaced stub

- Bind each constructed manager's `onRotation` observer to `node.reactivityRotation.schedule(notice)`.
- Implement `reRegister(plan)`: build a fresh `ReactivitySubscriptionManager` under
  `plan.newTopicId` carrying `plan.lastRevision`, then swap the `ReactivitySubscriberRegistry` entry,
  **registering the new-topic handler before unregistering the old** so a notification arriving
  mid-swap is not dropped. This ordering is only written down in the `libp2p-node-base.ts` comment
  at the scheduler's construction and in `docs/reactivity.md` § Tail rotation. The mock-tier
  `mesh-tail-rotation.spec.ts` plays the factory by re-attaching and does not cover the swap.
- The real-network proof the stub asked for: an `OPTIMYSTIC_INTEGRATION`-gated case where a commit
  from one real libp2p node wakes a `Database.watch` on a *different* node that does not store the
  table. It must fail if the wake came from the local storage listener, so pick a watching node
  outside the tail cohort, or assert which path fired.

## Edge cases & interactions

- Tail rotation while subscribed. Covered by the swap above.
- A subscriber asleep past the replay window. The manager backfills or reports out-of-window, and
  either way one `notifyExternalChange` is enough, because the next read pulls.
- Tag added or removed on an existing table through `apply schema`: what the differ does with a tag
  change on an optimystic table, and whether the subscription follows it without a restart.
- A table first touched by a committed read (`initializeForCommittedRead`, provisional, no
  subscriptions). It must not subscribe until full initialization.
- Initialization retried after failure ("A failed first open is retried, not remembered" in
  `docs/internals.md`). The subscription must be idempotent across retries and leave nothing behind
  when a pass fails.
- `Database.close` without DROP TABLE already leaks the local listener
  (`optimystic-vtab-watch-db-close-teardown`, backlog). The network subscription adds renewal traffic
  to that leak, so either fix both together or record the added cost there.
- Index sub-collections and `tree://optimystic/schema` are never subscribed, as with local wakes.
- `mesh-test` and `test` transactors have no cohort-topic host: they take the local-only fallback.
- React Native: nothing added may pull in node-only modules (`yarn check:rn`).

## Docs to update

`docs/internals.md` § Reactive Watch Bridge (host requirement, lifetime), `docs/reactivity.md`
§ Real-libp2p e2e coverage ("still deferred" paragraph) and § Tail rotation, and the plugin README
(the tag and the node option).
