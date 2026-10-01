description: Every network node now has one call an application can use to be woken when a collection changes anywhere on the network; it builds and renews the underlying subscriptions, moves them when the collection's log starts a new block, and falls back to an occasional cheap check so a lost message never leaves a watcher asleep.
architecture: docs/reactivity.md
files: packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/test/reactivity/collection-watch.spec.ts, packages/db-p2p/src/reactivity/topic-bytes.ts, packages/db-p2p/src/reactivity/origination-manager.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/src/reactivity/subscriber-registry.ts, packages/db-p2p/src/reactivity/index.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-core/src/reactivity/notification.ts, packages/db-core/src/reactivity/config.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/reactivity/topic-bytes-encoding.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/reactivity.md, docs/internals.md, docs/architecture.md, docs/debugging.md
----

# A node-level collection watch service

## What exists now

`ReactivityCollectionWatch` (`packages/db-p2p/src/reactivity/collection-watch.ts`) is built in the `cohortEnabled` block of `createLibp2pNodeBase` and exposed as the typed optional `reactivityWatch` on `OptimysticNodeAttachments`.

```ts
const handle = node.reactivityWatch.watch({
	collectionId: 'app/users',     // exactly as blocks carry it
	readTail: async (knownTailId) => { const t = await Collection.readCommittedTail(transactor, 'app/users', knownTailId); return t && { tailId: t.tailId, revision: t.rev }; },
	onChange: () => { /* coarse, no payload */ },
});
await handle.close();              // idempotent
```

- `watch` returns at once; reading the tail, registering with the cohort and everything after run in the background.
- **Open the watch, then read.** A commit the caller's read did not see wakes the watcher. The first committed tail the service reads for a collection wakes that collection's watchers once, whether or not anything changed.
- One subscription per collection per node, shared by every watch of it, closed with its last handle.
- A tick per subscription at the renewal cadence (30 s Core, 20 s Edge): renew, read the tail, wake if the revision is above the last one woken for, move if the tail block differs. This bounds a lost notification, a failed registration, an unannounced tail move and an unannounced commit to one tick of delay.
- A move registers the new topic's handler first, awaits the cohort registration, and drops the old handler and registration only on success.
- A notification names its collection by the base64url of the collection id's UTF-8 bytes (`reactivityCollectionIdBytes`), on both the sending and the subscribing side. Before this, a path-shaped id such as `app/users` failed wire validation on the receiving node.
- `Collection.readCommittedTail(transactor, id, knownTailId?)` in db-core reads the committed tail without opening a collection handle.

Design decisions and measurements from the build stage (first attach takes about 30 s; retrying sooner was measured and is slower) are recorded in `docs/reactivity.md` § The node's watch service, the `NOTE:` at the registration `catch` in `moveTo`, and backlog `feat-a-new-topic-admits-its-first-registration-without-a-second-ask`.

## Review findings

Read the diff of `ticket(implement): network-collection-watch-service` before the handoff, then every file it touched and the db-core code it calls (`subscriber.ts`, `rotation.ts`, `registration/renewal.ts`, `service.ts`).

### Fixed in this pass

- **A missed wake at watch open.** The first tail read set the baseline revision without waking anyone, on the assumption that it stood in for the caller's own read. The two reads are independent: a commit landing after the caller read the collection and before the service's first read was recorded as already seen and never reported, leaving the watcher stale until the next commit. The first read now goes through the same path as every later one and wakes the watchers once. The separate `start` method is gone. Contract ("open the watch, then read") is stated in the module doc, on `onChange`, and in `docs/reactivity.md` and `docs/internals.md`. One unit case added; the real-network case now expects exactly one wake before its first commit.
- **The one-request tail read no longer depends on each caller remembering state.** `readTail` now receives the tail block id the service's previous read found (`readTail(knownTailId?)`), so a host passes it straight to `Collection.readCommittedTail`. The handoff asked for this decision. The real-network case uses it; ticket `quereus-tables-opt-in-to-network-change-notification` was updated with the new closure and with a warning that its integration test must not mistake the first wake for the one it is proving.
- **Stale documentation.** `docs/architecture.md` still said reactivity was design-only, that notification delivery and the matchmaking query RPC were unwired, and that the participant register walk never runs over real sockets; the header of `substrate-real-libp2p.integration.spec.ts` said the same. Both now match the cases the spec actually runs (checked against its case list and a full run of the file). `docs/reactivity.md` said every watch shares one subscription manager; it is one subscription, with a manager per tail.

