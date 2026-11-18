description: Let a machine join a network as a pure client that reads and writes through the network's storage machines but never stores blocks for others or takes part in agreeing on their writes. In networks with many phones or browser tabs, this keeps sleeping or read-only devices off the critical path of other people's writes.
prereq: a-peer-is-judged-serving-only-by-its-own-identify
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`, `createLibp2pNodeBase`: the four storage services in `services`, `wired.repo.setLibp2p`, `preparedStreamProtocols`, the serving-only span from `fetchArchiveFromPeer` through the owned-block seed and dispute, the attachments literal, the cohortTopic block), packages/db-p2p/src/optimystic-node.ts (`OptimysticNodeAttachments`, `OptimysticNode`), packages/db-p2p/src/libp2p-node.ts and packages/db-p2p/src/libp2p-node-rn.ts (`createLibp2pNode`), packages/db-p2p/src/libp2p-key-network.ts (`selfServes` doc comment), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`FactoryNode`, `libp2pNodes`, `getRepo`), packages/reference-peer/src/cli.ts, packages/db-p2p/test/node-service-set.spec.ts, packages/db-p2p/test/*.integration.spec.ts, docs/internals.md, docs/optimystic.md (§Running a Node), docs/architecture.md, packages/db-p2p/src/repo/under-replication-drain.ts (`pushablePeers` NOTE)
difficulty: hard
----

# Client-only node: `NodeOptions.servesBlocks: false`

Requested by Sereus (`../sereus/tickets/blocked/strand-node-that-holds-no-blocks.md`, and GitHub sereus#63 from the application side): let a node opt out of holding blocks and signing commits while still reading and writing through the network. The default stays `true`, unchanged.

## What already holds, and what this ticket adds

Cohort selection already supports a node that does not serve. `Libp2pKeyPeerNetwork.selfServes` applies the same protocol test to self that `membershipOf` applies to peers; with it false, `assembleServingCohortAt` drops self from every band, so the node is in no cohort (`findCluster`, `servingCohortAt`), never a coordinator pick (`selfReadVerdict` and the last-resort self tier both require self in the cohort), and `findCoordinator` throws `FindCoordinatorError` when no serving peer is reachable. `CoordinatorRepo.fetchBlockFromCluster` already notes "a client-only libp2p node, which runs no CoordinatorRepo". `test/libp2p-key-network.spec.ts` pins both cohort cases ("a node that does not serve this network is in no cohort…", "…never coordinates, for a read or a write").

The prerequisite ticket makes the other side hold: a client's own repo requests no longer make the servers it talks to classify it as serving. Without it, every server a client talks to would put the client in its cohorts.

What is missing, and is this ticket: a supported way to build that node, with every subsystem that assumes local blocks left off.

## The option

```ts
/**
 * Whether this node stores blocks for the network and takes part in agreeing on writes. Default true.
 * false: a client. It registers none of the four storage protocols (repo, cluster, sync,
 * block-transfer), so every other node of this build classifies it as not serving from its identify
 * list, it is in no cohort, and it never coordinates. Its reads and writes go to the network's
 * serving machines. See docs/internals.md §Client nodes.
 */
