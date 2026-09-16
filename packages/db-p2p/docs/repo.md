# Optimystic DB-P2P Repo LibP2P Interface

The repo libp2p interface provides a distributed networking layer for the Optimystic database system, enabling peer-to-peer communication, cluster coordination, and distributed consensus for database operations. This document describes the architecture, components, and protocols used to distribute database operations across a network of peers.

## Architecture Overview

The repo libp2p interface consists of four main components working together:

```
┌─────────────────┐    ┌─────────────────┐
│   RepoClient    │    │   RepoService   │
│   (Client)      │◄──►│   (Server)      │
└─────────────────┘    └─────────────────┘
         │                       │
         │ (reads)               │ (writes)
         ▼                       ▼
┌─────────────────┐    ┌─────────────────┐
│CoordinatorRepo  │    │ ClusterCoordinator│
│(Consensus)      │◄──►│(2-Phase Commit) │
└─────────────────┘    └─────────────────┘
         │
         ▼
┌─────────────────┐
│  StorageRepo    │
│  (Local Store)  │
└─────────────────┘
```

## Core Components

### 1. RepoClient

The `RepoClient` provides a client-side implementation of the `IRepo` interface that communicates with remote peers over libp2p networks.

**Key Features:**
- **Network Transparency**: Provides the same `IRepo` interface as local storage
- **Protocol Abstraction**: Handles libp2p protocol communication details
- **Message Serialization**: Converts operations to/from network messages
- **Error Handling**: Manages network errors and timeouts

**Implementation Details:**
```typescript
export class RepoClient extends ProtocolClient implements IRepo {
  // Core repository operations
  async get(blockGets: BlockGets, options: MessageOptions): Promise<GetBlockResults>
  async pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure>
  async cancel(actionRef: ActionBlocks, options: MessageOptions): Promise<void>
  async commit(request: CommitRequest, options: MessageOptions): Promise<CommitResult>
}
```

**Usage Example:**
```typescript
// Create a client connected to a specific peer
const client = RepoClient.create(peerId, peerNetwork);

// Use like any other repo
const result = await client.get({
  blockIds: ['block1', 'block2'],
  context: { rev: 10 }
}, { expiration: Date.now() + 30000 });
```

### 2. RepoService

The `RepoService` implements a libp2p service that handles incoming repo protocol messages and delegates operations to a local `IRepo` implementation.

**Key Features:**
- **Protocol Handler**: Registers and handles the repo protocol
- **Stream Processing**: Manages incoming/outgoing libp2p streams
- **Operation Routing**: Routes operations to appropriate repo methods
- **Response Handling**: Serializes and sends responses back to clients

**Protocol Details:**
- **Protocol ID**: `/optimystic/<network>/repo/1.0.0` — built from the `protocolPrefix` the node was
  created with; see § Protocol id conventions. (`/db-p2p/repo/1.0.0` is only the fallback used when a
  service is constructed with no prefix at all, which `createLibp2pNode` never does.)
- **Message Format**: JSON-encoded `RepoMessage` objects
- **Stream Handling**: Uses length-prefixed encoding for message framing

**Implementation:**
```typescript
export class RepoService implements Startable {
  // init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0'
  private readonly protocol: string
  
  async start(): Promise<void> {
    await this.components.registrar.handle(
      this.protocol, 
      this.handleIncomingStream.bind(this),
      { maxInboundStreams: 32, maxOutboundStreams: 64 }
    );
  }
}
```

### 3. CoordinatorRepo

The `CoordinatorRepo` implements distributed consensus by coordinating operations across multiple cluster nodes while maintaining a local storage repository.  This uses the ClusterCoordinator to do the actual cluster coordination.

**Key Features:**
- **Cluster Coordination**: Manages distributed operations across cluster peers
- **Local Storage**: Maintains a local storage repository for actual data
- **Consensus Protocol**: Uses 2-phase commit for distributed transactions
- **Fault Tolerance**: Handles partial failures and network issues

**Operation Flow:**
1. **Local Validation**: Validates operations against local storage
2. **Cluster Coordination**: Coordinates with cluster peers using 2-phase commit
3. **Local Application**: Applies successful operations to local storage
4. **Error Handling**: Manages failures and partial commits

