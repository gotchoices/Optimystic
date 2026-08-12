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
      // Built from protocolPrefix; never the bare /db-p2p form.
      '/optimystic/<network>/cluster/1.0.0'
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
- **Protocol ID**: `/optimystic/<network>/cluster/1.0.0` (built from `protocolPrefix`; override via `protocol`)
- **Message Format**: JSON-encoded cluster operation messages
- **Transport**: Length-prefixed streams over libp2p

**Implementation:**
```typescript
export class ClusterService implements Startable {
  private readonly protocol: string = '/optimystic/<network>/cluster/1.0.0';
  
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

When majority consensus is reached, the transaction is executed. Execution is guarded by a synchronous check-and-set on `executedTransactions` to prevent duplicate execution — JavaScript's single-threaded event loop makes this atomic as long as the guard runs before the first `await`.

The real `handleConsensus` lives on `ClusterMember` in `packages/db-p2p/src/cluster/cluster-repo.ts` (not in `cluster-coordinator.ts` — that is the *coordinator* side). The snippet below is a simplification: current code delegates the per-operation dispatch to `applyConsensusOperation` and, after the loop succeeds, writes a durable executed-marker via `stateStore.markExecuted` for post-restart dedup.

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
        await this.storageRepo.cancel(operation.cancel.actionRef);
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
  // Validate promise signatures. Reject on any failure; only report an
  // InvalidSignature penalty when the outcome proves the key belongs to peerId.
  const promiseHash = await this.computePromiseHash(record);
  for (const [peerId, signature] of Object.entries(record.promises)) {
    const outcome = await this.verifySignature(record, peerId, promiseHash, signature);
    if (!outcome.valid) {
      if (outcome.penalize) {
        this.reputation?.reportPeer(peerId, PenaltyReason.InvalidSignature, ...);
      }
      throw new Error(`Invalid promise signature from ${peerId}`);
    }
  }
  // Commit signatures follow the same pattern against computeCommitHash.
}
```

**Key ↔ peer-id binding.** `verifySignature` does not trust the public key a record
self-asserts for a peer. For a libp2p Ed25519 identity the peer id **is** the multihash
of the public key (`peerIdBindsPublicKey` in `cluster/peer-key-binding.ts`), so the
embedded key is checked against the id before the signature is verified. Without this a
coordinator could attribute a vote to any peer id `X` while signing it with a key it
controls (stored under `peers[X].publicKey`), and verification would pass.

`verifySignature` returns a `VerifyOutcome` (`{ valid:true } | { valid:false; penalize:boolean }`)
rather than a bare boolean, and is **total** on hostile input (it never throws):

- missing/empty key, non-Ed25519 id, key **not bound** to the peer id, or malformed
  key/signature bytes → `{ valid:false, penalize:false }` — reject, but do **not** report
  the named peer, whose id may be attacker-chosen;
- key **is** bound but the signature fails to verify → `{ valid:false, penalize:true }` —
  a genuine bad vote from a proven identity.

The binding proves a vote was signed by the key its id names; it does **not** decide which
peer ids are legitimately in the cohort (a coordinator can mint fresh keypairs whose ids
bind to their own keys). Sybil/cohort membership is a separate layer (cohort-topic
membership certificates). The dispute path (`dispute-service.ts`) applies the same binding
gate before penalizing a `false-approval`.

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
  protocolPrefix: '/optimystic/<network>',
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
- **Membership not admitted**: a member declines to vote on the coordinator's declared peer set. Carried as the `rejectReason` on the member's `reject` promise (not thrown), so it feeds the dispute accounting. Variants:
  - `membership-not-admitted:self-not-member` — the declared peer set does not contain this member; always enforced, never bypassed by `allowUnvalidatedSmallCluster`
  - `membership-not-admitted:below-floor (declared=D, floor=F, kEst=K)` — the member has a confident derived view of `K` peers and the declared set of `D` is below `⌈membershipAdmissionFraction · K⌉`
  - `membership-not-admitted:low-confidence-downsize (declared=D, floor=F, assumedClusterSize=A)` — the member has no confident network-size estimate, so the floor falls back to the operator-asserted `assumedClusterSize`. The numbers name the local setting that caused it: if `A` is larger than the cohort you actually run, lower `clusterPolicy.assumedClusterSize`
  - `membership-not-admitted:inconsistent-with-derived-view` — the declared set differs from the member's derived view by more than `clusterSizeTolerance · kEst` peers
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
- **Signature Verification**: Ed25519 signatures on promise and commit hashes are verified against the public key registered in `ClusterPeers` — but only after that key is confirmed to be the one the voting peer id provably names (`peerIdBindsPublicKey`). Without this binding a coordinator could attribute a vote to any peer id while signing with a key it controls; forged and unbound-key signatures are both rejected. See *Signature Verification* under *Cryptographic Security* for the full binding/penalty semantics.
- **Replay Protection**: `executedTransactions` cache (10-minute TTL) prevents re-execution of committed transactions

