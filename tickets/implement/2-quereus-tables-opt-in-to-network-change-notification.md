description: Let a Quereus table declare in its schema that changes to it should be announced across the network, so that a watch on that table wakes on any machine when another machine writes to it — not only on the machines that happen to store the table.
prereq: network-collection-watch-service
architecture: docs/reactivity.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/types.ts, packages/quereus-plugin-optimystic/test/network-change-notification.integration.spec.ts (new), packages/quereus-plugin-optimystic/README.md, docs/internals.md, docs/reactivity.md
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-01T01:38:25.324Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\2-quereus-tables-opt-in-to-network-change-notification.implement.2026-10-01T01-38-25-322Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

# Quereus tables opt in to network change notification

## Where things stand

A table's watchers are woken today only by commits applied on the watcher's own machine: `OptimysticVirtualTable.ensureChangeSubscription` listens to its transactor's `onCollectionChange`, which for the `network` transactor is the node's own `StorageRepo`. A phone or laptop that does not store the table never wakes (`docs/internals.md` § Reactive Watch Bridge, "Host requirement").

The prerequisite ticket `network-collection-watch-service` gives every node built with `cohortTopic.enabled` a typed `node.reactivityWatch` that takes a collection id, a way to read the collection's committed tail, and a callback, and handles subscribing, renewing, moving to a new log tail and a fallback check. It also adds `Collection.readCommittedTail(transactor, id)` in db-core. This ticket is the plugin half: the declaration, the node option, and the vtab's use of the service.

## Decisions settled in planning

- **Spelling.** `with tags (optimystic.network_watch = true)`. Read with `=== true`, the rule Quereus's own per-table opt-in `quereus.sync.replicate` uses. Keys outside `quereus.` are free-form, and the plugin already persists table tags in its catalog record and restores them on `hydrate` (`copyTags` in `packages/quereus-plugin-optimystic/src/schema/schema-manager.ts`), so no engine change is needed. Any other value means off; no warning.
- **The tag controls subscribing only.** Whether a sending machine keeps per-collection state is decided by demand — whether anyone has subscribed — not by the tag (ticket `reactivity-forwarding-state-only-on-demand`). Machines that send may run no Quereus and never see the catalog, and notifications carry only "this collection changed at revision N" (no row data), so there is nothing a separate "publish" permission would protect that a reader of the collection cannot already learn by polling. No publish permission is added.
- **Lifetime.** A tagged table watches for as long as it is initialized: Quereus tells a vtab nothing when a watch is added or removed, so watching only while watches exist would need an engine change. The tag is the explicit consent that makes a table-lifetime subscription acceptable. Untagged tables behave exactly as today.
- **Double wakes are accepted.** On a machine that both stores the table and watches it, a remote commit wakes watchers twice — once from the storage listener, once from the network notification. Both are whole-table invalidations, so the cost is one extra re-query. Not suppressed; record it in `docs/internals.md` beside the existing "redundant self-wakeup" note.
- **Tag changes follow live.** `alter table … set tags`, and `apply schema` (whose differ emits that same statement for a tag-only change), never reach the module: Quereus swaps the in-memory table schema and fires `table_modified` on its schema manager's change notifier (`runSetTableTags` in `@quereus/quereus/src/runtime/emit/alter-table.ts`). `OptimysticModule` registers one listener on `db.schemaManager.getChangeNotifier()` and, for a `table_modified` of a table it holds, starts or stops that table's network watch to match the new tags. (That the plugin does not persist the edited tags across a restart is a pre-existing, separate defect: backlog `bug-optimystic-table-tag-changes-lost-on-restart`.)

## What to build

### Node option