**Implementation:**
```typescript
export class CoordinatorRepo implements IRepo {
  private clusterManager: ClusterCoordinator;
  
  constructor(
    private readonly keyNetwork: IKeyNetwork,
    private readonly createClusterClient: (peerId: PeerId) => ClusterClient,
    private readonly storageRepo: IRepo
  ) {
    this.clusterManager = new ClusterCoordinator(keyNetwork, createClusterClient);
  }
}
```

#### The durability gate and the under-replication ledger

A commit is acknowledged to the writer only when a strict majority of the cohort it ran on reports holding the committed revision — the durability gate, stated in full under "Commit durability reporting" in [docs/correctness.md §2 Definitions](../../../docs/correctness.md#2-definitions). Every acknowledgement carries a durability class (`full`, `majority`, `local` or `unrouted`; `WriteDurability` in `packages/db-core/src/network/struct.ts`) saying who holds it.

Below `full`, somebody is still owed a copy, and the coordinator knows who only at the moment it answers. So every success exit of `CoordinatorRepo.commit` — solo, local-executed, local fallback, tolerated divergence — passes through `noteReplicationShortfall` in `packages/db-p2p/src/repo/coordinator-repo.ts` before the answer goes out, which writes that down in the node's under-replication ledger (`IUnderReplicationLedger` in `packages/db-p2p/src/repo/i-under-replication-ledger.ts`):

| Class the commit was acknowledged at | What the ledger does, per block |
|---|---|
| `full` | Settles (deletes) any entry at the same or a lower revision. Records nothing. |
| `majority` | Records the unconfirmed members by peer id. |
| `local`, `unrouted` | Records an **empty** missing set, meaning *unknown* — no cohort could be named, so whatever drains the entry re-resolves the cohort then. |

Rules the recording follows:

- **Only after the gate admitted the commit.** A refused commit never reaches the ledger.
- **Only when this node holds the bytes.** A tolerated divergence, or a local-executed commit whose own member has no durable verdict, answers success without this node holding the revision; it has nothing to push, so nothing is recorded (a `full` answer still settles).
- **Torn blocks are skipped.** A block an abandoned sweep cancelled holds nothing to push.
- **One entry per block, at the highest revision.** A newer revision supersedes an older one — pushing the newer materialization satisfies both — and resets the give-up counter; an older commit finishing late cannot lower or settle a newer entry. This bounds the ledger by the node's owned-block count, and a hard cap (`DEFAULT_UNDER_REPLICATION_MAX_ENTRIES` in `packages/db-p2p/src/repo/kv-under-replication-ledger.ts`) evicts oldest-recorded first as a backstop.
- **A ledger fault never fails the commit.** The write is already durable at the class the answer states; the failure is logged as `coordinator-repo:under-replication-record-failed` and the answer goes out unchanged.

`KvUnderReplicationLedger` stores entries as JSON under `under-replicated/<blockId>` in the node's `IKVStore`, supplied as `NodeOptions.kvStore`. Without one the node uses an in-memory store and logs a `node-wiring` warning, because the ledger then does not survive a restart — the one case it exists for. `FileKVStore` may share `FileRawStorage`'s base path; see `packages/db-p2p-storage-fs/README.md`.

#### The under-replication drain and the full-replication event

`UnderReplicationDrain` in `packages/db-p2p/src/repo/under-replication-drain.ts` is the sending half. It is a `Startable` beside the other resilience monitors, constructed in `createLibp2pNodeBase` outside the arachnode/FRET gate (it needs the key network, the node's own store and dialer, and libp2p's connection events — nothing from arachnode), so it runs on every node unless `NodeOptions.underReplicationDrain` is `{ enabled: false }`.

**What wakes a pass.** The node starting — the entries the ledger carried across a restart, the case no in-memory retry ever covered; a peer connecting or completing identify, debounced (`debounceMs`) and throttled to one pass per `minIntervalMs`, a trigger inside the window being deferred to its end rather than dropped; and a re-check timer (`recheckIntervalMs`) armed while any entry is outstanding, cheap while nothing can be pushed (a tick with no pushable peer costs one connection scan and one in-memory count, `IUnderReplicationLedger.size`).

**What one pass does**, per entry, over at most `blockBudget` entries (rotating, oldest-recorded first, so a backlog wider than the budget is swept in full and nothing starves):

- **Works out who is owed a copy.** A named missing set (a `majority` entry) is taken as recorded and never re-resolved — those members were in the cohort when the write was acknowledged, and a copy there is never harmful. An empty set (`local`, `unrouted`) re-resolves the block's cohort through `IKeyNetwork.findCluster` now. A cohort of this node alone is not a failure: the entry is left untouched and no attempt is counted, so a node that is genuinely by itself never burns its give-up budget.
- **Pushes only to reachable peers**: connected, and identified as serving this network's block-transfer protocol. Nobody reachable → the entry waits for the next arrival; the drain does not dial the world.
- **Pushes through `pushBlockToPeers`** in `packages/db-p2p/src/cluster/block-transfer-service.ts` — the one read-certify-push-interpret loop the rebalance handoff and spread-on-churn also use. A peer whose answer does not list the block as missing has confirmed it and is taken off the entry (`satisfy`, guarded by the revision pushed so a newer shortfall recorded mid-push is left alone). An entry that could not name its members is named with the resolved cohort (`name`, which touches only an entry still standing at that revision, so a `full` commit that settled it mid-push is not undone) before the first confirmation is taken off it, and stays unnamed while nobody confirms, so the next pass resolves the cohort afresh. A block gone from local storage has its entry deleted — it is not one this node can owe. A receiver's refusal of a block this node holds no proof for is logged as "cannot place", apart from "cannot reach".
- **Counts an unsuccessful round** (`noteAttempt`) when a reachable peer did not confirm; after `maxAttempts` consecutive such rounds that peer is abandoned for that block — no longer pushed to — until it reconnects, which retries it from scratch. The entry itself is never deleted for that: it stays in the ledger, visible, and the ledger's size cap is the backstop for a peer that never returns.
- **When the entry empties**, the ledger deletes it and ONE `BlockDurabilityReachedEvent` fires — after the deletion, never before — through `StorageRepo.emitBlockDurabilityReached`, the one method the node hands the drain, reaching every `onBlockDurabilityReached` listener with the same isolation as `onCollectionChange` (a throwing listener is logged; the rest still run).

**The event.** `IBlockDurabilityNotifier` in `packages/db-core/src/transactor/change-notifier.ts` is the complement of the durability class on the write's own result: a write acknowledged below `full` is pending until these events cover its blocks. `StorageRepo` implements it beside `IBlockChangeNotifier`, so a host has one subscription point for change events. It is keyed by **block**, deliberately: the ledger keeps one entry per block at its highest under-replicated revision, so a block rewritten by a later action replaces the earlier entry and the earlier action never fires an event of its own. A host holds the block ids the write's result named (`PendSuccess.blockIds`) and clears each as an event covers it; keying pending state by action alone waits forever for a superseded write.

**Overlaps and suppression.** The rebalance growth arm and spread-on-churn may push the same block to the same peer; the receiver is idempotent, so no cross-monitor coordination exists. Like the neighbouring monitors, a pass is skipped while `PartitionDetector` reports a partition. The drain adds no ordering guarantee for a push landing mid-commit — the receiver's own push handling decides. Log namespace `under-replication-drain`.

### 4. ClusterCoordinator

The `ClusterCoordinator` manages the distributed transaction protocol using a 2-phase commit approach to ensure consistency across cluster nodes.

**Key Features:**
- **2-Phase Commit**: Implements prepare/commit protocol for distributed transactions
- **Peer Discovery**: Uses key network to find cluster peers for specific blocks
- **Transaction State**: Manages transaction state across multiple phases
- **Majority Consensus**: Requires majority agreement for transaction success

**Transaction Phases:**

#### Phase 1: Promise Collection
```typescript
// Collect promises from all peers in the cluster
const promiseResults = await this.collectPromises(peers, record);

// Check for majority consensus
const majority = Math.floor(Object.keys(peers).length / 2) + 1;
if (Object.keys(promiseResults.record.promises).length < majority) {
  throw new Error('Failed to get majority consensus');
}
```

#### Phase 2: Commit Execution
```typescript
// Commit the transaction to all peers
return await this.commitTransaction(promiseResults.record);
```

## Protocol Specifications

### Message Format

All network communication uses the `RepoMessage` format:

```typescript
export type RepoMessage = {
	operations: [
		{ get: BlockGets } |
		{ pend: PendRequest } |
		{ cancel: { actionRef: ActionBlocks } } |
		{ commit: CommitRequest } |
		{ invalidate: InvalidateRequest }
	],
	expiration?: number,
	coordinatingBlockIds?: string[],
};
```

One request per stream: the service answers the first frame and completes the generator, so a client
dials, writes one length-prefixed JSON `RepoMessage`, reads one length-prefixed JSON response, and
closes. A second frame queued on the same stream is never read.

`invalidate` is the one operation the repo protocol does not serve. It reaches a node only through
consensus on the cluster protocol (`ClusterRecord.message`, applied by `cluster/cluster-repo.ts`);
`RepoService` dispatches `get` / `pend` / `cancel` / `commit` only, so an `invalidate` sent directly
on the repo protocol produces no meaningful response.

### Cluster Record Format

Distributed transactions use `ClusterRecord` for state management:

```typescript
export type ClusterRecord = {
  messageHash: string;           // Unique transaction identifier
  peers: ClusterPeers;          // Participating peers
  message: RepoMessage;         // Original message
  promises: Record<string, Signature>;  // Phase 1 promises
  commits: Record<string, Signature>;   // Phase 2 commits
};
```

### Network Protocols

#### Repo Protocol
- **Protocol ID**: `/optimystic/<network>/repo/1.0.0` (built from `protocolPrefix`; see § Protocol id conventions)
- **Transport**: libp2p streams with length-prefixed encoding
- **Message Type**: JSON-encoded `RepoMessage`
- **Response**: JSON-encoded operation results

#### Cluster Protocol
- **Protocol ID**: `/optimystic/<network>/cluster/1.0.0` (built from `protocolPrefix`)
- **Transport**: libp2p streams
- **Message Type**: `ClusterRecord` updates
- **Phases**: Promise collection → Commit execution

### Protocol id conventions

Two peers connect only if they agree on the exact protocol id string for each service. Anyone building
a peer against an Optimystic node — including this repository's own foreign-peer interop fixture —
needs the table below, because the strings are not all derived the same way.

Every id Optimystic itself defines is **network-scoped**: a node built with `networkName: 'mainnet'`
registers ids under `/optimystic/mainnet/…` and cannot negotiate with a node on a different network
name. That is deliberate — it is what keeps two logical networks sharing the same physical machines
from selecting each other's peers into a cohort.

| Service | Protocol id | Built by |
| --- | --- | --- |
| identify | `/optimystic/<network>/id/1.0.0` | `@libp2p/identify` |
| identify/push | `/optimystic/<network>/id/push/1.0.0` | `@libp2p/identify` |
| cluster | `/optimystic/<network>/cluster/1.0.0` | `cluster/service.ts` |
| repo | `/optimystic/<network>/repo/1.0.0` | `repo/service.ts` |
| sync | `/optimystic/<network>/db-p2p/sync/1.0.0` | `sync/protocol.ts` |
| block transfer | `/optimystic/<network>/db-p2p/block-transfer/1.0.0` | `cluster/block-transfer-service.ts` |
| routing (FRET) | `/optimystic/<network>/fret/1.0.0/{ping,neighbors,neighbors/announce,maybeAct,leave}` | `p2p-fret` |

A node also advertises the stock libp2p protocols its services bring with them — `/ipfs/ping/1.0.0`,
`/libp2p/dcutr`, `/libp2p/autonat/1.0.0`, `/libp2p/circuit/relay/0.2.0/…`. Those keep their upstream
ids and are **not** network-scoped, so two nodes on different Optimystic networks can still ping each
other; only the ids above decide whether a peer is treated as part of this network.

No `pubsub` service is registered — `@chainsafe/libp2p-gossipsub` (newest release 14.1.2) is built
against `@libp2p/interface@^2` and cannot work on this repo's libp2p 3 (gotchoices/Optimystic#9); see
the `NOTE:` at its former registration site in `libp2p-node-base.ts`.

Two traps in that table:

1. **The identify prefix is spelled slash-LESS.** `@libp2p/identify` builds its own id as
   `` `/${protocolPrefix}/id/1.0.0` `` — it always prepends the leading slash, and its own default is
   the bare `'ipfs'`. So it must be handed `optimystic/<network>`, while every service that
   concatenates its own template literal is handed `/optimystic/<network>`. Passing the slash-prefixed
   form to identify produces the malformed `//optimystic/<network>/id/1.0.0`, which shipped for
   several releases ([gotchoices/Optimystic#6](https://github.com/gotchoices/Optimystic/issues/6)) and
   is invisible to any test whose peers all make the same mistake.
2. **`sync` and `block-transfer` carry a `/db-p2p/` infix.** Their builders prepend the network prefix
   to an id that already begins `/db-p2p/…`, so the network scope and the legacy package name both
   appear. This is the current wire format, not a typo in this document — but it is not guessable, so
   read it from here rather than inferring it from `cluster` and `repo`.

These ids are locked by `test/identify-protocol-id.spec.ts` (in-process) and
`test/foreign-peer-interop.integration.spec.ts` (from a peer built outside this repository, which is
the only place a uniformly-wrong convention can be caught).

**Four of these ids may be closed to you.** `cluster`, `repo`, `sync` and `block transfer` are the
database protocols, and a node built with `createLibp2pNode({ authorizeInboundStream })` consults
that predicate before decoding anything on them. A peer it refuses sees the stream reset with no
error frame — remotely indistinguishable from a transport fault, so if you are building an external
peer and every database dial resets while `identify` and `ping` work, suspect the gate rather than
the protocol id. See `docs/internals.md` § Inbound Stream Authorization. Nodes built without that
option (the default) serve all four to anyone who can connect.

### Peer classification

`Libp2pKeyPeerNetwork.membershipOf` classifies every peer from its advertised protocol list alone:

- **`serves`** — advertises `/optimystic/<network>/cluster/1.0.0` or `/optimystic/<network>/repo/1.0.0`
- **`foreign`** — advertises protocols, but neither of those (it belongs to some other network)
- **`unknown`** — advertises nothing yet (identify has not completed)

Coordinator and cohort selection route work only to peers confirmed `serves`. A peer built to speak
the repo protocol therefore becomes routable the moment its identify exchange completes; a peer whose
ids are misspelled stays `foreign` forever and is silently skipped.

## Distributed Consensus Algorithm

### 2-Phase Commit Protocol

The system uses a 2-phase commit protocol to ensure atomicity across distributed operations:

```
Phase 1: Promise Collection
┌─────────────────────────────────────────────────────────────┐
│ Coordinator → All Peers: "Prepare to commit transaction X" │
│ All Peers → Coordinator: "Promise" or "Abort"              │
│ Coordinator: Check majority consensus                       │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
Phase 2: Commit Execution
┌─────────────────────────────────────────────────────────────┐
│ Coordinator → All Peers: "Commit transaction X"            │
│ All Peers: Apply transaction locally                        │
│ All Peers → Coordinator: "Committed"                       │
└─────────────────────────────────────────────────────────────┘
```

### Fault Tolerance

The system handles various failure scenarios:

- **Network Partitions**: Requires majority consensus to proceed
- **Peer Failures**: Continues with remaining peers if majority available
- **Coordinator Failures**: Peers can detect and handle coordinator failures
- **Partial Commits**: Implements rollback mechanisms for partial failures

## Key Network Integration

### Block-to-Cluster Mapping

The system uses the `IKeyNetwork` interface to map blocks to clusters:

```typescript
// Find cluster peers for a specific block
const peers = await this.keyNetwork.findCluster(routingKeyForBlock(blockId));

// Execute transaction across the cluster
await this.clusterManager.executeClusterTransaction(blockId, message, options);
```

### Peer Discovery

Clusters are discovered dynamically based on:
- **Block ID**: Each block is assigned to a specific cluster
- **DHT Lookup**: Distributed hash table resolves block IDs to peer lists
- **Cluster Membership**: Peers join/leave clusters dynamically

## Usage Patterns

### Client-Side Usage

```typescript
// Create a client for a specific peer
const client = RepoClient.create(peerId, peerNetwork);

// Perform distributed database operations
const blocks = await client.get({ blockIds: ['block1'] });
const pendResult = await client.pend({ actionId: 'tx1', transforms: {...} });
const commitResult = await client.commit({ actionId: 'tx1', blockIds: ['block1'] });
```

### Server-Side Setup

```typescript
// Create a service with local storage
const service = repoService({
  protocolPrefix: '/optimystic/my-network',   // → /optimystic/my-network/repo/1.0.0
  maxInboundStreams: 32
});

// Set up coordinator for distributed operations
const coordinator = coordinatorRepo(keyNetwork, createClusterClient);

// Start the service
await service.start();
```

### Full Node Configuration

```typescript
// Create a full node with both client and server capabilities
const node = await createLibp2pNode({
  services: {
    repo: repoService({
      protocolPrefix: '/optimystic/my-network'
    })
  }
});

// Create coordinator repo for distributed consensus
const repo = coordinatorRepo(keyNetwork, createClusterClient)({
  storageRepo: new StorageRepo(createBlockStorage)
});
```

