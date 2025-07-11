# Optimystic DB-P2P Cluster Client/Service

The cluster client/service system provides the core distributed consensus mechanism for the Optimystic database, implementing a robust 2-phase commit protocol that ensures consistency across peer-to-peer networks. This document describes the architecture, components, and protocols that enable reliable distributed database operations.

## Architecture Overview

The cluster system consists of three main components working together:

```
┌─────────────────┐    ┌─────────────────┐
│  ClusterClient  │◄──►│ ClusterService  │
│   (Network)     │    │   (Protocol)    │
└─────────────────┘    └─────────────────┘
         │                       │
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────┐
│          ClusterMember                  │
│      (Consensus Engine)                 │
│  ┌─────────────────────────────────────┐│
│  │     2-Phase Commit Protocol         ││
│  │  Promise → Consensus → Commit       ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

## Core Components

### 1. ClusterClient

The `ClusterClient` provides a network client for communicating with remote cluster peers, implementing the `ICluster` interface for cluster operations.

**Key Features:**
- **Network Abstraction**: Simplifies peer-to-peer cluster communication
- **Protocol Handling**: Manages libp2p protocol details
- **Record Updates**: Sends and receives cluster record updates
- **Error Management**: Handles network failures and timeouts

**Implementation:**
```typescript
export class ClusterClient extends ProtocolClient implements ICluster {
  async update(record: ClusterRecord): Promise<ClusterRecord> {
    const message = {
      operation: 'update',
      record
    };
    
    return this.processMessage<ClusterRecord>(
      message,
      '/db-p2p/cluster/1.0.0'
    );
  }
}
```

**Usage Example:**
```typescript
// Create a client for a specific peer
const client = ClusterClient.create(peerId, peerNetwork);

// Send cluster record update
const updatedRecord = await client.update(clusterRecord);
```

### 2. ClusterService

The `ClusterService` implements a libp2p service that handles incoming cluster protocol messages and delegates operations to a local cluster implementation.

**Key Features:**
- **Protocol Registration**: Registers the cluster protocol with libp2p
- **Stream Management**: Handles incoming/outgoing message streams
- **Message Processing**: Decodes and processes cluster messages
- **Error Handling**: Manages protocol-level errors and logging

**Protocol Details:**
- **Protocol ID**: `/db-p2p/cluster/1.0.0` (configurable)
- **Message Format**: JSON-encoded cluster operation messages
- **Transport**: Length-prefixed streams over libp2p

**Implementation:**
```typescript
export class ClusterService implements Startable {
  private readonly protocol: string = '/db-p2p/cluster/1.0.0';
  
  async start(): Promise<void> {
    await this.components.registrar.handle(
      this.protocol,
      this.handleIncomingStream.bind(this),
      {
        maxInboundStreams: 32,
        maxOutboundStreams: 64
      }
    );
  }
}
```

### 3. ClusterMember

The `ClusterMember` is the core consensus engine that implements the 2-phase commit protocol for distributed transactions across cluster peers.

**Key Features:**
- **2-Phase Commit**: Complete implementation of distributed consensus
- **Transaction State Management**: Tracks all active transactions
- **Conflict Detection**: Prevents conflicting concurrent operations
- **Timeout Management**: Handles transaction timeouts and cleanup
- **Signature Verification**: Validates cryptographic signatures
- **Automatic Recovery**: Handles peer failures and network issues

## 2-Phase Commit Protocol

### Transaction Phases

The system implements a sophisticated state machine for managing distributed transactions:

```typescript
enum TransactionPhase {
  Promising,        // Collecting promises from peers
  OurPromiseNeeded, // We need to provide our promise
  OurCommitNeeded,  // We need to provide our commit
  Consensus,        // Transaction has reached consensus
  Rejected,         // Transaction was rejected
  Propagating      // Transaction is being propagated
}
```

### Phase Flow Diagram

```
┌─────────────────┐
│   Transaction   │
│    Initiated    │
└─────────────────┘
         │
         ▼
┌─────────────────┐    ┌─────────────────┐
│   Promising     │───►│OurPromiseNeeded │
│  (Collecting)   │    │  (Local Vote)   │
└─────────────────┘    └─────────────────┘
         │                       │
         │                       ▼
         │              ┌─────────────────┐
         │              │ OurCommitNeeded │
         │              │ (Final Vote)    │
         │              └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐    ┌─────────────────┐
