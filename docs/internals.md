# Optimystic Internals

A condensed guide to internal architecture, invariants, and pitfalls for developers and AI agents.

## Data Flow

### Read Path (Block Retrieval)
```
Collection.selectLog()
  → Tracker.tryGet(blockId)        # Applies pending transforms to source block
    → CacheSource.tryGet(blockId)  # Returns structuredClone of cached block
      → TransactorSource.tryGet()  # Fetches from network/storage
        → BlockStorage.getBlock()  # Materializes block at revision
          → materializeBlock()     # Finds materialized block + applies transforms
```

### Write Path (Local Changes)
```
Collection.act(action)
  → actionHandler(action, tracker)  # Handler mutates blocks via tracker
    → apply(tracker, block, op)     # Mutates block AND records operation
      → applyOperation(block, op)   # Direct mutation via splice/assignment
      → tracker.update(blockId, op) # Records op in transforms.updates
```

### Commit Path (Distributed Consensus)
```
Collection.sync()
  → NetworkTransactor.transact(transforms)
    → pend() to all block clusters     # Two-phase: promise collection
    → commit() to log tail cluster     # Two-phase: consensus + commit
      → ClusterCoordinator.update()    # Coordinates with cluster peers
        → ClusterMember.update()       # Each peer votes
          → handleConsensus()          # Winner executes operations
            → StorageRepo.pend/commit  # Applies to local storage
```

### Change Notification (Reactive Wake)

`StorageRepo` implements `IBlockChangeNotifier` (db-core). It is the single commit
funnel for both the coordinated and direct paths, so it originates a per-collection
"this collection changed" signal that lets reactive consumers wake without polling.

```
StorageRepo.commit()                       # critical section (block locks held)
  → internalCommit() returns collectionId  # newBlock.header ?? priorBlock.header (delete)
  → release locks (finally)
  → emitCollectionChanges()                # one CollectionChangeEvent per distinct collection
StorageRepo.get()                          # read-driven promotion (context proves committed)
  → internalCommit() returns collectionId  # promotes a pending action that landed durably
  → emitPromotions()                        # group by (actionId, rev), emit per group
```

- Subscribe via `onCollectionChange(collectionId, listener)` → idempotent unsubscribe.
- Events fire **after** locks release, synchronously in commit order, fire-and-forget
  (never awaited); a throwing listener is isolated + logged. Ordering across concurrent
  commits / across collections is **not** guaranteed.
- **Emission guarantee (Option A — emit eagerly):** a `CollectionChangeEvent` fires
  once for every block that becomes **durably committed** on this node, regardless of
  whether the enclosing `commit()` ultimately reports `success: false`, and regardless
  of whether the landing happened on a `commit()` or on a `get()`-driven promotion.
  Concretely this covers: (a) blocks `1..N-1` that landed before a mid-loop
  `internalCommit` throw on block `N` (the failed attempt emits for what landed; the
  retry rolls `N` forward and emits for it), and (b) a pending action promoted during a
  `get()` whose `context` proves it committed. Idempotent `alreadyDone` re-landings and
  stale partitions never emit, so each `pending → committed` transition emits exactly
  once. The consumer does coarse whole-table invalidation, where over-firing costs only
  a re-query but a missed wake serves a stale view indefinitely — hence the asymmetry
  favors liveness.
- Exposed on the node as `(node as any).blockChangeNotifier`. `NetworkTransactor`
  re-exposes it via an optional `localChangeNotifier` ctor option (no-op when absent).

#### Reactive Watch Bridge (Quereus vtab)

The `quereus-plugin-optimystic` virtual table bridges these notifications to
Quereus's reactive watch API, so a (remote or local) commit wakes
`Database.watch` / subscribe consumers without polling:

```
StorageRepo.commit → CollectionChangeEvent → transactor.onCollectionChange
  → OptimysticVirtualTable listener → Database.notifyExternalChange(table)
    → Quereus watchers fire (coarse, whole-table invalidation)
```

