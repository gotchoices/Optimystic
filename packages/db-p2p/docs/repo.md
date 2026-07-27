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
  async cancel(trxRef: TrxBlocks, options: MessageOptions): Promise<void>
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
- **Protocol ID**: `/db-p2p/repo/1.0.0` (configurable)
- **Message Format**: JSON-encoded `RepoMessage` objects
- **Stream Handling**: Uses length-prefixed encoding for message framing

**Implementation:**
```typescript
export class RepoService implements Startable {
  private readonly protocol: string = '/db-p2p/repo/1.0.0'
  
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

Every id is **network-scoped**: a node built with `networkName: 'mainnet'` registers ids under
`/optimystic/mainnet/…` and cannot negotiate with a node on a different network name. That is
deliberate — it is what keeps two logical networks sharing the same physical machines from selecting
each other's peers into a cohort.

| Service | Protocol id | Built by |
| --- | --- | --- |
| identify | `/optimystic/<network>/id/1.0.0` | `@libp2p/identify` |
| identify/push | `/optimystic/<network>/id/push/1.0.0` | `@libp2p/identify` |
| cluster | `/optimystic/<network>/cluster/1.0.0` | `cluster/service.ts` |
| repo | `/optimystic/<network>/repo/1.0.0` | `repo/service.ts` |
| sync | `/optimystic/<network>/db-p2p/sync/1.0.0` | `sync/protocol.ts` |
| block transfer | `/optimystic/<network>/db-p2p/block-transfer/1.0.0` | `cluster/block-transfer-service.ts` |

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
   read it from here rather than inferring it from the other four.

These ids are locked by `test/identify-protocol-id.spec.ts` (in-process) and
`test/foreign-peer-interop.integration.spec.ts` (from a peer built outside this repository, which is
the only place a uniformly-wrong convention can be caught).

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
const peers = await this.keyNetwork.findCluster(blockIdBytes);

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
  protocol: '/db-p2p/repo/1.0.0',
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
      protocol: '/db-p2p/repo/1.0.0'
    })
  }
});

// Create coordinator repo for distributed consensus
const repo = coordinatorRepo(keyNetwork, createClusterClient)({
  storageRepo: new StorageRepo(createBlockStorage)
});
```