│    Rejected     │    │   Consensus     │
│   (Failed)      │    │  (Committed)    │
└─────────────────┘    └─────────────────┘
```

### Phase 1: Promise Collection

During the promise phase, each peer evaluates whether they can commit to the transaction:

```typescript
private async handlePromiseNeeded(record: ClusterRecord): Promise<ClusterRecord> {
  // Check for conflicts with existing transactions
  if (this.hasConflict(record)) {
    return this.rejectTransaction(record, 'Conflict detected');
  }
  
  // Create promise signature
  const signature: Signature = {
    type: 'approve',
    signature: await this.signPromiseHash(record)
  };
  
  return {
    ...record,
    promises: {
      ...record.promises,
      [this.peerId.toString()]: signature
    }
  };
}
```

### Phase 2: Commit Execution

Once all peers have promised, the commit phase begins:

```typescript
private async handleCommitNeeded(record: ClusterRecord): Promise<ClusterRecord> {
  // Verify all promises are present
  const peerCount = Object.keys(record.peers).length;
  const promiseCount = Object.keys(record.promises).length;
  
  if (promiseCount !== peerCount) {
    throw new Error('Incomplete promise collection');
  }
  
  // Create commit signature
  const signature: Signature = {
    type: 'approve',
    signature: await this.signCommitHash(record)
  };
  
  return {
    ...record,
    commits: {
      ...record.commits,
      [this.peerId.toString()]: signature
    }
  };
}
```

### Consensus Achievement

When majority consensus is reached, the transaction is executed:

```typescript
private async handleConsensus(record: ClusterRecord): Promise<void> {
  // Execute the database operations
  for (const operation of record.message.operations) {
    if ('get' in operation) {
      await this.storageRepo.get(operation.get);
    } else if ('pend' in operation) {
      await this.storageRepo.pend(operation.pend);
    } else if ('commit' in operation) {
      await this.storageRepo.commit(operation.commit);
    } else if ('cancel' in operation) {
      await this.storageRepo.cancel(operation.cancel.trxRef);
    }
  }
}
```

## Transaction State Management

### Transaction State Structure

Each active transaction maintains comprehensive state:

```typescript
interface TransactionState {
  record: ClusterRecord;           // Current transaction record
  promiseTimeout?: NodeJS.Timeout; // Promise collection timeout
  resolutionTimeout?: NodeJS.Timeout; // Resolution timeout
  lastUpdate: number;              // Last update timestamp
}
```

### State Lifecycle

```typescript
export class ClusterMember implements ICluster {
  private activeTransactions: Map<string, TransactionState> = new Map();
  private cleanupQueue: string[] = [];
  
  constructor(/* ... */) {
    // Periodic cleanup of expired transactions
    setInterval(() => this.queueExpiredTransactions(), 60000);
    setInterval(() => this.processCleanupQueue(), 1000);
  }
}
```

## Conflict Detection and Resolution

### Conflict Detection Algorithm

The system prevents conflicting transactions by analyzing affected block IDs:

```typescript
private hasConflict(record: ClusterRecord): boolean {
  for (const [_, state] of this.activeTransactions) {
    if (this.operationsConflict(
      state.record.message.operations,
      record.message.operations
    )) {
      return true;
    }
  }
  return false;
}

private operationsConflict(ops1: RepoMessage['operations'], ops2: RepoMessage['operations']): boolean {
  const blocks1 = new Set(this.getAffectedBlockIds(ops1));
  const blocks2 = new Set(this.getAffectedBlockIds(ops2));
  
  for (const block of blocks1) {
    if (blocks2.has(block)) return true;
  }
  
  return false;
}
```

### Resolution Strategies

- **Rejection**: Conflicting transactions are rejected with clear error messages
- **Queuing**: Non-conflicting transactions can proceed in parallel
- **Timeout**: Expired transactions are automatically rejected

## Cryptographic Security

### Signature System

All operations are cryptographically signed to ensure integrity:

```typescript
// Promise signature computation
private async computePromiseHash(record: ClusterRecord): Promise<string> {
  const msgBytes = new TextEncoder().encode(
    record.messageHash + JSON.stringify(record.message)
  );
  const hashBytes = await sha256.digest(msgBytes);
  return uint8ArrayToString(hashBytes.digest, 'base64url');
}

