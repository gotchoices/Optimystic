description: Give every network node one place an application can ask "wake me when this collection changes anywhere on the network", which builds and maintains the underlying network subscriptions, moves them when the collection's log starts a new block, and falls back to an occasional cheap check so a lost message never leaves a watcher asleep for good.
architecture: docs/reactivity.md
files: packages/db-p2p/src/reactivity/collection-watch.ts (new), packages/db-p2p/src/reactivity/index.ts, packages/db-p2p/src/reactivity/topic-bytes.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/reactivity/subscriber-registry.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/src/reactivity/origination-manager.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-core/src/reactivity/notification.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/reactivity/collection-watch.spec.ts (new), packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/reactivity.md, docs/internals.md
difficulty: hard
----

# A node-level collection watch service

## Why

The network change-notification machinery is built and tested piece by piece (origination, fan-out, notify socket, recover RPC, rotation scheduler), but nothing outside the mock test harness (`packages/db-p2p/src/testing/reactivity-mesh-harness.ts`) constructs a `ReactivitySubscriptionManager`, so no application can use it. The Quereus plugin (ticket `quereus-tables-opt-in-to-network-change-notification`) needs a single call it can make per watched table. This ticket builds that call in db-p2p, where all the parts already live, so the plugin only has to hand over a collection id, a way to read the collection's current log tail, and a callback.

Two things found while planning make this more than glue, and both are in scope:

- **The collection id never survives the wire.** Origination copies the raw collection id into `NotificationV1.collectionId` (`buildNotificationV1` in `packages/db-core/src/reactivity/notification.ts`). Production collection ids are paths like `app/users`. The wire validator requires that field to be base64url (`validateNotificationV1` in `packages/db-core/src/reactivity/wire.ts`, via `b64urlField`), so every real notification is rejected when the receiving node decodes it (`/` is not a base64url character; `users` has an impossible length). The subscriber's own check (`n.collectionId !== deps.collectionId` in `packages/db-core/src/reactivity/subscriber.ts`) would reject it again even if it decoded. Every existing real-socket test hides this by inventing a collection id that is already base64url (`collectionIdB64` in `substrate-real-libp2p.integration.spec.ts`). repro: static.
- **A live subscriber never learns that the log tail moved.** The topic a subscriber registers under is derived from the collection's current log tail block. When that block fills (every 32 log entries) the next commit lands in a new tail block, and its notification is sent to the *new* topic's subscribers only. Nothing sends it to subscribers still registered under the old topic, so they stop hearing anything, and their renewals keep succeeding against the old cohort. `docs/reactivity.md` § Tail rotation says live subscribers "detect the rotation via the delivered `tailId` differing", which is true only in the mock harness, which can synthesize the successor. On a live node the only rotation signal a subscriber can receive is the recover RPC's `kind: "rotated"` redirect, and only within the 60 s drain window and only if it happens to send a recover request. repro: static.

## Design

### Surface

A new class in `packages/db-p2p/src/reactivity/collection-watch.ts`, constructed inside the `cohortEnabled` block of `createLibp2pNodeBase` and exposed as a typed optional attachment `reactivityWatch?: ReactivityCollectionWatch` on `OptimysticNodeAttachments` (`packages/db-p2p/src/optimystic-node.ts`) — present exactly when `cohortTopic.enabled` built a host. It is the host-facing surface, unlike the node-internal registries, so it gets a type and no host needs `(node as any)`.

```ts
/** What a watcher knows about a collection's committed log: the tail block and the latest revision. */
export interface CollectionTail { readonly tailId: BlockId; readonly revision: number }

export interface CollectionWatchRequest {
	/** The collection id exactly as blocks carry it (`header.collectionId`, e.g. `app/users`). */
	readonly collectionId: string;
	/** Read the collection's committed tail now; `undefined` when the collection has never committed. */
	readonly readTail: () => Promise<CollectionTail | undefined>;
	/** Called once per detected change. Coarse: no payload, never awaited, a throw is logged. */
	readonly onChange: () => void;
}

export interface CollectionWatchHandle { close(): Promise<void> }   // idempotent

export class ReactivityCollectionWatch {
	watch(req: CollectionWatchRequest): CollectionWatchHandle;          // returns at once; never throws for network reasons
	stop(): Promise<void>;                                              // node teardown
}
```

`watch` must return immediately: the plugin calls it during table initialization, which must never wait on, or fail because of, the network. Everything below runs in the background.

### One subscription per collection per node

Several watches of one collection on one node (two `Database`s over one injected node) share one subscription: keyed by `collectionId`, holding a set of listeners and their `readTail` readers (any live one may be used). The subscription closes when its last handle closes. Sharing is also what keeps the node-level rotation scheduler's de-duplication by successor topic correct (`RotationReRegistrationScheduler.schedule`), since two subscriptions of one collection would share successor topics.

### Encoding — one helper, used on both sides

