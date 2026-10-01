description: Every network node now has one call an application can use to be woken when a collection changes anywhere on the network; it builds and renews the underlying subscriptions, moves them when the collection's log starts a new block, and falls back to an occasional cheap check so a lost message never leaves a watcher asleep. This pass checks that work.
architecture: docs/reactivity.md
files: packages/db-p2p/src/reactivity/collection-watch.ts (new), packages/db-p2p/test/reactivity/collection-watch.spec.ts (new), packages/db-p2p/src/reactivity/topic-bytes.ts, packages/db-p2p/src/reactivity/origination-manager.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/src/reactivity/subscriber-registry.ts, packages/db-p2p/src/reactivity/index.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-core/src/reactivity/notification.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/reactivity/topic-bytes-encoding.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/reactivity.md, docs/internals.md, docs/debugging.md, tickets/backlog/feat-a-new-topic-admits-its-first-registration-without-a-second-ask.md
difficulty: hard
----

# Review: a node-level collection watch service

## What was built

`ReactivityCollectionWatch` (`packages/db-p2p/src/reactivity/collection-watch.ts`), constructed in the `cohortEnabled` block of `createLibp2pNodeBase` and exposed as the typed optional `reactivityWatch` on `OptimysticNodeAttachments`.

```ts
const handle = node.reactivityWatch.watch({
	collectionId: 'app/users',     // exactly as blocks carry it
	readTail: async () => { const t = await Collection.readCommittedTail(transactor, 'app/users'); return t && { tailId: t.tailId, revision: t.rev }; },
	onChange: () => { /* coarse, no payload */ },
});
await handle.close();              // idempotent
```

- `watch` returns at once. Reading the tail, registering with the cohort and everything after run in the background.
- One subscription per collection per node, shared by every watch of it, closed with its last handle.
- Work on one subscription (first attach, tick, escalation re-read, scheduled move) runs one step at a time. Notification delivery is outside that queue.
- A tick per subscription at the renewal cadence (TTL / 3: 30 s Core, 20 s Edge) on an unref'd timer: renew, read the tail, wake if the revision is above the last one woken for, move if the tail block differs.
- `moveTo` handles the first attach, a tick's re-anchor and the rotation scheduler's `reRegister`: new handler registered first, cohort registration awaited, old handler unregistered and old registration withdrawn only on success; on failure the new handler is removed and the old attachment is untouched.
- The node's placeholder `reRegister` ("no subscribe factory is wired yet") now dispatches into the service. The now-unused `reactivity-node-wiring` logger was removed and `docs/debugging.md` updated (new namespace `reactivity-collection-watch`).
- `stop()` runs first in the cohort-topic stop wrapper, ahead of the rotation scheduler and the host.

Two defects named in the ticket are fixed:

- **Collection id on the wire.** `reactivityCollectionIdBytes` (UTF-8) in `topic-bytes.ts`; origination puts its base64url on the notification through the new optional `OriginationContext.collectionId` (db-core) and `OriginationCollectionContext.collectionId` (db-p2p); the watch service builds managers with the same bytes.
- **Tail moves nobody announces.** The tick's tail check re-anchors. Docs corrected: a live subscriber does not detect a rotation from a delivered `tailId`.

`Collection.readCommittedTail(transactor, id, knownTailId?)` added in db-core.

## Where the result differs from the ticket text

Read these first; each is a judgment call.

- **`readCommittedTail` is one request only with a hint.** `readLogEnds` needs the tail id up front to batch it with the header. The method takes an optional third argument, `knownTailId`; without it the read is two requests. The watch interface is unchanged (`readTail` takes no arguments), so the caller's closure has to remember the last tail id. A note was added to ticket `quereus-tables-opt-in-to-network-change-notification` saying so, and the `NOTE:` at the tick timer states both costs.
- **A tail read also heals the manager (not in the ticket).** `ReactivitySubscriptionManager.rebaseline(revision)` was added and `moveTo` calls it when the subscription is already on the tail's topic. Without it, a gap the cohort cannot backfill leaves the manager's contiguity head stuck, and every later notification becomes another backfill request and another escalation. Covered by a unit case.
- **Tick order.** The tick wakes before it moves (the ticket lists move, then wake), so a slow registration cannot delay the wake. A failed registration is retried by the tick's tail check registering under the tail it just read, rather than by a separate "retry register" step; if that tick's tail read fails, nothing is retried until the next tick.
- **A follow-up tail read after every registration that lands,** not only the first. A move has the same window as a first attach: commits made while the registration is in flight are announced to a topic the cohort does not yet hold the subscriber under.
- **`watch()` after `stop()` returns an inert handle and logs,** rather than throwing.
- **`subscriberCoord`** is the base64url of the node's member-id bytes, which is what the cohort-topic service registers as `participantCoord`. It is not the FRET ring coordinate; the host does not expose one and no host API was added.
- **`liveOriginationContext`** was extracted from the node's inline `resolveContext` into `origination-manager.ts`, so the encoding pin exercises the function the node calls instead of a copy of it.
- **`setUnrefTimer`** is exported from `rotation-rereg-scheduler.ts` (was the private `defaultSetTimer`) and shared, instead of duplicated.
- **Diagnostics added:** `watchedCount` and `isAttached(collectionId)`. The real-network case needs `isAttached`.

## Tests added

`packages/db-p2p/test/reactivity/collection-watch.spec.ts` (fake cohort-topic service whose `register` is held pending, the real `ReactivitySubscriberRegistry`, an injected timer):