// Commit signature computation
private async computeCommitHash(record: ClusterRecord): Promise<string> {
  const msgBytes = new TextEncoder().encode(
    record.messageHash + 
    JSON.stringify(record.message) + 
    JSON.stringify(record.promises)
  );
  const hashBytes = await sha256.digest(msgBytes);
  return uint8ArrayToString(hashBytes.digest, 'base64url');
}
```

### Signature Verification

```typescript
private async validateSignatures(record: ClusterRecord): Promise<void> {
  // Validate promise signatures
  const promiseHash = await this.computePromiseHash(record);
  for (const [peerId, signature] of Object.entries(record.promises)) {
    if (!await this.verifySignature(peerId, promiseHash, signature)) {
      throw new Error(`Invalid promise signature from ${peerId}`);
    }
  }
  
  // Validate commit signatures
  const commitHash = await this.computeCommitHash(record);
  for (const [peerId, signature] of Object.entries(record.commits)) {
    if (!await this.verifySignature(peerId, commitHash, signature)) {
      throw new Error(`Invalid commit signature from ${peerId}`);
    }
  }
}
```

## Fault Tolerance and Recovery

### Timeout Management

The system implements comprehensive timeout handling:

```typescript
private setupTimeouts(record: ClusterRecord): {
  promiseTimeout?: NodeJS.Timeout;
  resolutionTimeout?: NodeJS.Timeout;
} {
  if (!record.message.expiration) {
    return {};
  }
  
  return {
    promiseTimeout: setTimeout(
      () => this.handleExpiration(record.messageHash),
      record.message.expiration - Date.now()
    ),
    resolutionTimeout: setTimeout(
      () => this.resolveWithPeers(record.messageHash),
      record.message.expiration + 5000 - Date.now()
    )
  };
}
```

### Peer Recovery

When peers fail or become unreachable:

```typescript
private async resolveWithPeers(messageHash: string): Promise<void> {
  const state = this.activeTransactions.get(messageHash);
  if (!state) return;
  
  // Attempt to resolve with available peers
  for (const [peerId, peer] of Object.entries(state.record.peers)) {
    if (peerId === this.peerId.toString()) continue;
    
    try {
      const client = ClusterClient.create(peerIdFromString(peerId), this.peerNetwork);
      const peerRecord = await client.update(state.record);
      
      if (Object.keys(peerRecord.commits).length > 0) {
        await this.handlePeerRecovery(peerRecord);
        break;
      }
    } catch (error) {
      console.error(`Failed to resolve with peer ${peerId}:`, error);
    }
  }
}
```

### Cleanup and Garbage Collection

Automatic cleanup prevents memory leaks:

```typescript
private queueExpiredTransactions(): void {
  const now = Date.now();
  for (const [messageHash, state] of this.activeTransactions) {
    if (state.record.message.expiration && state.record.message.expiration < now) {
      this.cleanupQueue.push(messageHash);
    }
  }
}

private async processCleanupQueue(): Promise<void> {
  while (this.cleanupQueue.length > 0) {
    const messageHash = this.cleanupQueue.shift();
    if (!messageHash) continue;
    
    const state = this.activeTransactions.get(messageHash);
    if (!state) continue;
    
    const phase = await this.getTransactionPhase(state.record);
    if (phase !== TransactionPhase.Consensus && phase !== TransactionPhase.Rejected) {
      this.activeTransactions.delete(messageHash);
    }
  }
}
```

## Usage Patterns

### Setting Up a Cluster Node

```typescript
// Create cluster member with storage repo
const clusterMember = new ClusterMember(
  storageRepo,
  peerNetwork,
  peerId
);

// Create cluster service
const clusterService = clusterService({
  protocol: '/db-p2p/cluster/1.0.0',
  maxInboundStreams: 32
});

// Start the service
await clusterService.start();
```

### Initiating a Distributed Transaction

```typescript
// Create cluster record
const record: ClusterRecord = {
  messageHash: await createMessageHash(message),
  peers: await getClusterPeers(blockId),
  message: repoMessage,
  promises: {},
  commits: {}
};

