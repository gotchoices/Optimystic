description: A machine that sends change announcements currently keeps a replay buffer and gossips about every collection it stores, whether or not anyone is listening; it should only do so for collections someone has actually subscribed to, so turning the feature on for one table does not make every other table pay for it.
prereq: network-collection-watch-service
architecture: docs/reactivity.md#forwarder-cohort-state-per-collection-served
files: packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/reactivity/forwarder-host.spec.ts, docs/reactivity.md
----

# Keep per-collection forwarding state only where someone subscribed

## The cost today

On a node with `cohortTopic.enabled`, every commit of every collection whose announcement this node originates goes into `ReactivityForwarderHost.ingest`, which on first sight of a topic builds a `PushState` — a 256-entry replay ring, a dedupe window, per-subscriber queues (`resolveServed` in `packages/db-p2p/src/reactivity/forwarder-host.ts`). That state is never evicted except after a tail rotation's drain window. And every live `PushState` is gossiped to its cohort every gossip round (`ReactivityPushStateGossipDriver`, fed by `forwarderHost.livePushStates()` in `libp2p-node-base.ts`, default every 5 s). So the node pays memory and a gossip frame per round for every collection it has ever announced — index trees, the plugin's schema tree, and every table nobody watches included. The Quereus plugin's per-table opt-in (ticket `quereus-tables-opt-in-to-network-change-notification`) promises that an untagged table behaves exactly as before; on a node whose operator enabled the substrate for one tagged table, that promise fails without this ticket.

## The rule

A topic gets forwarding state only when there is demand for it: `directSubscribers(topicId)` is non-empty (the cohort-topic registration records with a reactivity payload that `reactivityDirectSubscribers` already reads). Child cohorts would also count, but none exist yet (`PushState.childCohorts` is empty until the parent/child link lands); write the predicate so adding them is one clause.

- In `resolveServed`, when no state exists yet and there is no demand, return "nothing to do" **without** remembering it, so the first ingest after a subscriber registers builds the state. The Edge `null` memo is unchanged.
- Once built, state is kept as today. Evicting it when demand disappears is not needed now: put a `NOTE:` at `served` saying state outlives its last subscriber until a rotation drains it, and that eviction on a demand check is the remedy if memory ever shows it.
- The demand check runs on every ingest of a topic without state: one registry lookup plus a records scan (`host.registry.findServing(topicId, 0)` → `reactivityDirectSubscribers`). Cheap; no caching.

## Why nothing is lost

A subscriber attaches with the collection's current revision as its starting point. If a commit lands between that read and the registration reaching the cohort, there is no state to buffer it, so the subscriber's next notification shows a gap; its backfill finds nothing to serve and escalates, and the watch service (`network-collection-watch-service`) answers every escalation with a wake and its tick re-reads the tail regardless. The watcher therefore wakes; it simply does not learn the missed revision from the cohort. Whole-table invalidation needs no more. (The db-core subscriber also adopts the first notification as its baseline when it starts at revision 0 — `createReactivitySubscriber` in `packages/db-core/src/reactivity/subscriber.ts` — but the watch service starts at the real revision, so it relies on the escalation path above, not on that.)

## Edge cases & interactions

- **Cohort members other than the primary** learn of a subscriber through cohort gossip replication of the registration record, so their demand check turns true shortly after the primary's; until then they hold no state, and a backfill reaching them declines and the recover transport tries the next member — existing behavior for a member that has not yet seen the topic. Inspection.
- **Inbound push-state gossip for a topic this node holds no state for** keeps today's behavior (`pushStateForGossip` returns undefined and the frame is ignored). Inspection.
- **Rotation observation** (`ReactivityOriginationManager.detectTailRotation`) runs before `emit` and keeps per-collection last-seen tails regardless of demand, so `markRotated` still fires for an unwatched collection's old topic; the drain gate it creates is harmless without state. Inspection.
- **Existing tests that originate before registering a subscriber** (the mock harness's cold-to-hot scenarios, the real-socket resume case) must register first or expect no buffered history; adjust them, do not special-case the host.

## Test

One case in `forwarder-host.spec.ts`: with a fake transport and a `directSubscribers` stub returning `[]`, an ingest builds no state (`pushStateFor` undefined, `livePushStates()` empty); after the stub starts returning a subscriber, the next ingest builds state and fans out to it. That is the branch this ticket adds.

## Docs

`docs/reactivity.md` § Forwarder-cohort state (per collection served): forwarding state exists only for topics with at least one subscriber, and what a late subscriber gets.

## TODO

- Demand predicate and the `resolveServed` change in `forwarder-host.ts`; the host dependency that supplies it (or reuse `directSubscribers`).
- The `NOTE:` at `served`.
- Adjust tests that relied on state existing before any subscriber.
- The forwarder-host case.
- Docs.
- `yarn build`, `yarn typecheck`, `yarn workspace @optimystic/db-p2p test`, and the db-p2p integration suite with `OPTIMYSTIC_INTEGRATION=1`.