### Filed

- **Backlog `bug-a-participant-told-its-registration-is-unknown-never-registers-again`.** The handoff's "a registration the cohort lost is not re-made" gap is real and is not specific to this service: the renewal ping in db-core treats an "unknown registration" reply as success, while the cohort-side code comment says that reply is meant to send the participant back through its backups and the register walk. It also affects matchmaking providers, which have no fallback check. Read from the code, not reproduced. Nothing open claimed the site.

### Recorded as `NOTE:` tripwires

- `reRegister` in `collection-watch.ts`: a scheduled move for a tail the log has already left moves the subscription backwards; the tail read that follows returns it, at the cost of two registrations. Only matters if rotations come faster than the 30 s re-registration jitter.
- `enqueue` in `collection-watch.ts`: work on a subscription is serial, so a step that never settles would stall the fallback check too. The awaited calls are bounded by transport deadlines today.
- `renew` in `collection-watch.ts`: points at the backlog bug above.
- `BLOCK_FILL_SIZE_DEFAULT` in `packages/db-core/src/reactivity/config.ts`: reactivity assumes 64 commits per log block, the log uses 32 (`EntriesPerBlock`). Only log lines depend on it on a live node. Pre-existing; noticed while checking the rotation docs.

### Checked and left as is

- **Close during a move, in every order** (before the registration resolves, between it resolving and `moveTo` resuming, after a rejection): no handler stays registered, the old registration is withdrawn once, the late one is withdrawn when it lands. Read `moveTo` and `closeSubscription` together; the unit cases cover the first and third orders.
- **Node stop with watches open, `readTail` resolving `undefined`, two listeners on one subscription, a throwing `onChange`, a listener closing from inside `onChange`:** correct by reading; no test added, none of them has branching beyond what the existing cases exercise.
- **The scheduler dispatch (`onRotation` → `rotationTargets` → `reRegister`):** no unit case added. The plan's tail bytes and topic id come from one db-core function with the same hash `moveTo` uses, and the redirect-driven move is covered in `mesh-tail-rotation.spec.ts`; a case here would test the map lookup.
- **Escalations can wake twice, and a gap with no recover transport waits for the tick:** both over-fire or delay by one tick at worst, and the node always supplies the recover transport.
- **The implementer's six unit cases and the encoding pin:** each pins a stated contract with real branching (move ordering, failure arm, close wins, the `rebaseline` heal, the wire encoding). None cut.
- **Not looked into:** the handoff's observation that a node's `/membership` handler serves its latest certificate whatever coordinate is asked for, which could matter with several watched collections outside the every-machine-in-every-cohort configuration. That configuration is already the subject of blocked ticket `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`.

### Validation

- `yarn build`, `yarn lint`, `yarn lint:docs`, `yarn typecheck`, `yarn check:rn`: clean.
- `yarn workspace @optimystic/db-core test`: 1845 passing.
- `yarn workspace @optimystic/db-p2p test`: 3160 passing, 64 pending (pre-existing).
- `substrate-real-libp2p.integration.spec.ts` with `OPTIMYSTIC_INTEGRATION=1`: 12 passing, 2 pending (pre-existing skips); the collection watch case passed in two runs (35 s each).
- Not run: the rest of the db-p2p integration suite (unchanged since the build stage ran it), the Quereus plugin's suites, root `yarn test`.