// Send to cluster members
const promises = Object.keys(record.peers).map(peerId => {
  const client = ClusterClient.create(peerIdFromString(peerId), peerNetwork);
  return client.update(record);
});

// Wait for consensus
const results = await Promise.all(promises);
```

### Handling Incoming Transactions

```typescript
// Automatically handled by ClusterMember
const updatedRecord = await clusterMember.update(incomingRecord);

// System automatically:
// 1. Validates the record
// 2. Checks for conflicts
// 3. Provides promises/commits
// 4. Executes on consensus
// 5. Propagates updates
```

## Performance Characteristics

### Latency Considerations

- **Promise Phase**: Single round-trip to all peers (~100-500ms)
- **Commit Phase**: Second round-trip for final confirmation (~100-500ms)
- **Total Transaction Time**: 2-3 round-trips depending on network conditions

### Throughput Optimization

- **Parallel Processing**: Non-conflicting transactions processed concurrently
- **Pipelining**: Multiple phases can overlap for different transactions
- **Batching**: Multiple operations can be grouped in single transactions

### Scalability Factors

- **Cluster Size**: O(n) communication complexity where n = cluster size
- **Conflict Rate**: Higher conflicts reduce parallelism
- **Network Latency**: Directly impacts transaction completion time

## Error Handling and Monitoring

### Error Types

```typescript
// Network errors
class NetworkError extends Error {
  constructor(peerId: string, operation: string) {
    super(`Network error with peer ${peerId} during ${operation}`);
  }
}

// Consensus errors
class ConsensusError extends Error {
  constructor(reason: string) {
    super(`Consensus failed: ${reason}`);
  }
}

// Timeout errors
class TimeoutError extends Error {
  constructor(messageHash: string) {
    super(`Transaction ${messageHash} timed out`);
  }
}
```

### Monitoring Metrics

- **Active Transactions**: Count of ongoing consensus operations
- **Success Rate**: Percentage of successful consensus operations
- **Average Latency**: Time from initiation to consensus
- **Conflict Rate**: Percentage of transactions that conflict
- **Peer Connectivity**: Health of connections to cluster peers

## Security Considerations

### Cryptographic Integrity

- **Message Hashing**: All messages have cryptographic hashes
- **Signature Verification**: All operations are signed and verified
- **Replay Protection**: Timestamps prevent replay attacks

### Access Control

- **Peer Authentication**: Only authenticated peers can participate
- **Operation Authorization**: Fine-grained permissions for operations
- **Cluster Membership**: Dynamic and secure cluster membership

### Attack Prevention

- **Sybil Resistance**: Cryptographic peer identity prevents Sybil attacks
- **Byzantine Fault Tolerance**: Majority consensus prevents Byzantine failures
- **DoS Protection**: Rate limiting and timeout mechanisms

## Future Enhancements

### Protocol Improvements

- **Optimistic Consensus**: Reduce latency for non-conflicting operations
- **Partial Ordering**: Allow some operations to complete out of order
- **Adaptive Timeouts**: Dynamic timeout adjustment based on network conditions

### Scalability Enhancements

- **Hierarchical Clusters**: Multi-level cluster organization
- **Sharding**: Horizontal partitioning of data across clusters
- **Load Balancing**: Intelligent distribution of operations

### Reliability Improvements

- **Persistent State**: Survive node restarts during transactions
- **Advanced Recovery**: More sophisticated failure recovery mechanisms
- **Monitoring Integration**: Built-in monitoring and alerting

## Conclusion

The cluster client/service system provides a robust, secure, and scalable foundation for distributed consensus in the Optimystic database system. Its implementation of the 2-phase commit protocol ensures strong consistency while maintaining good performance characteristics and fault tolerance.

The system's design emphasizes:
- **Consistency**: Strong consistency guarantees through 2-phase commit
- **Reliability**: Comprehensive error handling and recovery mechanisms
- **Security**: Cryptographic verification and secure communication
- **Performance**: Optimized for low-latency distributed operations
- **Maintainability**: Clear separation of concerns and comprehensive logging 
