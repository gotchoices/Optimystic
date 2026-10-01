description: A machine that sends change announcements used to keep a replay buffer and gossip about every collection it stores, whether or not anyone was listening; it now does so only for collections someone has subscribed to, so turning the feature on for one table no longer makes every other table pay for it.
prereq: network-collection-watch-service
architecture: docs/reactivity.md#forwarder-cohort-state-per-collection-served
files: packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-p2p/test/reactivity/forwarder-host.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/reactivity.md, docs/internals.md
----

# Keep per-collection forwarding state only where someone subscribed

## What changed

`ReactivityForwarderHost` (`packages/db-p2p/src/reactivity/forwarder-host.ts`) builds a topic's `PushState` (replay ring, dedupe window, per-subscriber queues) only when the topic has demand. Before this, the first notification for any topic built it, and every built `PushState` was gossiped every round by the push-state gossip driver (`livePushStates()` in `libp2p-node-base.ts`).

- `resolveServed` now runs three checks in order: the existing memo (a `ServedTopic`, or the Edge `null`); the Edge gate (`mayServeAsReactivityForwarder` — still memoized as `null`, unchanged); then the new `hasDemand(topicId)`. When there is no demand it returns `undefined` and **stores nothing**, so the first ingest after a subscriber registers builds the state. It now returns `ServedTopic | undefined`; the `null`/`undefined` distinction stays inside the `served` map.
- `hasDemand` is `directSubscribers(topicId).length > 0`, i.e. `reactivityDirectSubscribers` over `registry.findServing(topicId, 0)` in the node wiring. Child cohorts are left as a future second clause (none exist yet). No caching.
- Construction switched from `instantiateForwarderPushState` to `mayServeAsReactivityForwarder` + `requireForwarderPushState`. The Edge check has to come before the demand check: if the demand check ran first, an Edge node would never set its `null` memo and would repeat the registry scan on every ingest. `instantiateForwarderPushState` combines the gate with the allocation, so it couldn't be used for that ordering.
- A `NOTE:` at `served` records the tripwire: state outlives its last subscriber until a rotation drain window closes, and the remedy is to evict on a demand check at ingest.
- No change to `libp2p-node-base.ts` was needed. The existing `directSubscribers` dependency already supplies the demand signal.

## Tests

- **Added** `forwarder-host.spec.ts` › "builds no forwarding state for a topic nobody subscribed to, and builds it on the first ingest after one does": with `directSubscribers` returning `[]`, an ingest leaves `pushStateFor` undefined, `livePushStates()` empty and sends nothing. Once a subscriber appears, the next ingest builds state, buffers only that revision and fans out to the subscriber. This is the only new branch.
- **Adjusted** `forwarder-host.spec.ts` › child-cohort dial test: it used `directSubscribers: []` and relied on state being built anyway. It now has one direct subscriber and expects `[SUB_A, CHILD_PRIMARY]`. Under the new rule, child cohorts alone don't create demand, because they live on the `PushState` that demand would create.
- **Adjusted** `substrate-real-libp2p.integration.spec.ts` › "a remote subscriber resumes past the tail over a real recover socket…": this test originated rev 1 with no subscriber, then expected a backfill. It now registers the remote as a reactivity subscriber on the origin's cohort engine first, using the file's existing `signedRegister` helper (T3, self-vouch, reactivity app payload), and then originates.
- The mock mesh harness (`packages/db-p2p/src/testing/reactivity-mesh-harness.ts`) builds its own `PushState` at `registerCollection` and does **not** go through `ReactivityForwarderHost`. So its cold-to-hot scenarios were not affected and were not changed. The ticket expected them to need adjusting; they didn't. As a result, the harness still models the old "state from the first commit" behavior. That only matters if a future mesh test asserts buffered history for commits made before anyone subscribed.

## Validation run

- `yarn build`, `yarn typecheck`: clean.
- `yarn workspace @optimystic/db-p2p test`: 3161 passing, 64 pending, 0 failing.
- db-p2p `test:integration` (`OPTIMYSTIC_INTEGRATION=1`): 45 passing, 2 pending (the two existing `it.skip`s), including the notify-socket, resume-socket and `node.reactivityWatch` cases.
- `quereus-plugin-optimystic` `network-change-notification.integration.spec.ts` (`OPTIMYSTIC_INTEGRATION=1`): 1 passing. Its watcher waits for its registration to reach the writer before committing, so it exercises the "build state on the first commit after registration" path end to end. The rest of the plugin's integration suite was not run.
- `yarn lint:docs`, eslint on the changed files: clean.

## Docs

- `docs/reactivity.md` § Forwarder-cohort state: two new paragraphs. The first says state is built only for a topic with a subscriber, describes the cost of the check, and notes that state stays until a drain window closes. The second covers what a late subscriber gets: a gap, then a backfill that escalates, then the watch service wakes its watchers and its tick re-reads the tail. § Propagation's implemented-callout now names `mayServeAsReactivityForwarder` and the demand rule.
- `docs/internals.md` "Now end-to-end live" bullet: one clause plus a link to that section.

## For the reviewer to check

- The "why nothing is lost" argument depends on the watch service waking on an unservable gap and on its tick. That behavior belongs to the `network-collection-watch-service` prereq; this change only relies on it. A raw `createReactivitySubscriber` consumer outside the watch service that starts at a real revision would see the gap, and its backfill would escalate. Whether escalation wakes such a consumer depends on its own wiring.
- Cohort members other than the primary build state only after the registration record reaches them over cohort gossip. The integration tests cover the primary or origin only; the other-member path was checked by reading the code, not by a test.
- Rotation: `ReactivityOriginationManager.detectTailRotation` still calls `markRotated` for unwatched collections. The drain gate it creates for a topic with no state just expires. Checked by reading the code.
- Inbound push-state gossip for a topic with no state is still ignored (`pushStateForGossip` → `undefined`). Checked by reading the code.