### Access Control

- **Peer Identity**: Ed25519 key pairs tied to libp2p peer IDs
- **Cluster Membership**: Only peers returned by `findCluster()` (via FRET) participate in consensus for a given block
- **Network-Membership Scoping**: When several networks share the same physical nodes/bootstraps, FRET's network-agnostic seeding can admit a peer that only belongs to *another* network (`control-B`) into this network's (`control-A`) routing ring. Such a peer registers a different (network-namespaced) `identify` protocol, so its identify never completes here and its peerStore protocol list stays empty forever. `Libp2pKeyPeerNetwork` (constructed with this network's `protocolPrefix`) classifies each candidate from its peerStore protocols as `serves` (advertises `${protocolPrefix}/cluster|repo/1.0.0`), `foreign` (advertises only another network's), or `unknown` (not yet identified — a fresh same-network peer *or* a permanent cross-network contaminant). `findCoordinator`/`findCluster` never select a `foreign` **or** `unknown` peer, and over-fetch a wider proximity band so a cross-network peer cannot displace a legitimate same-network coordinator from the nearest-`clusterSize` cohort. Both select from `serves` peers and self only: an `unknown` (possibly cross-network) peer is never gambled on, because a permanent cross-network contaminant and a fresh same-network peer mid-identify are indistinguishable while `unknown`, so picking one risks contaminating the write — its `cluster`/`repo` dial then negotiates a different network's protocol and fails. The membership filter re-reads the peerStore on every retry attempt, so an unconfirmed peer becomes selectable only once `identify` flips it to `serves` within the retry window; otherwise selection falls to self-coordination. `findCluster` keeps self plus the nearest `serves` peers only. A freshly-formed single-network mesh is not starved — when self is the only serving member the cohort is self-only, which completes the write under `allowClusterDownsize` (the default), and the legitimate peer is re-selected as `serves` on the caller's retry once its `identify` completes. When self is excluded and only `foreign`/`unknown` (not-yet-confirmed) peers remain, `findCoordinator` throws `NO_NETWORK_COORDINATOR` rather than a generic no-coordinator/super-majority error.
- **Self-Coordination Is Never Memoized**: `findCoordinator` keeps a 30-minute coordinator cache that is consulted ahead of every selection tier, but a pick of **self** is never written to it. During startup — before the first dial completes — FRET knows only this node, so the FRET tier legitimately picks self; caching that choice would keep every later read of the key pinned to this node's own (possibly stale) replica for the full cache lifetime even after real peers arrived, which is especially damaging for an addressless client that later updates cannot reach. Caching self buys nothing regardless: self is always reachable and both self-selecting tiers re-derive it locally with no dial and no retry sleep. The rule is enforced at the single write point — `recordCoordinator` ignores a self-valued write — because most writers are *outside* the class: it is public, and `NetworkTransactor` writes back whatever `findCoordinator` returned (including self) after each pend, while `RepoClient`/`ClusterClient` write redirect targets. Gating only the internal selection tiers would leave the transactor free to re-create the very entry this rule exists to prevent. Enforcing on write rather than sweeping the cache later also means a self entry never exists to be read, so the cache tier — which is consulted *ahead* of every guard-checking tier — can never hand back self. Finally, **every** tier that can select self first clears `shouldAllowSelfCoordination()`, not just the last-resort tier: a node that has previously seen a larger network and is currently isolated must refuse to serve its own data, and a self entry in the key's FRET neighborhood (essentially always on a small or forming network) must not be a way around that guard. A guard refusal on the FRET tier merely drops self from that tier's candidate list and lets selection fall through — a reachable remote peer is still preferred — so `SELF_COORDINATION_BLOCKED` is raised only when no other coordinator exists.

