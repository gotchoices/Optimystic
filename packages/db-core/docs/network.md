# Network Transactor Architecture

The Network Transactor solves the fundamental challenge of **atomic transactions across content-addressed distributed storage**. Unlike traditional databases where related data resides on a single server, Optimystic's content-addressed blocks are distributed across multiple independent peers based on their block IDs, not their logical relationships.

## The Fundamental Problem

### Distributed Content Addressing Challenge

In a content-addressed system, **blocks are distributed by their hash/ID**, not by logical grouping:

```
Transaction affects blocks: [block-A, block-B, block-C]
Network distribution:
- block-A → managed by peers [P1, P2, P3] (cluster-A)  
- block-B → managed by peers [P3, P4, P5] (cluster-B)
- block-C → managed by peers [P5, P6, P7] (cluster-C)
```

**Key challenges:**
1. **Atomic Coordination**: All blocks must be updated atomically, despite being managed by different clusters
2. **Overlapping Clusters**: Peers may participate in multiple clusters (P3 and P5 above)
3. **Independent Failures**: Any cluster or peer can fail independently during the transaction
4. **Content Routing**: Must deterministically locate the responsible peers for each block
5. **Consensus Ordering**: Must establish a consistent transaction order across all involved clusters

### Why Traditional Approaches Fail

- **Single Coordinator**: Cannot handle the peer/cluster failures and network partitions
- **Broadcast Protocols**: Too expensive when only subset of peers are involved
- **Block-by-Block**: Cannot maintain atomicity across related blocks
- **Logical Grouping**: Contradicts content-addressing principles

## Architectural Solution

### Core Strategy: Cluster-Aware Distributed Consensus

The Network Transactor solves distributed content-addressing through **cluster-aware coordination**:

1. **Content-to-Cluster Mapping**: Use deterministic hashing to map each block to its responsible cluster
2. **Parallel Cluster Coordination**: Execute operations across multiple clusters simultaneously  
3. **Two-Phase Atomic Commit**: Ensure atomicity across all involved clusters
4. **Log-First Ordering**: Establish transaction ordering through append-only logs
5. **Failure-Aware Retry**: Handle individual peer and cluster failures gracefully

### Network Abstraction Layers

The architecture separates concerns through three key abstractions:

```typescript
// Content addressing and cluster discovery
interface IKeyNetwork {
  findCoordinator(key: Uint8Array): Promise<PeerId>;
  findCluster(key: Uint8Array): Promise<ClusterPeers>;
}

// Peer communication infrastructure
interface IPeerNetwork {
  connect(peerId: PeerId, protocol: string): Promise<Stream>;
}

// Cluster repository operations
interface IRepo {
  get / pend / commit / cancel operations
}
```

**Why this separation matters:**
- **IKeyNetwork**: Abstracts away DHT implementation details and cluster topology
- **IPeerNetwork**: Isolates network transport from application logic  
- **IRepo**: Provides uniform cluster interface regardless of internal cluster organization

## Distributed Coordination Algorithm

### Step 1: Content-to-Cluster Mapping

**Problem**: Given a block ID, which cluster is responsible for coordinating it?

**Solution**: Deterministic content addressing through consistent hashing

```
blockId → hash(blockId) → keyspace region → responsible cluster
```

- **Coordinator Discovery**: Find the primary peer responsible for a block
- **Cluster Discovery**: Find all peers in the cluster for redundancy
- **Failure Handling**: Exclude failed peers and find alternative coordinators

**Why this works:**
- **Deterministic**: Same block always maps to same cluster
- **Distributed**: Coordination responsibility is spread across network
- **Fault Tolerant**: Multiple peers can coordinate the same keyspace region

### Step 2: Parallel Cluster Operations

**Problem**: A single transaction affects blocks managed by different clusters

**Solution**: Batch operations by cluster and execute in parallel

```
Transaction: [block-A, block-B, block-C]
Mapping:
- cluster-1: operates on [block-A] 
- cluster-2: operates on [block-B, block-C]

Execute: cluster-1.pend() || cluster-2.pend()  // in parallel
```