- **Transactor wiring.** `CollectionFactory` feeds the notifier into each
  transactor: the `network` transactor receives `node.blockChangeNotifier` as
  `localChangeNotifier`; the `local`/`test` transactors are themselves
  `IBlockChangeNotifier`s delegating to their `StorageRepo`. `mesh-test` is
  unwired (its `NetworkTransactor` gets no `localChangeNotifier`, so the
  subscription is an inert no-op). A transactor that can't observe local commits
  degrades gracefully — the consumer keeps fetching/polling.
- **Subscription identity.** The vtab subscribes to exactly one collection id —
  `CollectionFactory.getCollectionId(options)` = `parseCollectionId(collectionUri)`
  = the URI path (`tree://app/users` → `app/users`). This equals the
  `header.collectionId` stamped on every block (`TransactorSource.createBlockHeader`)
  and therefore the `CollectionChangeEvent.collectionId`. Index sub-collections
  (`<uri>/index/<name>`) carry their own ids and are NOT separately watched —
  whole-table invalidation re-queries them anyway. The schema tree
  (`tree://optimystic/schema`) is skipped (schema writes aren't data-watch events).
- **Coarse invalidation.** `notifyExternalChange` fires every matching watcher as
  a global whole-table change: `full` watches fire with empty hits, `rows`/
  `rowsByGroup` watches surface their registered literals as possibly-changed.
  Over-firing only costs an extra re-query; it never misses a change.
- **Redundant self-wakeup (accepted in v1).** On a node that BOTH hosts AND
  authors a write, the local Quereus commit fires watchers precisely (tuple-level)
  via the normal post-commit path AND the storage funnel fires a coarse
  `notifyExternalChange`. The second is redundant but harmless. v1 does not attempt
  author-suppression; a future refinement could tag events with the authoring
  peer/actionId and let the vtab skip events it just authored.
- **Lifetime.** The subscription is established once after table init and released
  in `OptimysticModule.destroy` (DROP TABLE). It is deliberately NOT released in
  the per-statement `disconnect()` (a no-op that keeps the table initialized across
  statements) — doing so would kill reactivity after the first scan. Closing a
  `Database` without dropping its tables leaves the storage listener attached until
  the `CollectionFactory` is GC'd; its dispatch becomes a logged no-op once the
  `Database` is closed.
- **Host requirement.** Only nodes that host the collection's blocks observe these
  commits. Edge/client nodes that don't host blocks receive no push subscription
  and still fetch/poll.

## Mutation Contracts

### Functions That MUTATE In-Place
| Function | Mutates | Notes |
|----------|---------|-------|
| `applyOperation(block, op)` | block | Caller must clone if original needed |
| `applyOperations(block, ops)` | block | Calls applyOperation for each |
| `applyTransform(block, transform)` | block | Uses applyOperations internally |
| `apply(store, block, op)` | block | Also records op in store.transforms |

### Functions That CLONE
| Function | Returns | Notes |
|----------|---------|-------|
| `withOperation(block, op)` | new block | Safe alternative to applyOperation |
| `CacheSource.tryGet()` | structuredClone | Prevents cache corruption |
| `Tracker.tryGet()` for inserts | structuredClone | Inserts are cloned on retrieval |

### Storage Clone Requirements
**Memory storage MUST clone on get/save** to prevent cross-revision contamination:
```typescript
// CORRECT - memory-storage.ts
getMaterializedBlock(): return structuredClone(stored);
saveMaterializedBlock(block): store(structuredClone(block));
```

## Key Invariants

### Block Identity
- `blockId` = content-addressed ID (base64url), immutable
- `actionId` = transaction identifier, unique per commit
- `rev` = revision number, monotonically increasing per block

### Transform Ownership
- `Transforms.updates[blockId]` arrays must NOT be shared between consumers
- `copyTransforms()` and `transformForBlockId()` must deep-clone arrays
- JSON serialization over network creates implicit deep copies

### Consensus Execution
- `handleConsensus()` executes on ALL cluster peers, not just coordinator
- `executedTransactions` map prevents duplicate execution (keyed by messageHash)
- Different operations (pend vs commit) have DIFFERENT messageHashes
- **Post-consensus local-execution failures are tolerated, not thrown.** Once
  consensus is reached the operation is authoritative; a member that cannot apply
  it locally (it is *ahead* — stale pend/commit returns `success:false` with
  `missing` — or *behind* — missing the prior pend, so `StorageRepo.commit` throws
  "Pending action … not found") logs `cluster-member:consensus-{pend,commit}-diverged`
  and tolerates the divergence rather than throwing. Throwing would reset the
  cluster stream the coordinator awaits and surface as a spurious `StreamResetError`,
  sinking an otherwise-successful transaction.
- **The commit divergence split keys off `CommitResult`, not throw-vs-return.** A
  missing pend (thrown "not found") or a stale/ahead commit (`success:false` with
  `missing`) is divergence and tolerated; a genuine mid-commit fault (`success:false`
  with a bare `reason`, no `missing`) is propagated so `handleConsensus` rolls back
  the executed marker and rethrows — same as an unexpected *thrown* fault
  (`applyConsensusOperation`).
- **A *behind* member actively reconciles.** It holds no revision of the committed
  blocks, so it pulls the committed revision from a cohort peer that holds it (via
  the injected `reconcileBlock` callback — `SyncClient` fetch + `saveReplicatedBlock`
  in `libp2p-node-base`) and restores it locally, repairing the under-replication
  that lazy read-repair alone cannot (no reachable peer the reader sees holds the
  newer rev). Reconciliation is best-effort and bounded (`ReconcileTimeoutMs`):
  failures/timeouts are logged (`cluster-member:consensus-commit-reconcile-failed`),
  never thrown. An *ahead* member already holds ≥ the rev, so it does not reconcile
  downward.

### Collection Header Blocks
- Header blockId = collection name (deterministic)
- All nodes MUST share the same header block for a collection
- `Collection.createOrOpen()` checks local storage first, then cluster

## Cohort-Topic Port Boundary

The cohort-topic substrate is split across packages so that **db-core stays free of any network/disk dependency** (the same bar that keeps blocks, trees, and logs transport-agnostic).

- **Pure logic in `db-core`** (`packages/db-core/src/cohort-topic`): wire formats + codecs, tier addressing (`coord_d`), the registration store + TTL, willingness / promotion-demotion state machines, sharding, the capacity barometer, walk *decisions*, and gossip *merge*. It depends only on a hash function and byte-array peer IDs.
- **Transport binding in `db-p2p`** (`packages/db-p2p/src/cohort-topic`): the FRET + libp2p implementations — protocol handlers, `RouteAndMaybeAct` routing, cohort assembly, threshold-sig collection, cohort gossip transport, membership-cert fetch, size estimator.

db-core defines seven **ports** (`packages/db-core/src/cohort-topic/ports.ts`) that db-p2p implements: `ITopicRouter`, `ICohortGossipTransport`, `IMembershipSource`, `ICohortThresholdCrypto`, `IMembershipPublishSink`, `ISizeEstimator`, and `IRingHash`. db-core substrate modules take these by injection; db-p2p constructs the FRET-backed versions and composes them. `RingCoord` and `PeerRef` are db-core-owned types — db-p2p maps `RingCoord` onto FRET's coordinate type.

`coord_d` hashing uses db-core's **own** SHA-256 via `IRingHash` (`RING_BITS` default 256 = the full digest, byte-compatible with FRET), **not** a FRET hash import. The guard `packages/db-core/test/no-fret-import.spec.ts` fails the build if anything under `db-core/src/**` imports `p2p-fret` or `libp2p`.

### Registration-record lifecycle

`packages/db-core/src/cohort-topic/registration/` owns the cohort-side **local** soft state — the store, the deterministic load-sharding under it, and the TTL lifecycle. Peer ids are raw `Uint8Array` (the substrate's `PeerRef.id` form, *not* the structural `network/types.ts` `PeerId`); the wire layer carries them as base64url, and the renewal/handoff bridges translate at that boundary.

- **Store** (`store.ts`) — `createRegistrationStore()` returns an in-memory `RegistrationStore` doubly indexed by topic then participant (outer map → inner map), giving O(1) `getByParticipant`/`delete`, O(participants) `listByTopic`, plus `directParticipants` (the stock count driving promotion) and `evictStale(now)` (removes and returns records where `now − lastPing > ttl`, strict greater-than). `appState` is the application's opaque slot; the layer never interprets it.
- **Slot assignment** (`sharding.ts`) — `createSlotAssigner(hash)` exposes `assignSlots(participantId, cohortEpoch, members)`: members sorted ascending by id, `slot = H(participantId ‖ cohortEpoch) mod k` (full-digest MSB-first mod, no bigint), `primary = order[slot]`, `backups = order[slot+1 .. slot+2]` wrapping mod `k` (capped at `k − 1`). Deterministic and order-independent; the renewal and handoff sides share one assigner.
- **TTL renewal** (`renewal.ts`) — participant side pings the primary every `ttl/3`; three consecutive failures promote `backups[0]` via a re-attach RPC, all-fail re-runs lookup from `d_max`. The `cohortEpoch` hint refreshes **lazily** (on the next `primary_moved` reply, not at failover). Cohort side `onRenew` touches `lastPing` + gossips, or returns `primary_moved` when a rotation moved the slot off this member; `sweepStale` evicts + gossips each eviction.
- **Rotation handoff** (`handoff.ts`) — per-member state machine over an injected transport: `start()` recomputes slots under the new epoch and broadcasts a primary inventory; `onInventory` pulls each record now assigned to this member from its previous holder, re-stamps its `primary`/`backups`, and acks; the previous holder **dual-serves** (answers renews) until that ack arrives (`isServing`/`onAck`).

Transports (`RenewalParticipantTransport`, `RenewalGossip`, `HandoffTransport`) are injected, so storage + sharding + TTL are unit-testable in isolation with mocks. Cross-member replication runs over the cohort-gossip driver in the host (`packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts`): the `RenewalGossip` `touch`/`evicted` hooks append to a per-coord delta queue, and a periodic host timer (`gossipIntervalMs`, default 5 s) drains the batch into a signed `CohortGossipV1` broadcast each round — alongside the TTL sweep, membership-cert refresh, and demotion check. Each frame carries its `coord`, so a node serving many cohorts routes inbound gossip to the right per-coord store/view.

### Service composition

The substrate's two top-level entry points compose the lower modules behind the ports above:

- **`CohortTopicService`** (`packages/db-core/src/cohort-topic/service.ts`) — the **participant-facing** service. It drives the full lifecycle for a node that wants to attach to a topic and runs purely over injected ports: `ITopicRouter` (walk / register / direct-dial via FRET's `RouteAndMaybeAct`), `ICohortGossipTransport`, `IMembershipSource`, `ICohortThresholdCrypto`, `IMembershipPublishSink`, `ISizeEstimator`, and `IRingHash`. It owns no FRET or libp2p import.
- **`CohortMemberEngine`** (`packages/db-core/src/cohort-topic/member-engine.ts`) — the **cohort-side** engine. It runs on the `k` peers FRET names as the cohort: handling inbound registrations/renewals, willingness checks, promotion/demotion decisions, gossip merge, and membership publication.

The participant pipeline is **walk → register → gossip → promote**: the participant estimates `d_max` from the size estimator and walks inward toward the topic root, registers at the landed cohort via the router (`key = coord_d(self, topicId)`, `activity = RegisterV1`, `wantK = k`, `minSigs = k − x`), the cohort replicates and reconciles soft state over gossip, and promotion/demotion redirects flow back as threshold-signed notices.

The **FRET host** (`packages/db-p2p/src/cohort-topic/host.ts`) scopes the cohort side **per served coordinate**. A node belongs to many cohorts — one per coord FRET routes to it — so the host keeps a lazy `servedCoord → CoordEngine` registry rather than a single node-level engine. Each `CoordEngine` owns its own registration store, gossip bus, willingness/traffic/renewal/cold-start, and a `CohortMemberEngine`, and threshold-signs / shards with the FRET cohort assembled **around the served coord** (`coord_d(P, topicId)`), not the node's own ring position. FRET's activity callback does not carry the routed key, so the host recomputes it from the decoded `RegisterV1` (`coord(treeTier, participantCoord, topicId)`) and dispatches to `registry.forCoord(servedCoord)`; a `RenewV1` (no `treeTier`) is resolved instead by the held record (`registry.findHolder`), falling back to `unknown_registration` when no local engine holds it. The node-wide collaborators (hash, slot assigner, barometer, threshold signer, the FRET ports, and the participant-facing service) are singletons injected into every engine. The promotion tier inputs are coord-derived: `treeTier` is fixed at instantiation, `parentCoord = coord_{d−1}(P, topicId)`, and `childCohortCount` is `0` for the current single-tier-0-cohort milestone.

### Protocol IDs

`db-p2p` registers four libp2p protocols on the FRET node, binding the db-core ports to FRET + libp2p:

```
/optimystic/cohort-topic/1.0.0/register       — Register, renew, re-attach
/optimystic/cohort-topic/1.0.0/cohort-gossip  — record replication, willingness, load barometers
/optimystic/cohort-topic/1.0.0/promote        — threshold-signed promotion/demotion notices
/optimystic/cohort-topic/1.0.0/membership     — membership certificates
```

The package split is strict: **db-core never imports FRET or libp2p** (enforced by `packages/db-core/test/no-fret-import.spec.ts`); **db-p2p** (`packages/db-p2p/src/cohort-topic`) is the only place the ports are bound to FRET's `RouteAndMaybeAct`, two-sided cohort assembly, and size estimator.

## Cluster Authentication

The cluster two-phase commit uses **cryptographic signatures**, not to be confused with ACLs.  Each peer in a `ClusterRecord.peers` entry carries a `publicKey: Uint8Array` derived from their libp2p peer ID.

- **Promise phase**: each cluster member signs the promise hash with its private key
- **Commit phase**: each cluster member signs the commit hash with its private key
- **Validation**: every peer verifies all signatures against `record.peers[peerId].publicKey` before accepting the record

This proves that the peers listed in the cluster actually voted — a coordinator cannot forge votes.  The signing and verification flow lives in `ClusterMember`: `signVote` signs the hash+vote payload with the local peer's Ed25519 private key, `verifySignature` reconstructs the public key from `record.peers` via `publicKeyFromRaw` and verifies the signature, and `validateSignatures` runs verification for all promises and commits on every incoming record.  The signing payload includes the vote type and reject reason (if any), preventing vote tampering.

**Important**: cluster authentication is about _identity verification_ (did this peer really vote?), not _authorization_ (is this peer allowed to write?).  Authorization decisions like per-collection permissions belong at a higher layer (e.g. application or collection module), not in the cluster consensus path.

### Equivocation Detection

`ClusterMember.detectEquivocation()` catches peers that flip their vote (approve → reject or vice versa) for the same transaction phase. During `mergeRecords()`, if an incoming signature has a different vote type than the existing one for the same peer:

- The **first-seen** signature is preserved (the flip is rejected)
- A `PenaltyReason.Equivocation` penalty (weight 100) is reported via the reputation service
- A single equivocation triggers a ban (weight 100 exceeds the default ban threshold of 80)

Same-type re-delivery (retransmission) is not flagged, avoiding false positives.

### Validity Disputes & Cascading Consensus

When cluster peers disagree on transaction validity, the transaction is blocked and escalated to progressively wider audiences until one side achieves consensus. The losing side is ejected and the ring segment self-heals. The coordinator is implicitly on the "approve" side (it validated before sending to the cluster), so disagreeing members independently orchestrate the escalation through a deterministically-selected dissent coordinator. See [Right-is-Right](right-is-right.md) for full details.

## Read Dependency Validation

Read dependency tracking prevents **write-skew anomalies** in optimistic concurrency control. Every block read during a transaction is recorded as a `ReadDependency` (`{ blockId, revision }`), and validators check that none of those blocks have been modified before allowing the transaction to commit.

**Data flow**: `TransactorSource.tryGet()` records reads → `Collection` delegates → `TransactionCoordinator` aggregates across collections → `TransactionSession.commit()` collects reads into the `Transaction` → `TransactionValidator` checks each read against current block state.

Key design decisions:
- Reads are captured at `TransactorSource.tryGet()` level, meaning ALL block reads (including internal structural blocks) are tracked — maximally correct but potentially over-conservative
- `CacheSource` naturally deduplicates — only the first read of a block reaches `TransactorSource`
- Non-existent blocks record `revision: 0`; if subsequently created, the read is detected as stale
- `BlockStateProvider` is optional in `TransactionValidator` — when absent, read validation is skipped (backward compatible)

## Proximity Verification

`CoordinatorRepo` rejects write requests for blocks the node is not responsible for. FRET routing is the primary guard; proximity verification catches misrouted requests.

- **Write path (strict)**: `pend`, `cancel`, `commit` throw `Not responsible for block(s): ...` if any block fails the cluster membership check
- **Read path (soft)**: `get` logs a warning but still serves — reads are best-effort
- **Fail-open**: If `findCluster` throws (network failure), the check assumes responsible to avoid false rejections
- **Caching**: `LruMap` with 1000 entries and 60s TTL avoids repeated `findCluster` lookups

## Cluster Health Monitors

Two topology-aware monitors react to peer arrivals/departures via `connection:open`/`connection:close` events on libp2p. Both are `Startable`, debounce rapid changes, and suppress activity during detected partitions.

### RebalanceMonitor

Tracks whether the local node's responsibility for blocks has changed after topology shifts. Emits `RebalanceEvent` with `gained`/`lost` block lists and `newOwners` for lost blocks. Throttled to one scan per `minRebalanceIntervalMs` (default 60s).

### SpreadOnChurnMonitor (Middle-Out)

Proactively pushes tracked blocks to expansion targets on peer departure. Only "middle" peers (FRET `neighborDistance` rank < d) spread, bounding fan-out to 2d across the cluster. Uses `BlockTransferClient.pushBlocks()` with reason `'replication'`, carrying the source block's `state.latest` as `blockMeta` so the replica's revision mirrors the source.

On the receiver, `BlockTransferService.handlePush` persists each pushed block into **local** storage via `IBlockReplicaStore.saveReplicatedBlock()` → `BlockStorage.saveReplica()`, which seeds metadata, advances `latest` monotonically (never downgrades on a stale push), and makes the block durably servable. A block is reported `accepted` only when it was both parseable and persisted; a parse/validation/persist failure surfaces it in `missing`. The sender only records a target as `succeeded` when the response does not list the block in `missing`, so a non-throwing round-trip that failed to persist is correctly counted as a failed push.

**Dynamic d**: Under rapid churn (3+ departures in sliding window) or low cluster health (FRET estimate/clusterSize < threshold), `effectiveD` scales up, capped at `clusterSize / 2`.

**Partition suppression**: Skips spread when `PartitionDetector.detectPartition()` returns true.

Both monitors are initialized through `NetworkManagerService.initRebalanceMonitor()` / `initSpreadOnChurnMonitor()` and stopped together in `NetworkManagerService.stop()`.

## Observability

Transaction metrics are instrumented with `debug` logging and optional verbose tracing:

- **Timing**: Phase-level timings (`gather`, `pend`, `commit`, `total`) with `trxId` correlation
- **Correlation IDs**: `trxId` in coordinator, `actionId` in network-transactor, `messageHash` in cluster-coordinator
- **Verbose mode**: Set `OPTIMYSTIC_VERBOSE=1` for detailed batch, peer list, and FRET candidate logging
- **Enable**: `DEBUG=optimystic:*` for standard logs, combine with `OPTIMYSTIC_VERBOSE=1` for full tracing

## Common Pitfalls

### 1. Shallow Copy of Transforms
**Bug**: `copyTransforms()` spreads `updates` object but arrays inside are shared.
```typescript
// WRONG
{ updates: { ...transform.updates } }  // Arrays still shared!

// CORRECT
{ updates: Object.fromEntries(
    Object.entries(transform.updates).map(([k, v]) => [k, structuredClone(v)])
)}
```

### 2. Storage Returns References
**Bug**: In-memory storage returns stored objects directly; mutations corrupt storage.
```typescript
// WRONG
getMaterializedBlock(): return this.blocks.get(key);

// CORRECT
getMaterializedBlock(): return structuredClone(this.blocks.get(key));
```

### 3. Independent Node Storage
**Bug**: Each node has its own storage. Consensus doesn't automatically sync data.
**Fix**: Nodes must fetch missing blocks from cluster peers via `restoreCallback`.

### 4. Check-Then-Act Race in Consensus
**Bug**: Checking `executedTransactions.has()` then setting after async work.
```typescript
// WRONG
if (executed.has(hash)) return;
await doWork();  // Another call can start here!
executed.set(hash, now);

// CORRECT
if (executed.has(hash)) return;
executed.set(hash, now);  // Set IMMEDIATELY
await doWork();
```

### 5. Latch Deadlocks
**Bug**: Latches are per-node, not distributed. Concurrent transactions on same block can deadlock.
**Symptom**: Test hangs indefinitely during concurrent writes.

## Quereus SQL Dialect

Quereus is **not** SQLite. It is a distinct SQL engine aligned with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf). The most important departure: **columns default to NOT NULL** unless explicitly marked `NULL`. Use `pragma default_column_nullability = 'nullable'` for SQL-standard behavior. Other notable differences include empty primary keys for singleton tables (`PRIMARY KEY ()`), native temporal/JSON types, all-virtual-table architecture, operation-specific CHECK constraints, and no triggers. See the [quereus-plugin-optimystic README](../packages/quereus-plugin-optimystic/README.md#quereus-sql-dialect) and the [Quereus SQL Reference](https://github.com/nicktobey/quereus/blob/main/docs/sql.md) (Section 11) for the full list.

## Type Glossary

| Type | Description |
|------|-------------|
| `Transform` | Single block mutation: `{ insert?, updates?, delete? }` |
| `Transforms` | Multi-block mutations: `{ inserts, updates, deletes }` by blockId |
| `BlockOperation` | `[entity, index, deleteCount, inserted]` - splice-style op |
| `ActionId` | Unique transaction identifier (was `TrxId`) |
| `ActionRev` | `{ actionId, rev }` - revision with its transaction |
| `messageHash` | Hash of consensus message, used for deduplication |
| `ClusterRecord` | Consensus state: peers, promises, commits, message |

## Debugging Tips

### Duplicate Entries
1. Check if storage clones on get/save
2. Check if transforms are deep-cloned before sharing
3. Check `executedTransactions` race conditions

### Missing Data Across Nodes
1. Verify `restoreCallback` is configured
2. Check if header block is shared (same blockId)
3. Verify cluster fetch mechanism in `CoordinatorRepo.get()`

### Consensus Timeouts
1. Check for latch deadlocks (concurrent access to same block)
2. Verify network connectivity between peers
3. Check `staleThreshold` (2000ms default) for cleanup timing