- **The Coordinator Retry Window Is Evidence-Gated**: `findCoordinator` sleeps 500ms between selection attempts only while it holds zero connections — and only when a peer could plausibly arrive during that sleep. The verdict is read fresh on each attempt from two signals: a non-self FRET neighbour for the key (exclusion- and ban-filtered; the membership filter is deliberately *not* applied, since an `unknown` peer flipping to `serves` mid-window is precisely the case the window exists for) and a dial libp2p is currently attempting (`queued`/`active` in `getDialQueue()`). With neither present the loop breaks to the self-coordination tier immediately, so a genuinely isolated node stops paying ~1s per block on operations that touch several blocks. It is *not* answered from configuration or history: `networkMode` is fixed at construction (any configured bootstrap address makes a node `'joining'` forever, whether or not it ever reached one) and `networkHighWaterMark` only ever rises, so both kept the window open on nodes that could never fill it — `networkMode` is now diagnostic-only, surviving in the `retry-futile` log line. The peerStore is deliberately *not* consulted: a peer with a peerStore record but no FRET entry and no in-flight dial is one nobody is currently attempting, so sleeping does not dial it, and the scan would add an async datastore iteration to a per-lookup hot path. The accepted cost is that an *inbound* connection landing during a skipped sleep loses one lookup's routing to self — self picks are never cached, so the next lookup picks the new peer up. Skipping the wait never skips a decision: the break falls into the same last-resort tier, so a partitioned write still fails with `SELF_COORDINATION_BLOCKED`, just ~1s sooner.

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
  clusterSize?: number;               // Replication factor / target cohort breadth (default 10)
  assumedClusterSize?: number;        // Smallest cohort the operator asserts exists (admission gate; default 2 via libp2p-node-base)
  membershipAdmissionFraction?: number; // Default 0.75 — fraction of the size reference a declared set must meet
}
```

**`clusterSize` vs `assumedClusterSize`.** These are two different questions and must not be conflated:

- `clusterSize` is **how many copies to keep** — the replication factor the coordinator aims for when
  selecting a cohort. It says nothing about how many peers exist. Nothing may use it as a security
  yardstick.
- `assumedClusterSize` is **how many peers the operator asserts genuinely exist** — normally
  `min(clusterSize, nodes you actually run)`. Two independent consumers read it:
  - The **membership admission gate**, only on the fallback path where the member has no confident
    network-size estimate (which is what a partition induces). There it stands in for the measured
    estimate: the declared peer set must be at least
    `max(minAbsoluteClusterSize, ⌈membershipAdmissionFraction · assumedClusterSize⌉)`. When absent
    altogether the gate treats the size as *unknown* and admits (legacy behavior), because refusing
    every write is the worse failure.
  - The **read-repair and reconcile corroboration floor** (`corroboratorCapacity` in
    `cluster/quorum-restore.ts`), unconditionally:
    `max(peers currently visible, repairCorroborationClusterSize − 1)` caps how many corroborators a
    restoration can be required to produce. An absent `assumedClusterSize` falls back to `clusterSize`
    instead of being treated as unknown — a block that stays unrepaired is degraded, not dead, so
    there is no reason to relax the floor for a caller that has not adopted the field.

**The two defaults differ on purpose.** `resolveClusterPolicy` (`cluster/cluster-policy.ts`) — the one
place `libp2p-node-base` applies these defaults — resolves the single operator field into *two* values:

- `assumedClusterSize` → the operator's value, else `minAbsoluteClusterSize` (2). Permissive, so an
  unconfigured two- or three-node mesh can still transact; the cost of being wrong here is a
  partition-induced downsize slipping past an unconfident node.
- `repairCorroborationClusterSize` → the operator's value, else `clusterSize` (default 10). Strict, so
  an unconfigured node's repair floor cannot be talked down to a single voter by a shrunken cohort
  view; the cost of being wrong here is only a block that stays unrepaired.

Declaring `clusterPolicy.assumedClusterSize` sets both. A large deployment should declare its real
cohort size, otherwise the admission gate cannot police a partition-induced downsize while its own size
estimate is unconfident. A genuine two-node mesh needs one setting to *self-repair* —
`clusterPolicy.assumedClusterSize: 2` (which does not lower the replication factor) or an honest
`clusterSize: 2` — though it transacts and votes unconfigured.

**Configuration in `libp2p-node-base.ts`:** the composition root no longer writes a config literal.
It resolves one, and hands the *same* object to the cluster member, the coordinator, and both
block-restoration paths, so those four cannot come up disagreeing:

```typescript
const consensusConfig = resolveClusterPolicy(options);   // cluster/cluster-policy.ts

const reconcileBlock = createReconcileBlock({
  ...,
  simpleMajorityThreshold: consensusConfig.simpleMajorityThreshold,
  repairCorroborationClusterSize: consensusConfig.repairCorroborationClusterSize
});
const clusterImpl = clusterMember({ ..., consensusConfig, reconcileBlock });
const coordinatorRepoFactory = coordinatorRepo(keyNetwork, createClusterClient, { ...consensusConfig }, fretSvc);
```

Note `minAbsoluteClusterSize`: `resolveClusterPolicy` sets it to `2`, whereas `ClusterMember` and
`CoordinatorRepo` each fall back to `3` when constructed directly (embedders, tests). A real node
therefore runs at `2` on both sides — consistent, but not the number the interface's own default
suggests.

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