- *a notification on the new topic reaches onChange while the new registration is still in flight* — the new handler is live before the cohort answers.
- *keeps the old handler registered until the new registration resolves, then drops it* — the move ordering.
- *a rejected new registration leaves the old handler registered and removes the new one* — the failure arm.
- *closing during an in-flight registration leaves no handler registered and withdraws the registration when it lands* — close wins.
- *a tail read heals a gap the cohort could not backfill* — the `rebaseline` addition; fails without it.

`packages/db-p2p/test/reactivity/topic-bytes-encoding.spec.ts`:

- *a notification names a path-shaped collection id by the bytes the watch service registers under, and passes wire validation* — for `app/users`, the id `liveOriginationContext` puts on a notification equals the id in the watch service's registration payload, and `validateNotificationV1` accepts it. This is the case that failed before the change.

`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`:

- New `describe`, *collection watch over real libp2p*: three nodes with `clusterSize` 3, `cohortTopic.wantK` 3, `minSigs` 2. One node commits rows through its own `NetworkTransactor`; a watch opened through another node's `reactivityWatch` wakes. No hand-built commit certificate, cached membership certificate or hand-built registration. It passes only on a wake with no `readTail` call started between the commit and the wake.
- The two existing socket cases now feed the raw collection id to the event and the encoded id to the subscriber; the notify case also asserts the delivered `collectionId`.

## What the real-network runs showed

- **The wake crosses a real socket.** In a three-member cohort the two non-coordinating members apply a commit with two of three commit signatures, below the certificate threshold, so they retain no certificate and announce nothing (the `NOTE:` at `captureCommitCert` in `cluster-repo.ts`). Only the writing node announces, and the watcher is another node.
- **First attach takes about 30 s.** The cohort declines the first registration under a topic nobody has registered under ("retry after 1000ms"); the retry is the next tick. Timed runs attached 30.1 to 30.3 s after the watch opened.
- **Retrying sooner was built, measured and removed.** Retries at the cohort's named delay (1 s, 2 s, 4 s) made the attach land at about 60 s: a cohort allows one peer four register frames per topic per minute and a walk on a new topic sends two. Recorded as an accepted-tradeoff `NOTE:` at the registration `catch` in `moveTo`, and filed as backlog `feat-a-new-topic-admits-its-first-registration-without-a-second-ask`.
- **The test waits for two things before committing:** `isAttached`, and the watcher's registration appearing in the writing node's own cohort engine (it replicates over cohort gossip unless the writer is the topic's primary). The second wait reads a diagnostic; it fakes nothing. Before it was added, two of three runs produced no announcement-driven wake. The cause was not logged in those two runs; in the run that passed, the writing node's engine already held the registration when the commit was made.
- **The proof loop allows four commits.** An attempt with no wake in 10 s, or during which a tail read started, is repeated. In every run where it was printed (five) the first attempt proved it. One full-file run took 61 s instead of about 35 s and was not diagnosed.

## Known gaps

- **The scheduler path is covered by inspection only.** `onRotation` → `rotationTargets` → `reRegister` has no unit case, and no real-node case rotates a tail (that needs 32 commits and two stabilized topic cohorts).
- **Not tested, inspection only:** two listeners sharing a subscription; `readTail` resolving `undefined`; node stop with watches open; an Edge-profile host; the chained OLD→A→B rotation.
- **Escalations can wake twice.** `onChainRead`, `onBackfillUnderflow` and `onCheckpointDigest` wake at once, and the re-read they queue wakes again if it finds a newer revision. Harmless for whole-table invalidation.
- **Withdraws are fire-and-forget,** as the ticket specifies, so on node stop the tombstone can lose the race with the transports closing; the cohort then frees the registration at TTL expiry.
- **A registration the cohort lost is not re-made until the tail moves.** Read from the code, not reproduced: the renewal ping treats an `unknown_registration` reply as success (`onPingSuccess` in `packages/db-core/src/cohort-topic/registration/renewal.ts`). One way to get there is closing a watch and reopening it while the first registration is still in flight, so the old registration's withdraw tombstone lands after the new registration. The watcher still wakes on the tick. Not ticketed; a reviewer may judge it worth one.
- **Not verified beyond one watched collection per mesh.** While reading the host: its `/membership` handler serves the node's most recently published certificate whatever coordinate is asked for. With several watched collections a node runs several topic engines. In the every-machine-in-every-cohort configuration each node verifies against certificates it published itself, so this should not matter there; it was not exercised.
- **Stale statements left alone (pre-existing, outside this ticket's doc list):** the reactivity row and paragraph in `docs/architecture.md` § rollout table still say socket delivery is unwired, and the file header of the integration spec says the same.

## Validation run

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs`: clean.
- `yarn workspace @optimystic/db-core test`: 1845 passing.
- `yarn workspace @optimystic/db-p2p test`: 3159 passing, 64 pending (pre-existing).
- `yarn check:rn`: passed.
- db-p2p integration suite with `OPTIMYSTIC_INTEGRATION=1`: 45 passing, 2 pending (pre-existing skips).
- Not run: the Quereus plugin's unit and integration suites (the plugin does not use the new surface yet), and root `yarn test`.

## Suggested checks for the reviewer

- Read `moveTo` and `closeSubscription` together for the close-during-move interleavings, including a close that lands between the registration resolving and `moveTo` resuming.
- Decide whether the `readCommittedTail` hint should instead be threaded through the watch interface (`readTail(knownTailId?)`), so the service, which knows the tail it is attached under, supplies it.
- Decide whether the unit spec should gain a case for the `reRegister` dispatch (unknown successor is a no-op; known successor moves).
- Check the wording of the three doc edits against the code: `docs/reactivity.md` § Subscription (new "The node's watch service"), § Tail rotation, § Real-libp2p e2e coverage; `docs/internals.md` § Cohort-Topic Origination Bridge.