**Why parallel execution matters:**
- **Performance**: Don't wait for sequential cluster coordination
- **Failure Isolation**: One cluster failure doesn't block others
- **Network Efficiency**: Reduce round-trip latency

### Step 3: Two-Phase Distributed Commit

**Problem**: Ensure atomicity across all clusters involved in transaction

**Solution**: Classic two-phase commit adapted for content-addressed clusters

```
Phase 1 (Pend): Reserve transaction slots across all clusters
Phase 2 (Commit): Apply changes atomically across all clusters
```

**Failure handling:**
- **Pend failures**: Cancel all pending operations and return conflict information
- **Commit failures**: Cannot occur after tail commit succeeds (log-first ordering)
- **Network failures**: Retry with different cluster coordinators

## Coordination Strategy

### Log-First Transaction Ordering

**The Critical Insight**: In a distributed content-addressed system, transaction ordering must be established independently of the specific blocks being modified.

**Solution**: Use the collection's append-only log as the single source of transaction ordering

```
1. Collection Header (optional): Establish collection existence
2. Log Tail: CRITICAL - establishes global transaction order  
3. Other Blocks: Apply changes with order already determined
```

**Why log-first ordering works:**
- **Single Point of Ordering**: Each collection has one log, eliminating ordering conflicts
- **Append-Only Semantics**: Log appends are naturally serializable
- **Failure Recovery**: If tail commit succeeds, transaction will eventually complete
- **Distributed Consensus**: All clusters agree on log-established ordering

### Failure Handling Strategy

**Network-Level Failures:**
```
Peer Failure → Find alternative coordinator for affected blocks
Cluster Failure → Retry with backup clusters  
Network Partition → Operations continue in connected partition
```

**Transaction-Level Conflicts:**
```
Pend Conflict → Cancel all pending, return conflict info to collection layer
Commit Conflict → Cannot happen after tail commit (ordering established)
Missing Transactions → Return newer committed transactions for rebasing
```

**Recovery Mechanism:**
- **Background Cancellation**: Failed transactions are cancelled across all involved clusters
- **Conflict Consolidation**: Multiple cluster conflicts are merged into single response
- **Retry Coordination**: Failed operations are retried with alternative coordinators

### Network Efficiency Optimizations

**Batching by Cluster:**
- Group blocks by responsible cluster before network operations
- Execute parallel operations across multiple clusters
- Minimize network round-trips through cluster-aware batching

**Coordinator Caching:**
- Deterministic block-to-coordinator mapping enables caching
- Failed coordinators are excluded from subsequent operations
- Network topology changes are handled through cache invalidation

**Timeout Management:**
- Operations have configurable timeouts to prevent indefinite blocking
- Background cleanup ensures failed transactions don't consume resources
- Graceful degradation when network conditions deteriorate

## Why This Architecture Succeeds

### Solving Content-Addressing vs. Transaction Atomicity

**Traditional Problem**: Content-addressed distribution scatters logically related blocks across independent clusters
**Solution**: Establish transaction ordering independently through dedicated log blocks, then apply changes based on that ordering

### Handling Distributed Consensus at Scale

**Traditional Problem**: Consensus algorithms don't scale well across large networks with dynamic membership
**Solution**: Use content-addressing to partition consensus domains, run parallel consensus within each cluster

### Achieving Fault Tolerance Without Centralization

**Traditional Problem**: Centralized coordinators create single points of failure
**Solution**: Deterministic coordinator selection with failure exclusion and retry mechanisms

### Maintaining Performance Under Network Conditions

**Traditional Problem**: Network partitions and peer failures can block entire systems
**Solution**: Graceful degradation, parallel execution, and timeout-based recovery ensure continuous operation

The Network Transactor architecture enables Optimystic to maintain **ACID transaction properties** across **content-addressed distributed storage** while achieving **horizontal scalability** and **fault tolerance** - solving the fundamental tension between content addressing and transaction coordination.

