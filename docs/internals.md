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

### Collection Header Blocks
- Header blockId = collection name (deterministic)
- All nodes MUST share the same header block for a collection
- `Collection.createOrOpen()` checks local storage first, then cluster

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