servesBlocks?: boolean;
```

## The node a client builds

Every subsystem `createLibp2pNodeBase` builds, and whether a client builds it. The implementer keeps this table in docs/internals.md §Client nodes.

| Subsystem | Client |
|---|---|
| link deadlines, cluster policy (`consensusConfig`), bootstrap targets | yes — the key network reads `clusterSize` and the deadlines |
| `resolveStorage` (raw block store, its read-cache lease), `resolveDurabilityWindowPolicy`, `logStorageDurability` | no |
| `kvStore` | yes — holds the HLC clock's high-water mark, the only thing a client persists |
| `KvUnderReplicationLedger` | no |
| `HlcClock` | yes — the client mints the HLC of every write it sends (`node.hlcClock` → `NetworkTransactorInit.clock`) |
| `StorageRepo`, `repoProxy`, `clusterProxy` | no |
| libp2p services `cluster`, `repo`, `sync`, `blockTransfer` | **not registered**; `wired.repo.setLibp2p` skipped |
| libp2p services `identify`, `identifyPush`, `ping`, `dcutr` (by `holePunchingWanted`), `autoNAT`, `relay` (when `relay: true`), `networkManager`, `fret` | yes, unchanged — FRET joins the ring at the embedder's `fretProfile` |
| bootstrap contact, identify progress, identify-on-open, protocol-merge throttle, the prerequisite's storage-claim filter, relay supervisor | yes |
| reputation, membership gate (`isNetworkMember`), key network, cohort reachability gate | yes — the client still chooses coordinators and the offline queue still asks the gate |
| `PreparedStreams` | yes, for `repo` only — the one protocol a client sends steady requests on |
| `fetchArchiveFromPeer`, `blockLineageCallback`, `reconcileBlock`, `deriveExpectedCluster`, `ClusterMember`, `CoordinatorRepo`, `clusterLatestBatchCallback`, transaction-state recovery | no |
| `clusterLatestCallback` | only when `cohortTopic.enabled`, for the commit-log trust anchor; built without the self-read branch (a client is never in a root group; answer a self ask with `undefined`) |
| owned-block feed and seed, spread-on-churn, under-replication drain, Arachnode (ring announce, storage monitor and its 60 s interval, restoration coordinator, rebalance monitor, block-transfer coordinator, ring shift) | no — a client announces no Arachnode ring, so ring-based restoration and ring shifts never pick it |
| `reportBlockHeld` | no (not on the client's surface) |
| dispute service | no |
| cohort-topic host, reactivity subscriber registry, forwarder host, rotation scheduler, push-state gossip, watch service, matchmaking handlers and arrival push | yes when `cohortTopic.enabled` |
| cohort-topic `CommitCertStore`, the origination change bridge (`attachCohortChangeBridge` over `storageRepo`) | no — a client applies no commits, so it originates nothing |
| watch service `localChanges` | omitted (it is optional) |

"Peer-join catch-up" in the original request is Sereus's own (`peer-join-backfill.ts`); it runs on the machine delivering blocks, which a client never is, and is Sereus's to gate.

**Options that only configure serving subsystems are ignored on a client**, the convention `relayServerInit` already follows when `relay` is off: `storage`, `storageDurability`, `transactionStateStore`, `validator`, `onCommitCertificate`, `dispute`, `blockTransfer`, `rebalance`, `spreadOnChurn`, `underReplicationDrain`, `arachnode`, `authorizeInboundStream`, `authorizeInboundStreamTimeoutMs`. Refusing them was rejected: an embedder setting the role per node (Sereus's `NodeRoles`) builds one options object and flips one flag, and a block store left on disk by a former serving role is harmless and still there if the role flips back. The node logs one `node-wiring` line naming each such option it was given and ignored, so a host that expected one to take effect can see why it did not. Implement the list as one literal array of option names in one function so a serving-only option added later is added in one place.

Structure: the serving-only span is several hundred contiguous lines inside the post-start `try`. Gate it as one unit — preferably by extracting it into a function returning what the rest of the factory reads (`coordinatedRepo`, `storageRepo`, `reportBlockHeld`, `clusterLatestCallback`), with each stop wrapper still installed immediately after its resource as the startup-rollback rule requires — rather than scattering a dozen `if`s. Do not take on the general refactor of backlog `debt-node-factory-wiring-steps-own-their-teardown`.

## The node's type

`createLibp2pNode` returns either shape, discriminated on `servesBlocks`:

- `OptimysticNodeAttachments` (serving) gains `servesBlocks: true`; nothing else changes, so every existing caller and test reads `node.storageRepo` as before.
- New `OptimysticClientNodeAttachments`: `servesBlocks: false`, `keyNetwork`, `reputation`, `peerPrivateKey`, `linkDeadlines`, `cohortReachability`, `hlcClock`, `reactivityWatch?`, `matchmakingArrivalPush?`. No `storageRepo`, `coordinatedRepo`, `blockChangeNotifier`, `disputeService`, `reportBlockHeld`. Put the shared fields in one base interface both extend.
- `OptimysticClientNode = Libp2p & OptimysticClientNodeAttachments`.
- `createLibp2pNode` (both `libp2p-node.ts` and `libp2p-node-rn.ts`) gets overloads: `servesBlocks: false` → `OptimysticClientNode`; `servesBlocks?: true` → `OptimysticNode`; plain `NodeOptions` → the union. `createLibp2pNodeBase` returns the union.
- No `blockChangeNotifier` on a client because nothing lands in its storage; `NetworkTransactor` already treats an absent `localChangeNotifier` as a no-op subscription. A client wakes on other machines' commits only through `reactivityWatch` (the `optimystic.network_watch` table tag in SQL) or by reading — the "Host requirement" paragraph of docs/internals.md §Reactive Watch Bridge already says edge nodes that host no blocks fetch or poll; point it at §Client nodes.

Consumers:

- `CollectionFactory` (Quereus plugin): `FactoryNode` must accept a client node (its `servesBlocks` literal conflicts with `Partial<OptimysticNodeAttachments>` as written); `libp2pNodes`' `coordinatedRepo` becomes optional; `getRepo` for this node's own peer id throws a clear error when the node has no coordinated repo — unreachable by construction, since a client is never picked, so the throw is the assertion. `stateHoldingsOnReads` is already skipped when `node.storageRepo` is absent. The plugin's own node builder (`createNetworkTransactor`) keeps building a serving node; a host that wants a client builds the node and hands it to the plugin as it already can. No new plugin option.
- `packages/reference-peer/src/cli.ts` reads `node.storageRepo` and `node.coordinatedRepo`; it builds serving nodes only, so narrow on `servesBlocks` or keep its options typed serving — whichever compiles cleanly without casts.

## How the node relates to `isNetworkMember`

Two different statements, by two different parties:

- `servesBlocks: false` is a node saying of itself "I hold nothing". Every peer on a build with the prerequisite honours it with no configuration, from the client's identify list.
- `isNetworkMember` is a node's own policy about others: "of the peers that claim to serve, only these count". It exists to keep strangers out, and a node applies it to its own choices only.

An embedder with a read-only role (Sereus's officer dashboard browser, voters' phones) sets `servesBlocks: false` on that machine. It does not need a refusal predicate for it — Sereus can drop its `controlCohortRefusal` / `strandCohortRefusal` patch and its edge-node identify-gate withdrawal — EXCEPT while any serving machine of the network still runs a build without the prerequisite, which classifies a client by its streams; keep the predicate until every serving machine is upgraded. Write this into docs/internals.md §Client nodes.

## Settled questions

**No serving peer reachable.** A client write cannot commit locally and does what a write whose cohort is unreachable already does: `NetworkTransactor.pend` resolves coordinators through `coordinatorCover`, `findCluster` returns an empty cohort, the block falls to `findCoordinator`, which waits out its existing bounded retry window (up to three attempts 500 ms apart while a connection or dial could still change the answer, and `assembleServingCohortAt`'s bounded wait while a bootstrap peer's contact is imminent) and then throws `FindCoordinatorError` — `NO_NETWORK_COORDINATOR` when the only peers it saw were unconfirmed or foreign, `NO_COORDINATOR_AVAILABLE` otherwise. `Collection.sync` does not absorb it (it is not a `StaleFailure`), so the write fails, retryably; `Tree.replace` and `Diary.append` unstage. Under the offline queue the reachability gate (`KeyNetworkCohortReachability`) reads an empty cohort as closed, so a queued entry waits for a serving machine rather than failing — "pending until a serving machine is reachable", which is what Sereus's offline-writes question needs. No new waiting mechanism.

**Network and collection creation.** A client cannot found a network alone, and must not report a collection absent when it simply asked nobody. The header probe of `Collection.open` / `createOrOpen` goes through `NetworkTransactor.get`, which resolves coordinators before its `try` (`createBatchesForPayload` in `packages/db-core/src/utility/batch-coordinator.ts` awaits `findCoordinator` uncaught) and so rethrows `FindCoordinatorError` rather than returning an empty answer: `createOrOpen` rejects and invents nothing, `open` rejects rather than resolving `undefined`. Bootstrap contact applies as on a serving node: a client configured with a bootstrap peer waits for it the same bounded time before its cohort is judged empty. Pin this with a test (below); if the test shows the error converted into an absent answer anywhere, that conversion is the bug to fix, into `BlockUnavailableError` with reason `'cohort-unreachable'`.

**Declared membership.** `backlog/feat-declared-membership-feeds-cohort-assembly` gets an arm (added by the plan pass that wrote this ticket): a declared list must not name client nodes.

**Transient misclassification.** A client never reads as serving to a peer on a build with the prerequisite, with one window: a machine that served and is switched to client under the same peer id reads, to peers that knew it, like an offline serving peer (stale peerStore list, remembered verdict) until its next connection's identify replaces the list, which also clears the remembered verdict and persists the clearing. Until then it can sit in their cohorts as a silent member — the same cost as a serving peer that went offline, bounded the same way (its reconnect, or FRET declaring it dead). Not worth more machinery; documented.

**What a client write costs.** A client coordinates nothing, so each write is requests to a remote coordinator: the refresh (one `repo` get per collection when nothing new committed), the pend, and the commit — one request each when one coordinator covers every block, the usual case in a group no larger than a cohort — plus the cohort's own consensus rounds, which run between serving machines over their links, not the client's. So a client write costs about three round trips on the client's link plus the serving cohort's commit time. The reporter's interim patch, which let such a machine coordinate its own writes, measured about 120 ms for a registration write; this design trades that for never putting the machine in anyone's cohort. Measure the client's request count for one write on the integration fixture below and record it in §Client nodes; do not publish a millisecond figure unless one is measured. Reads cost the same way: every read is remote, so an idle poll costs one request per tree, where a serving machine in the cohort answers locally.

## Limits that stay (recorded, not built here)

- **Clients still occupy the ring.** FRET is unchanged, so a client is a ring member, and the key network cuts each cohort from a band of `max(4 × clusterSize, clusterSize + 16)` ring members nearest the key (`membershipOverfetch`). At the default `clusterSize` of 10 a cohort is full only where at least 10 of the 40 ring members nearest the key serve; a ring that is mostly clients leaves cohorts short or empty, which a wider band drawn from the local FRET table cannot fix reliably. So this ticket serves a network with a minority of clients (Sereus's control network, a strand with some read-only machines); the "tens of thousands of phones" strand needs `blocked/clients-in-the-ring-crowd-out-serving-peers`. Say this in §Client nodes and in the `NOTE:` at `membershipOverfetch`.
- **Cohort-topic tiers below a root** are FRET cohorts, so a client with `cohortTopic.enabled` can still be a member of one (registrations, notification fan-out). Same blocked ticket.
- **Under-replication ledger entries naming a machine that became a client** never settle, the shape the `NOTE:` at `UnderReplicationDrain.pushablePeers` already records for a refused peer; extend that note to name the role switch.
- **Spread-on-churn** pushes to FRET neighbours without checking they serve, so it wastes pushes on clients: `backlog/debt-fret-direct-senders-push-to-peers-that-store-nothing`.

## Edge cases & interactions

- **Self coordination** — the client is never in a cohort, so `getRepo(self)` is unreachable (by the type and the plugin's throwing guard).
- **`findCoordinator`'s connected fallback** may pick a connected serving peer outside the key's cohort; that peer redirects or refuses as for any writer (by inspection, unchanged).
- **The offline queue and `refuseSoloCommit`** — a client never commits alone; the gate is closed with no serving peer (by inspection; the integration test's no-server case covers the transactor side).
- **The commit-log trust anchor** asks the root group, which never contains the client, so the client variant of `clusterLatestCallback` never takes a self branch (assert by an early `undefined` for a self ask).
- **The watch service on a client** — subscription, renewal and tail reads all go remote: renewals to the root group through the cohort-topic router, tail reads through the transactor the host passes (`committedTailReader` over a `NetworkTransactor`), whose reads take the remote path above. Nothing in it needs local storage once `localChanges` is omitted; verified by the integration test's watch case.
- **Startup rollback** — a client installs fewer stop wrappers; every resource it does build still has its wrapper installed right after it (by inspection; `test/startup-rollback.spec.ts` keeps passing).
- **`assertClusterSizeCoupling`** still runs (key network and network manager are built on a client).
- **Mixed versions** — see the `isNetworkMember` section.
- **Role flip** — a node rebuilt as serving after running as client finds its old block store as it left it (nothing a client wrote touched it) and catches up through ordinary repair.

## Tests

Mind *Tests must pay for themselves*: no unit tests of which wrapper is installed or which field is absent — the type does that.

- `test/node-service-set.spec.ts`: add a `servesBlocks: false` case with its own written-out literal (the serving literal minus `blockTransfer`, `cluster`, `repo`, `sync`). This spec exists to make the service map a deliberate change.
- One real-socket spec, gated on `OPTIMYSTIC_INTEGRATION=1` like the other `*.integration.spec.ts` in `packages/db-p2p/test` (reuse the fixture style of `multi-coordinator-write.integration.spec.ts` or `small-deployment-lifecycle.integration.spec.ts`): two serving nodes and one client, client bootstrapped to a server.
  - The client writes through a `NetworkTransactor` built the way `CollectionFactory` builds one (a `Diary` append or `Tree.replace`) and reads it back; a server reads the same content. Expect the write to succeed and both servers to hold it.
  - After that traffic, each server's `keyNetwork.findCluster` for the written blocks does not name the client, and `findCoordinator` on a server never returns it. This is the end-to-end reproduction of the prerequisite's defect: it fails without it.
  - Count the client's outbound `repo` requests for one write (wrap `getRepo`), and record the number in docs.
  - A lone client with no serving peer: `Diary.createOrOpen` (or `Collection.createOrOpen`) rejects with `FindCoordinatorError`, and `open` does not resolve `undefined`.
  - With `cohortTopic.enabled` on all three: the client opens `node.reactivityWatch.watch` on the collection; a server commits; the client's `onChange` fires. Skip this arm if the existing cohort-topic integration fixtures (`substrate-real-libp2p.integration.spec.ts`) show a three-node reactivity case cannot be made reliable in the integration budget, and say so in the review handoff.

## TODO

- `NodeOptions.servesBlocks` with the doc comment above.
- Gate the four storage services and `wired.repo.setLibp2p`; prepared streams for `repo` only on a client.
- Gate storage resolution, the ledger, `StorageRepo`, the serving-only post-start span (extracted as one unit), Arachnode, dispute, and the cohort-topic origination pieces; build the client `clusterLatestCallback` for the trust anchor.
- The ignored-options list, its one log line.
- `OptimysticClientNodeAttachments`, the shared base interface, `servesBlocks: true` on the serving attachments, `OptimysticClientNode`, and the `createLibp2pNode` overloads in both entries; export the new types from the package entry points.
- `CollectionFactory` and `reference-peer` adjustments.
- Update the `selfServes` doc comment in `libp2p-key-network.ts` (the `false` branch is now a supported configuration, not only defence in depth) and the `NOTE:` at `membershipOverfetch`; extend the `NOTE:` at `UnderReplicationDrain.pushablePeers`.
- docs/internals.md: new subsection **§Client nodes** right after §Network Membership Predicate — the option, the subsystem table, ignored options, the type, the `isNetworkMember` relationship and mixed versions, the four settled questions, the cost (with the measured request count), and the limits with their tickets. Point §Reactive Watch Bridge's "Host requirement" at it.
- docs/optimystic.md §Running a Node: the existing "Client-only" bullet is about inbound connections; rename it "Dial-only" and add a "Client (holds no blocks)" bullet showing `servesBlocks: false`.
- docs/architecture.md §Topology & Storage Management: one paragraph pointing at §Client nodes.
- `yarn build`, `yarn typecheck`, `yarn test`, `yarn test:integration`, `yarn lint:docs`, `yarn check:rn` (the RN entry gains an overload).
