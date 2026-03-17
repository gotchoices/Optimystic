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

### Phase 1: Promise Collection (Super-Majority Required)

During the promise phase, each peer evaluates whether they can commit to the transaction. **The coordinator requires a super-majority (default 3/4) of promises** to proceed to the commit phase, providing stronger consensus guarantees than simple majority.

```typescript
private async handlePromiseNeeded(record: ClusterRecord): Promise<ClusterRecord> {
  // Check for conflicts with existing transactions
  // Uses race resolution: transaction with more promises wins
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

**Super-Majority Validation** (in ClusterCoordinator):
```typescript
const superMajority = Math.ceil(peerCount * this.cfg.superMajorityThreshold); // Default 0.75
if (promiseCount < superMajority) {
  throw new Error(`Failed to get super-majority: ${promiseCount}/${peerCount}`);
}
```

### Phase 2: Commit Execution (Simple Majority Required)

Once super-majority promises are collected, the commit phase begins. **Commits only require a simple majority (>50%)** to prove commitment. The coordinator can return success to the client as soon as majority commits are received, with remaining propagation happening in the background via the [commit retry loop](#commit-retry-loop).

Each cluster member transitions to the commit phase when it sees enough approving promises (based on its configured threshold):

```typescript
private async handleCommitNeeded(record: ClusterRecord): Promise<ClusterRecord> {
  // Verify super-majority of approving promises are present
  const peerCount = Object.keys(record.peers).length;
  const approvalCount = Object.values(record.promises)
    .filter(sig => sig.type === 'approve').length;
  const superMajority = Math.ceil(peerCount * this.cfg.superMajorityThreshold);

  if (approvalCount < superMajority) {
    return record; // Not enough approvals yet
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

When majority consensus is reached, the transaction is executed. Execution is guarded by a synchronous check-and-set on `executedTransactions` to prevent duplicate execution — JavaScript's single-threaded event loop makes this atomic as long as the guard runs before the first `await`:

```typescript
private async handleConsensus(record: ClusterRecord): Promise<void> {
  // ATOMIC: synchronous check-and-set before any await
  if (this.executedTransactions.has(record.messageHash)) {
    return; // Already executed — idempotent
  }
  this.executedTransactions.set(record.messageHash, Date.now());

  try {
    for (const operation of record.message.operations) {
      if ('pend' in operation) {
        await this.storageRepo.pend(operation.pend);
      } else if ('commit' in operation) {
        await this.storageRepo.commit(operation.commit);
      } else if ('cancel' in operation) {
        await this.storageRepo.cancel(operation.cancel.trxRef);
      } else if ('get' in operation) {
        await this.storageRepo.get(operation.get);
      }
    }
  } catch (err) {
    this.executedTransactions.delete(record.messageHash); // Allow retry on failure
    throw err;
  }
}
```

### Dispute Marking

When a minority of peers reject the transaction but the super-majority threshold is still met, the coordinator marks the record as **disputed** and attaches evidence. This allows upper layers (e.g., the [Right-is-Right dispute protocol](../../../docs/right-is-right.md)) to track dissent and potentially escalate:

```typescript
if (rejectionCount > 0 && approvalCount >= superMajority) {
  record.disputed = true;
  record.disputeEvidence = {
    rejectingPeers: [...dissenting peer IDs],
    rejectReasons: { [peerId]: reason }
  };
}
```

Dispute evidence is carried on the `ClusterRecord` and propagated to all cluster members during the commit phase.

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

### Race Resolution

When two transactions conflict (operate on the same blocks), the system uses deterministic race resolution:

```typescript
private resolveRace(existing: ClusterRecord, incoming: ClusterRecord): 'keep-existing' | 'accept-incoming' {
  const existingCount = Object.keys(existing.promises).length;
  const incomingCount = Object.keys(incoming.promises).length;
  
  // Transaction with more promises wins
  if (existingCount > incomingCount) return 'keep-existing';
  if (incomingCount > existingCount) return 'accept-incoming';
  
  // Tie-breaker: higher message hash wins (deterministic)
  return existing.messageHash > incoming.messageHash ? 'keep-existing' : 'accept-incoming';
}
```

**Resolution Strategies:**
- **Promise Count Wins**: Transaction with more promises has made more progress
- **Deterministic Tie-Breaking**: Hash comparison ensures all peers make the same decision
- **Automatic Abort**: Losing transaction is cleanly aborted
- **Parallel Non-Conflicting**: Transactions on different blocks proceed in parallel

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

### Commit Retry Loop

Once the tail block commits, the coordinator now tracks any peers that promised but failed to acknowledge their commit. These peers are treated as *in-doubt* participants and are retried with exponential backoff until:

- The peer acknowledges the commit and the local record reflects its signature; or
- The retry budget is exhausted (defaults: 5 attempts, growth capped at 30 s intervals).

Retries reuse the original `ClusterRecord` so peers that missed the initial commit can still apply the operation idempotently.

A successful retry clears the pending list; hitting the max attempts emits `cluster-tx:retry-abort` so operators can intervene. The coordinator keeps the transaction in memory while any peers remain unfixed, ensuring follow-up requests (reads, additional commits) see a consistent state.

Cluster members are idempotent: they ignore duplicate commits once their signature is present, so forced retries do not double-apply user operations.

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
// Create cluster member with storage repo and signing key
const clusterMember = new ClusterMember(
  storageRepo,
  peerNetwork,
  peerId,
  privateKey
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

### Error Conditions

Errors are thrown as plain `Error` instances with descriptive messages. Key error conditions:

- **Cluster too small**: `Cluster size N below minimum M and not validated` — cluster doesn't meet `minAbsoluteClusterSize` and FRET validation failed
- **Downsize rejected**: `Cluster size N below configured minimum M` — `allowClusterDownsize` is false and cluster shrank
- **Super-majority failed**: `Failed to get super-majority: N/M approvals (needed K, R rejections)` — too few approving promises
- **Validator rejection**: `Transaction rejected by validators (N/M rejected): reasons` — rejection count exceeds `maxAllowedRejections`
- **Expiration**: `Transaction expired` — transaction's `message.expiration` timestamp passed
- **Hash mismatch**: `Message hash mismatch` — incoming record's message doesn't match its hash (forgery detection)
- **Signature invalid**: `Invalid promise/commit signature from peerId` — cryptographic signature verification failed

### Monitoring Metrics

- **Active Transactions**: Count of ongoing consensus operations
- **Success Rate**: Percentage of successful consensus operations
- **Average Latency**: Time from initiation to consensus
- **Conflict Rate**: Percentage of transactions that conflict
- **Peer Connectivity**: Health of connections to cluster peers

## Security Considerations

### Cryptographic Integrity

- **Message Hashing**: SHA-256 hashes (base58btc encoded) uniquely identify transactions
- **Signature Verification**: Ed25519 signatures on promise and commit hashes are verified against the public key registered in `ClusterPeers`; forged signatures are rejected
- **Replay Protection**: `executedTransactions` cache (10-minute TTL) prevents re-execution of committed transactions

### Access Control

- **Peer Identity**: Ed25519 key pairs tied to libp2p peer IDs
- **Cluster Membership**: Only peers returned by `findCluster()` (via FRET) participate in consensus for a given block

### Attack Mitigation

- **Forgery Detection**: Message hash is validated against message content; mismatches are rejected
- **Byzantine Tolerance**: Super-majority threshold (default 75%) means both halves of a 50/50 partition cannot commit; up to 25% Byzantine nodes are tolerated
- **Equivocation Detection**: `detectEquivocation()` in `mergeRecords()` compares existing vs incoming vote types for each peer. If a peer changes their vote (approve↔reject) for the same transaction, the first-seen signature is preserved and a `PenaltyReason.Equivocation` penalty (weight 100) is applied. A single equivocation exceeds the default ban threshold (80), resulting in immediate peer exclusion. Same-type re-delivery (retransmission) is not flagged.
- **Timeout / DoS**: Transaction expiration and cleanup intervals (60s queue, 1s process) prevent resource exhaustion from stale transactions
- **Reputation**: Failed peers are reported via `IPeerReputation` with `PenaltyReason.ConsensusTimeout`

## Network Size Estimation and Partition Detection

The cluster system integrates with FRET (Finger Ring Ensemble Topology) for network-wide size estimation and partition detection.

### Network Size Tracking

Cluster records include network size hints from the coordinator:

```typescript
export interface ClusterRecord {
  messageHash: string;
  peers: ClusterPeers;
  message: RepoMessage;
  promises: Record<string, Signature>;
  commits: Record<string, Signature>;
  coordinatingBlockIds?: BlockId[];    // Block IDs driving cluster selection
  suggestedClusterSize?: number;       // Cluster size observed by coordinator
  minRequiredSize?: number;            // Minimum required (when allowClusterDownsize=false)
  networkSizeHint?: number;            // FRET network size estimate
  networkSizeConfidence?: number;      // Confidence in estimate (0-1)
  disputed?: boolean;                  // True when minority rejected but super-majority approved
  disputeEvidence?: {                  // Evidence of dissent for dispute protocol
    rejectingPeers: string[];
    rejectReasons: Record<string, string>;
  };
}
```

**Size Observation Sources:**
- **FRET Digitree**: Primary source from chord ring topology
- **Ping Responses**: Peers share size estimates in ping messages
- **Cluster Messages**: Coordinators propagate size hints
- **Neighbor Announcements**: FRET announcements include size estimates

### Small Cluster Validation

When cluster size falls below minimum (default 3), the coordinator validates it's not a partition:

```typescript
private async validateSmallCluster(localSize: number): Promise<boolean> {
  const estimate = this.fretService.getNetworkSizeEstimate();
  
  if (estimate.confidence > 0.5) {
    // Check if estimates are within same order of magnitude
    const orderOfMagnitude = Math.floor(Math.log10(estimate.size_estimate + 1));
    const localOrderOfMagnitude = Math.floor(Math.log10(localSize + 1));
    
    return Math.abs(orderOfMagnitude - localOrderOfMagnitude) <= 1;
  }
  
  return true; // Accept in development without confident estimate
}
```

### Partition Detection

FRET monitors for network partitions using multiple signals:

- **Sudden Size Drop**: >50% reduction in network size estimate
- **High Churn Rate**: >10% peers/minute joining or leaving
- **Mass Unreachability**: Multiple peers suddenly unreachable
- **Goodbye Tracking**: Explicit leave messages vs silent failures

## Configuration Options

The cluster system supports comprehensive configuration through `ClusterConsensusConfig`:

```typescript
interface ClusterConsensusConfig {
  superMajorityThreshold: number;     // Default 0.75 (3/4)
  simpleMajorityThreshold: number;    // Default 0.51 (>50%)
  minAbsoluteClusterSize: number;     // Default 3
  allowClusterDownsize: boolean;      // Default true
  clusterSizeTolerance: number;       // Default 0.5 (50% variance)
  partitionDetectionWindow: number;   // Default 60000ms (1 min)
}
```

**Configuration in libp2p-node.ts:**
```typescript
const coordinatorRepoFactory = coordinatorRepo(
  keyNetwork,
  createClusterClient,
  {
    clusterSize: 10,
    superMajorityThreshold: 0.75,
    simpleMajorityThreshold: 0.51,
    minAbsoluteClusterSize: 3,
    allowClusterDownsize: true,
    clusterSizeTolerance: 0.5,
    partitionDetectionWindow: 60000
  },
  fretService
);
```

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
