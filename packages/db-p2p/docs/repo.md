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
		{ cancel: { trxRef: TrxBlocks } } |
		{ commit: CommitRequest }
	],
  expiration: number;
};
```

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
- **Protocol ID**: `/db-p2p/repo/1.0.0`
- **Transport**: libp2p streams with length-prefixed encoding
- **Message Type**: JSON-encoded `RepoMessage`
- **Response**: JSON-encoded operation results

#### Cluster Protocol
- **Protocol ID**: `/db-p2p/cluster/1.0.0`
- **Transport**: libp2p streams
- **Message Type**: `ClusterRecord` updates
- **Phases**: Promise collection → Commit execution

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
const pendResult = await client.pend({ trxId: 'tx1', transforms: {...} });
const commitResult = await client.commit({ trxId: 'tx1', blockIds: ['block1'] });
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