- `LibP2PNodeOptions.cohortTopic?: NodeOptions['cohortTopic']` in `packages/quereus-plugin-optimystic/src/types.ts` (if `NodeOptions` is not reachable from the `@optimystic/db-p2p` entry, export it there rather than restating the shape), passed to `createLibp2pNode` in `CollectionFactory.createNetworkTransactor`.
- Plugin-level config key `cohort_topic` read in `resolveBinding` (`packages/quereus-plugin-optimystic/src/optimystic-module.ts`), validated like `declaredLinkRoundTripMs`: absent → undefined; an object whose `enabled` is a boolean → passed through; anything else throws naming the key. Plugin-level only: it configures the node, which every table on one network and port shares.
- `registerLibp2pNode` keeps `node.blockChangeNotifier` when the injected node has one (today it records only `{ node, coordinatedRepo }`, so an injected node loses local wakes as well).

The plugin-built node uses `clusterSize: 1`, so its commits never run consensus, carry no commit certificate, and are never announced (`docs/internals.md` § Cohort-Topic Origination Bridge: "No retained cert → the bridge skips origination"). Such a node can still *watch* — receive announcements of other machines' commits. Say this plainly in the README; do not change `clusterSize` here.

### The factory seam

`CollectionFactory.watchCollectionOverNetwork(options, collectionId, listener): Promise<(() => Promise<void>) | undefined>`:

- resolve the node the way `createNetworkTransactor` does (`getNodeKey(options)`), after `getOrCreateTransactor(options)` so the node exists;
- `undefined` when the transactor is not `network`, the node has no `reactivityWatch` (no cohort-topic host, or an injected node that was not built with one), or the transactor was registered directly (`registerTransactor`) with no node behind it;
- otherwise `node.reactivityWatch.watch({ collectionId, readTail, onChange: listener })` with `readTail = () => Collection.readCommittedTail(transactor, collectionId)` mapped to `{ tailId, revision }`;
- track each handle and close them all in `dispose()` (and so in `shutdown()`). This releases network watches when a host closes a `Database` and calls `plugin.dispose()` without dropping its tables — the leak backlog `optimystic-vtab-watch-db-close-teardown` describes for the local listener.

### The vtab

In `OptimysticVirtualTable`, beside the existing local subscription:

- `ensureChangeSubscription` (reached only on full initialization, never on the provisional committed-read pass) also starts the network watch when the table's tags say so. It must not await the network: `watch` returns at once by contract, and any failure is logged and leaves the local subscription working.
- No `reactivityWatch` available → log one warning per table ("tagged for network change notification but this node has no cohort-topic host; only local wakes") and continue.
- The network listener is the existing `handleCollectionChange` path (`notifyExternalChange`).
- `teardownChangeSubscription` (DROP TABLE) closes the network handle too.
- A setter the module calls on `table_modified`, starting or stopping the network watch idempotently.
- The schema tree and index sub-collections are never watched, as today (only the main collection id is subscribed).

## Edge cases & interactions

- **Initialization retried after a failure** (`docs/internals.md` § A failed first open is retried, not remembered): the network watch starts after the last await of a successful pass, guarded by the same subscribe-once flag, so a failed pass leaves nothing behind and a retry starts exactly one watch. Inspection.
- **Provisional (committed-read) initialization** never starts a watch; the upgrade to full initialization does. Inspection.
- **Tag turned on, off, on quickly** — the setter is idempotent and a close racing an in-flight start leaves no handle (the service guarantees close wins). Inspection.
- **Two `Database`s on one injected node watching one table** — the service shares one subscription; each table closes only its own handle. Inspection.
- **`mesh-test`, `test`, `local` and custom transactors** → no network watch, one warning, local behavior unchanged. Inspection.
- **`Database.close()` without `plugin.dispose()`** → network watch lives until the node stops; it calls `notifyExternalChange` on a closed database, which is already caught and logged. Record the added renewal traffic in the backlog ticket `optimystic-vtab-watch-db-close-teardown` (an arm has been appended there).
- **React Native:** `yarn check:rn` — nothing added may pull in node-only modules.

## Test — the real-network proof

`network-change-notification.integration.spec.ts`, gated on `OPTIMYSTIC_INTEGRATION`, shaped like `two-node-secondary-index-libp2p.integration.spec.ts`:

- three real libp2p nodes, each `createLibp2pNode({ … cohortTopic: { enabled: true, wantK: 3, host: { minSigs: 2 } }, clusterSize: 3 })` — every machine in every cohort, the only configuration in which announcements verify today (see blocked `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`);
- each node handed to its own plugin through `registerLibp2pNode`;
- the watching node's `blockChangeNotifier` replaced with an inert one before registration, so a wake on it can only have come over the network — the test must fail if the wake came from the storage listener;
- the table created `with tags (optimystic.network_watch = true)` on all three; a `Database.watch` on the watcher; an insert on another node; assert the watch fires within a bound shorter than the watch service's fallback tick (configure the tick far out, or assert on time), so the fallback check cannot pass the test either;
- one more assertion in the same case: an untagged sibling table's watch on the watcher does **not** fire after an insert into it within the same bound.

No unit tests: the tag read, the option passthrough and the factory seam are wiring.

## Docs

- Plugin README § Reactive Watching: the tag, what it costs (one subscription per tagged table, renewed about every 30 s, plus one tail read per renewal), the node option, the cohort configuration it currently needs, and that a plugin-built node can watch but not announce. § Plugin-Level Configuration: `cohort_topic`.
- `docs/internals.md` § Reactive Watch Bridge: "Host requirement" now has the network alternative; "Lifetime" covers the network watch and `dispose()`; the double-wake decision.
- `docs/reactivity.md` § Real-libp2p e2e coverage: the "still deferred" paragraph's `Database.watch` half is done.

## What the prerequisite actually shipped (added by `network-collection-watch-service`)

- `Collection.readCommittedTail(transactor, id, knownTailId?)` returns `{ tailId, rev }`. It costs one request only when `knownTailId` is the tail the header still names, and two otherwise. The watch service remembers the tail id its previous read found and hands it to `readTail` as its argument (changed in the review of `network-collection-watch-service`), so the factory's closure keeps no state: `readTail = async (knownTailId) => { const t = await Collection.readCommittedTail(transactor, collectionId, knownTailId); return t && { tailId: t.tailId, revision: t.rev }; }`.
- **The first tail read wakes the watcher once** (also changed in that review). The service cannot know what a caller read before its own first read, so the first committed tail it reads for a collection calls `onChange` whether or not anything changed. Two consequences here: the vtab must open the watch before the reads it is meant to keep fresh (starting it in `ensureChangeSubscription` does that), and the integration spec must not take that first wake for the one it is proving — wait for it (or for `isAttached`) before the insert, and count wakes from there.
- `node.reactivityWatch.isAttached(collectionId)` reports whether the collection's subscription holds a cohort registration. The integration spec needs it: a first attach took about 30 s on a three-node mesh, because a cohort defers the first registration under a topic nobody has registered under before and the service retries on its next tick (backlog `feat-a-new-topic-admits-its-first-registration-without-a-second-ask`). A commit made before the attach is reported by the fallback check, not by a notification.
- In a three-node cohort only the node that coordinates a commit announces it, and it sends the announcement to the registrations its own cohort engine holds. The watcher's registration reaches that node over cohort gossip (one round, 5 s by default) unless that node is the topic's primary. The db-p2p case (`collection watch over real libp2p` in `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`) waits for that before committing, and proves the wake came from a notification by counting tail reads; the same shape works here.
- There is no setting for the tick interval; "assert on time" or count `readTail` calls.

## TODO

- `cohortTopic` on `LibP2PNodeOptions`; `cohort_topic` parsed in `resolveBinding`; passed to `createLibp2pNode`.
- `registerLibp2pNode` keeps the injected node's `blockChangeNotifier`.
- `CollectionFactory.watchCollectionOverNetwork` with handle tracking released in `dispose()`.
- Vtab: tag read, start in `ensureChangeSubscription`, close in `teardownChangeSubscription`, the live-follow setter; module: the one `table_modified` listener.
- Integration spec as above.
- README and docs as above.
- `yarn build`, `yarn typecheck`, `yarn workspace @optimystic/quereus-plugin-optimystic test`, `yarn check:rn`, and the plugin's integration suite with `OPTIMYSTIC_INTEGRATION=1`.