Add `reactivityCollectionIdBytes(collectionId: string): Uint8Array` (UTF-8) to `packages/db-p2p/src/reactivity/topic-bytes.ts`, beside `reactivityTailBytes`, with the same "load-bearing encoding contract" doc. Then:

- origination puts `bytesToB64url(reactivityCollectionIdBytes(event.collectionId))` on the notification. Add an optional `collectionId` to db-core's `OriginationContext` (default `event.collectionId`, so the mock harness, which already feeds base64url ids, is unchanged) and return it from the node's `resolveContext` in `libp2p-node-base.ts`;
- the watch service builds each manager with `collectionId: reactivityCollectionIdBytes(id)`, and passes the same base64url string to `recover.backfillTransport(topicId, …)` / `recover.resumeTransport(topicId, …)`;
- the forwarder's `PushState.collectionId` already comes from `n.collectionId`, so the recover serve's `pushStateForCollection` stays consistent with no change.

The existing real-socket resume case in `substrate-real-libp2p.integration.spec.ts` feeds the same string as both the event's collection id and the subscriber's; it must be changed to feed the raw id to the event and the encoded id to the subscriber.

### Building a subscription

`tailIdAtAttach = reactivityTailBytes(tail.tailId)`, `lastKnownRev = tail.revision`, `service = host.service`, `profile = host.profile`, `cohortHintCache = reactivityCohortHintCache`, backfill/resume transports from `reactivityRecover`, signers from `reactivityRecoverSigners`, `subscriberCoord` = the host's own ring coordinate if the host already exposes one (do not add a host API only for this; the manager's documented placeholder fallback is acceptable). Callbacks:

| Manager callback | Watch service does |
|---|---|
| `deliver(n)` | `onChange` for every listener; raise the subscription's `lastSeenRevision` |
| `onRotation(notice)` | remember `newTopicId → subscription`, then `reactivityRotation.schedule(notice)` |
| `onChainRead`, `onBackfillUnderflow`, `onCheckpointDigest` | `onChange`, then re-anchor (below) |
| `onTailRotated` | re-anchor |

Registration order on first attach: register the manager's `onNotification` in `reactivitySubscribers` for its topic, then `await manager.register()`. A failed registration leaves the subscription unattached and is retried on the next tick (below); the listener stays attached and the check below still wakes it.

### The renewal tick, and the check that backs everything up

One unref'd timer per subscription (mirror `defaultSetTimer` in `rotation-rereg-scheduler.ts`; injected `setTimer`/`now` for tests), at the manager's renewal cadence (TTL / 3: 30 s Core, 20 s Edge). Each tick:

1. `manager.renew()` if attached, else retry `register()`;
2. `readTail()` (one request for the plugin's reader);
3. tail id differs from the subscription's → re-anchor (move to the topic of the tail just read);
4. revision is above `lastSeenRevision` → `onChange` once, raise `lastSeenRevision`.

This bounds the damage of every failure this design cannot rule out — a lost notification, a missed rotation, a failed registration, an origination that never happened — to one tick of delay rather than a watcher that never wakes. It costs one tail read per watched collection per tick. Put a `NOTE:` at the timer saying so and naming the remedy (lengthen the interval, or skip the read on ticks where a notification arrived) if it ever shows up in traffic. Right after the first successful registration, do steps 2–4 once more: a commit landing between the caller's tail read and the registration reaching the cohort would otherwise go unnoticed until the next tick.

### Moving to a new topic (re-anchor and `reRegister`)

Both the scheduler's `reRegister(plan)` and a re-anchor go through one `moveTo(subscription, newTailBytes, lastRevision)`:

1. no-op if the subscription is already on that topic (a backstop re-anchor and a scheduled timer can both name the same successor);
2. build a new manager with `tailIdAtAttach = newTail`, `lastKnownRev = max(lastRevision, current manager's lastRevision)`;
3. register the new manager's handler in `reactivitySubscribers` **before** anything is unregistered;
4. `await newManager.register()`;
5. on success: unregister the old handler, `void oldManager.withdraw()` (logged on failure), switch renewals to the new manager;
6. on failure: unregister the new handler, keep the old subscription, log; the next tick retries.

Replace the node's placeholder `reRegister` in `libp2p-node-base.ts` (the "no subscribe factory is wired yet" log) with a dispatch through the `newTopicId → subscription` map into `moveTo`; an unknown topic (subscription closed meanwhile) is a logged no-op. Update every comment that defers to `quereus-tables-opt-in-to-network-change-notification` in `libp2p-node-base.ts`, `subscriber-registry.ts`, `rotation-rereg-scheduler.ts` and `subscription-manager.ts`.

### Teardown

`handle.close()` on the last handle: stop the timer, unregister the handler, `void manager.withdraw()`. `stop()` does this for every subscription and refuses new watches; call it from the node's existing cohort-topic stop wrapper ahead of `reactivityRotation.stop()` and `host.stop()`, declared up front and undefined-guarded like the other bindings there so a throw mid-wiring still unwinds it.

### Reading a collection's tail without a collection handle

The plugin needs a `readTail` that does not touch the table's own `Tree` (a background refresh of the table's tracker during an open transaction would replay its staged actions). Add a public static to `Collection` in `packages/db-core/src/collection/collection.ts`, built on the private `readLogEnds`:

```ts
/** The committed tail of `id` — header's tail block id and the tail's latest revision — in one request; undefined when never committed. */
static async readCommittedTail(transactor: ITransactor, id: CollectionId): Promise<{ tailId: BlockId; rev: number } | undefined>
```

It throws whatever `readLogEnds` throws (`BlockUnavailableError` and friends); the watch service logs a failed read and treats the tick as "no news".

## Edge cases & interactions

- **Watch, then close before registration finishes.** Close must win: when `register()` resolves after close, the service withdraws at once and registers no handler. Verify by inspection plus the unit test's close-during-register arm.
- **Rotation notice for a subscription whose move already happened** (backstop got there first) → `moveTo` no-op. Inspection.
- **Chained rotation OLD→A→B before A's timer fires** → two timers; the second `moveTo` moves from A to B or no-ops. Inspection; the scheduler already documents this.
- **`readTail` resolves `undefined`** (collection never committed): attach with no topic; each tick re-reads until a tail exists, then attaches. Inspection.
- **A node that both stores the tail and subscribes** receives each notification twice (subscriber role, then forwarder self-delivery). The db-core subscriber's `(collectionId, revision)` dedupe already collapses it; nothing to add. Inspection.
- **Node stop with watches open** → no timer fires after stop, no unhandled rejection from `withdraw` on closing transports. Inspection.
- **Edge-profile host** (`host.profile` Edge) subscribes but never forwards — unchanged behavior. Inspection.
- **React Native:** nothing new may import node-only modules; timers use the `unref?.()` guard. `yarn check:rn`.

## Tests

- **Unit, `collection-watch.spec.ts`** — the move ordering, which is the one piece of real branching and the contract the scheduler doc only writes down: with a fake `CohortTopicService` whose `register` is held pending, (a) a notification delivered to the new topic while the new registration is in flight reaches `onChange`; (b) the old handler is unregistered only after the new registration resolves; (c) a rejected new registration leaves the old handler registered and the new one removed; (d) closing during an in-flight registration leaves no handler registered. One `describe`, four `it`s.
- **Encoding pin** — extend `topic-bytes-encoding.spec.ts` with one case: the `collectionId` origination puts on a notification for collection `app/users` equals the base64url of the bytes the watch service hands its manager, and survives `validateNotificationV1`. This is the test that fails today.
- **Real network, `substrate-real-libp2p.integration.spec.ts`** — one case: a watch opened through `node.reactivityWatch` on one real node fires after a commit made through a real `NetworkTransactor` on another, with no hand-built commit certificate, no pre-cached membership certificate and no hand-built registration (those are what the existing cases fake). Nodes configured so every machine is in every cohort (see the blocked ticket `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`): `clusterSize` = node count, `cohortTopic.wantK` = node count, `cohortTopic.host.minSigs` ≤ node count. Make the watcher's `readTail` count its calls and assert the wake arrived before the first tick's read could have produced it (set the tick far out), so a pass cannot come from the fallback check. If this case fails for a cohort-topic reason outside this ticket (cold-topic admission, membership certificate publication), file a `fix/` ticket naming the exact failure and say so in the handoff; do not weaken the case.

## Docs

- `docs/reactivity.md` § Tail rotation: replace the "active subscribers then detect the rotation via the delivered `tailId` differing" claim with what a live node actually does (the tick's tail check re-anchors; the recover redirect moves a subscriber that resumes inside the drain window). § Real-libp2p e2e coverage: the watch service case, and the collection-id encoding.
- `docs/internals.md` § Cohort-Topic Origination Bridge: the "Tail rotation is now live" bullet (the scheduler is now driven) and the deferral sentences naming this work.

## TODO

- Add `reactivityCollectionIdBytes` to `topic-bytes.ts`; add the optional `collectionId` to db-core `OriginationContext` and use it in `buildNotificationV1`; return it from the node's `resolveContext`.
- Add `Collection.readCommittedTail` in db-core.
- Write `ReactivityCollectionWatch` (`collection-watch.ts`): shared per-collection subscriptions, the tick, `moveTo`, close and stop; export from `reactivity/index.ts`.
- Wire it in `createLibp2pNodeBase`: construct after the recover transport and the scheduler, route the scheduler's `reRegister` into it, add it to the stop wrapper, attach as `reactivityWatch`; add the typed optional field to `OptimysticNodeAttachments`.
- Update the deferral comments listed above.
- Fix the existing resume integration case's collection-id use.
- Unit spec, encoding pin, real-network case.
- Docs as above.
- `yarn build`, `yarn typecheck`, `yarn workspace @optimystic/db-p2p test`, `yarn workspace @optimystic/db-core test`, `yarn check:rn`, and the db-p2p integration suite with `OPTIMYSTIC_INTEGRATION=1`.
