# Multi-Collection Transactions with Pluggable Validation

## Overview

This document describes the architecture for multi-collection transactions in Optimystic, with support for pluggable validation engines. The primary use case is SQL-validated transactions where cluster participants independently validate by re-executing SQL statements.

## Terminology

To support multi-collection transactions, we introduce a clear hierarchy:

- **Operation**: A mutation to a single block (lowest level)
- **Action**: A logical mutation to a single collection, resulting in one or more operations
- **Transaction**: A logical mutation spanning multiple collections, resulting in one or more actions per collection

## Current Architecture (Single-Collection)

Currently, transactions are scoped to a single collection:

1. **Client** executes logical actions (e.g., `tree.replace()`)
2. **Actions** translate to block operations
3. **Pend Phase**: Client sends block operations to all affected block clusters
4. **Commit Phase**: Client commits to the collection's log tail cluster
5. **Propagate Phase**: Client propagates commit to remaining block clusters
6. **Checkpoint Phase**: Client appends checkpoint to log

**Key Point**: The collection's log tail cluster achieves consensus and orders the action. Each collection has a **critical block** (the log tail) whose managing cluster determines whether the action advances.

### Problem: Multi-Collection Operations

Many logical operations affect multiple collections:
- **SQL DML**: A single INSERT/UPDATE/DELETE may update main table + multiple indexes
- **Constraint validation**: Requires validating against current state
- **Atomic semantics**: All collections must commit or none

Additionally, for SQL validation:
- Cluster participants need to validate SQL semantics (constraints, collations, triggers)
- Validation requires re-executing the transaction with the same engine and schema

## Proposed Architecture

### Core Principles

1. **Coordinator-centric API**: TransactionCoordinator is the ONLY interface for all mutations (single or multi-collection)
2. **Immediate local execution**: Actions are executed immediately through collections to update local snapshots
3. **Transaction context orchestration**: TransactionContext coordinates multi-collection commits
4. **Snapshot isolation**: Collections maintain local trackers that reflect pending changes before network commit
5. **Transactions span collections**: A transaction captures a logical mutation that may affect multiple collections
6. **Pluggable execution engines**: The transaction payload is engine-specific (SQL for Quereus, actions for testing, etc.)
7. **Critical cluster consensus**: All log tail clusters (critical blocks) must participate in consensus
8. **Deterministic replay**: Validators re-execute the transaction payload and verify the resulting actions match
9. **Actions with return values**: Actions can return results (for reads, queries, etc.)
10. **Collection-specific operations**: Collections define their own action types (Tree has scan, Diary has append, etc.)

### Transaction Structure

```typescript
type Transaction = {
  // Engine identification
  engine: string;  // e.g., "quereus@0.5.3"

  // Engine-specific payload
  payload: string;  // For Quereus: JSON-encoded SQL statements; for testing: JSON-encoded actions

  // Read dependencies for optimistic concurrency control
  reads: ReadDependency[];

  // Transaction identifier (used for deduplication, auditing)
  transactionId: string;  // Hash of peer ID + timestamp

  // Content identifier (hash of all above fields)
  cid: string;  // Cryptographic hash for integrity
};

type ReadDependency = {
  blockId: BlockId;
  revision: number;  // Expected revision
};

// Actions reference the transaction they came from
type Action<T> = {
  type: ActionType;
  data: T;
  transaction?: string; // Transaction CID (for multi-collection txns)
};

// Action handlers can return values (for reads, queries, etc.)
type ActionHandler<T, TResult = void> = (
  action: Action<T>,
  store: BlockStore<IBlock>
) => Promise<TResult>;
```

### Transaction Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Application                       │
│  1. Create TransactionContext via coordinator.begin()       │
│  2. Add actions to context (reads and writes)               │
│     • Actions are IMMEDIATELY executed through collections  │
│     • Collections update local trackers (snapshot isolation)│
│     • Actions tagged with transaction reference             │
│  3. Call context.commit()                                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Transaction Coordinator (db-core)              │
│                                                             │
│  Step 1: Collect transforms from collections                │
│    • Collections already have transforms in their trackers  │
│    • Transforms generated when actions were added           │
│                                                             │
│  Step 2: Create transaction payload                         │
│    • Bundle all collection actions                          │
│    • Include read dependencies                              │
│    • Generate transaction CID                               │
│                                                             │
│  Phase 1: GATHER (only if multiple collections affected)    │
│    • Identify all affected collections                      │
│    • Identify critical block (log tail) for each collection │
│    • Query each critical cluster for participant nominees   │
│    • Merge nominees into supercluster list                  │
│    • Nodes spot-check nominees from other neighborhoods     │
│    • Skip this phase if only one collection affected        │
│                                                             │
│  Phase 2: PEND                                              │
│    • Send transaction + operations to all block clusters    │
│    • Include supercluster nominee list (if multi-collection)│
│    • Clusters validate and prepare (but don't commit)       │
│                                                             │
│  Phase 3: COMMIT                                            │
│    • Send commit to all critical clusters (log tails)       │
│    • Each critical cluster achieves consensus               │
│    • All must succeed for transaction to proceed            │
│                                                             │
│  Phase 4: PROPAGATE (managed by clusters)                   │
│    • Clusters finalize their local changes                  │
│    • Client doesn't manage this phase                       │
│                                                             │
│  Phase 5: CHECKPOINT (managed by clusters)                  │
│    • Clusters append to their collection's log              │
│    • Each collection records its actions from transaction   │
│    • Client doesn't manage this phase                       │
│                                                             │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Cluster Participants (Validators)              │
│                                                             │
│  During PEND Phase:                                         │
│    1. Receive Transaction + proposed operations             │
│    2. Verify engine version matches local                   │
│    3. Verify read dependencies (no stale reads)             │
│    4. Re-execute payload through local engine               │
│    5. Compare resulting actions with proposed               │
│    6. Vote accept/reject based on match                     │
│                                                             │
│  During COMMIT Phase (critical clusters only):              │
│    1. Achieve consensus with other critical clusters        │
│    2. Commit to log if consensus reached                    │
│                                                             │
│  During PROPAGATE Phase (cluster-managed):                  │
│    1. Finalize local block changes                          │
│    2. Make changes visible                                  │
│                                                             │
│  During CHECKPOINT Phase (cluster-managed):                 │
│    1. Append actions to collection log                      │
│    2. Include transaction CID reference                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## The GATHER Phase: Critical Cluster Coordination

The GATHER phase is the key innovation for multi-collection transactions. It solves the problem: **How do we achieve consensus across multiple collections, each with its own log tail cluster?**

### The Problem

In single-collection transactions:
- One collection → one log tail → one critical cluster
- That cluster achieves consensus and orders the transaction
- Simple and scalable

In multi-collection transactions:
- Multiple collections → multiple log tails → multiple critical clusters
- All critical clusters must agree for atomicity
- But clusters may be in different network neighborhoods
- Clusters may not know about each other's participants

### The Solution: Temporary Supercluster

The GATHER phase creates a temporary supercluster for consensus (only when multiple collections are affected):

1. **Check Collection Count**: If only one collection affected, skip GATHER and use normal single-collection consensus

2. **Identify Critical Clusters**: For each affected collection, identify the cluster managing its log tail block

3. **Query Nominees**: Ask each critical cluster: "Who are your nominated participants for consensus?"

4. **Merge Nominees**: Combine all nominee lists into a supercluster nominee list

5. **Spot-Check Reasonableness**: Nodes validate nominees from other neighborhoods using available routing data

6. **Use for Consensus**: The supercluster nominee list is used for PEND/COMMIT phases

### Why This Works

- **No Persistent Structure**: Supercluster exists only for this transaction
- **Leverages Existing Clusters**: Each critical cluster nominates based on its local knowledge
- **Spot-Checking**: Nodes can validate nominees they don't know using routing heuristics
- **Scalable**: No global coordinator or bottleneck
- **Atomic**: All critical clusters must agree in COMMIT phase

### Example

Transaction affects 3 collections (main table + 2 indexes):

```
Collection A (main table)
  └─ Log tail block: 0xABCD
      └─ Critical cluster: {peer1, peer2, peer3}

Collection B (index 1)
  └─ Log tail block: 0x1234
      └─ Critical cluster: {peer4, peer5, peer6}

Collection C (index 2)
  └─ Log tail block: 0x5678
      └─ Critical cluster: {peer7, peer8, peer9}

GATHER Phase:
  Query 0xABCD cluster → nominees: {peer1, peer2, peer3}
  Query 0x1234 cluster → nominees: {peer4, peer5, peer6}
  Query 0x5678 cluster → nominees: {peer7, peer8, peer9}

  Supercluster: {peer1, peer2, peer3, peer4, peer5, peer6, peer7, peer8, peer9}

COMMIT Phase:
  All 9 peers must achieve consensus
  Transaction commits only if all critical clusters agree
```

## Key Components

### 1. Transaction Type (db-core)

The core transaction structure in db-core:

```typescript
// In db-core/src/transaction/transaction.ts
export type Transaction = {
  // Engine identification (name + version)
  engine: string;

  // Engine-specific payload (opaque to db-core)
  payload: string;

  // Read dependencies for optimistic concurrency control
  reads: ReadDependency[];

  // Transaction identifier
  transactionId: string;

  // Content identifier (hash of engine + payload + reads + transactionId)
  cid: string;

  // Resulting actions per collection (captured during execution)
  actions: Map<CollectionId, Action<unknown>[]>;
};

export type ReadDependency = {
  blockId: BlockId;
  revision: number;
};

// Actions now carry their transaction context
export type Action<T> = {
  type: ActionType;
  data: T;

  // NEW: Transaction context
  transaction?: {
    cid: string;  // Reference to parent transaction
    // Optionally embed full transaction for validation
    full?: Transaction;
  };
};
```

### 2. Built-in Transaction Plugin (db-core)

For testing and simple use cases, db-core provides a built-in plugin:

```typescript
// In db-core/src/transaction/plugins/action-plugin.ts
export const ACTION_TRANSACTION_ENGINE = "action-tx@1.0.0";

export type ActionTransactionPayload = {
  // Direct specification of actions per collection
  actions: Array<{
    collectionId: CollectionId;
    actions: Action<unknown>[];
  }>;
};

// This plugin simply executes the actions as specified
// No validation beyond basic structure
```

This allows testing multi-collection transactions without Quereus.

### 3. Quereus Transaction Plugin (quereus-plugin-optimystic)

The Quereus-specific transaction engine:

```typescript
// In quereus-plugin-optimystic/src/transaction/quereus-engine.ts
export const QUEREUS_TRANSACTION_ENGINE = "quereus-sql@1.0.0";

export type QuereusTransactionPayload = {
  // SQL statements in execution order
  statements: Array<{
    sql: string;
    params: SqlValue[];
  }>;

  // Schema version hash (all participants must match)
  schemaVersion: string;

  // Context values for determinism
  contextValues: Record<string, SqlValue>;
};

// Transaction capture during SQL execution
class TransactionCapture {
  statements: Array<{ sql: string; params: SqlValue[] }> = [];
  reads: ReadDependency[] = [];
  affectedCollections = new Set<CollectionId>();
  contextValues: Record<string, SqlValue> = {};
}

class OptimysticModule implements VirtualTableModule {
  private currentTransaction?: TransactionCapture;

  async xBegin(context: VirtualTableContext): Promise<void> {
    this.currentTransaction = new TransactionCapture();
  }

  async xUpdate(context: VirtualTableContext, ...): Promise<void> {
    // Capture the SQL statement
    if (this.currentTransaction && context.sql) {
      this.currentTransaction.statements.push({
        sql: context.sql,
        params: context.params || []
      });
    }

    // Execute the operation (existing code)
    // ...

    // Track affected collections
    this.currentTransaction?.affectedCollections.add(this.collectionId);
    for (const indexId of this.indexManager.getIndexCollectionIds()) {
      this.currentTransaction?.affectedCollections.add(indexId);
    }
  }

  async xCommit(context: VirtualTableContext): Promise<void> {
    if (!this.currentTransaction) return;

    // Create Quereus payload
    const payload: QuereusTransactionPayload = {
      statements: this.currentTransaction.statements,
      schemaVersion: await this.schemaManager.getSchemaHash(),
      contextValues: this.currentTransaction.contextValues
    };

    // Create Transaction
    const transactionId = generateTransactionId();
    const transaction: Transaction = {
      engine: QUEREUS_TRANSACTION_ENGINE,
      payload: JSON.stringify(payload),
      reads: this.currentTransaction.reads,
      transactionId,
      cid: computeCID({ engine, payload, reads, transactionId }),
      actions: await this.captureActions()
    };

    // Execute through transaction coordinator
    await this.coordinator.executeTransaction(transaction);

    this.currentTransaction = undefined;
  }
}
```

**Required**: Quereus must pass SQL through `VirtualTableContext`:

```typescript
// In quereus/src/vtab/context.ts
export interface VirtualTableContext {
  // ... existing fields ...
  sql?: string;
  params?: SqlValue[];
}
```

### 4. Transaction Coordinator (db-core)

Coordinates multi-collection transactions with critical cluster consensus:

```typescript
// In db-core/src/transaction/coordinator.ts
export class TransactionCoordinator {
  constructor(
    private transactor: ITransactor,
    private collections: Map<CollectionId, Collection>
  ) {}

  async executeTransaction(transaction: Transaction): Promise<void> {
    // Extract block operations from all actions
    const blockOps = this.extractBlockOperations(transaction.actions);

    // Group operations by cluster
    const clusterGroups = this.groupByCluster(blockOps);

    // Identify critical clusters (log tail clusters for affected collections)
    const criticalClusters = await this.getCriticalClusters(
      Array.from(transaction.actions.keys())
    );

    // Execute 5-phase consensus
    await this.executeConsensus(transaction, clusterGroups, criticalClusters);
  }

  private async executeConsensus(
    transaction: Transaction,
    clusterGroups: Map<ClusterId, BlockOperation[]>,
    criticalClusters: Set<ClusterId>
  ): Promise<void> {
    // Phase 1: GATHER - Collect critical cluster nominees
    const superclusterNominees = await this.gatherPhase(criticalClusters);

    // Phase 2: PEND - Distribute to all block clusters
    await this.pendPhase(transaction, clusterGroups, superclusterNominees);

    // Phase 3: COMMIT - Consensus across critical clusters
    await this.commitPhase(transaction, criticalClusters);

    // Phase 4: PROPAGATE - Finalize on block clusters
    await this.propagatePhase(transaction, clusterGroups);

    // Phase 5: CHECKPOINT - Record in collection logs
    await this.checkpointPhase(transaction);
  }

  private async gatherPhase(
    criticalClusters: Set<ClusterId>
  ): Promise<Set<PeerId> | null> {
    // Skip GATHER if only one collection affected
    if (criticalClusters.size === 1) {
      return null; // Use normal single-collection consensus
    }

    // Query each critical cluster for their participant nominees
    const nomineesByCluster = await Promise.all(
      Array.from(criticalClusters).map(clusterId =>
        this.transactor.queryClusterNominees(clusterId)
      )
    );

    // Merge into supercluster nominee list
    const supercluster = new Set<PeerId>();
    for (const nominees of nomineesByCluster) {
      for (const nominee of nominees) {
        // Nodes can spot-check nominees from other neighborhoods
        // based on routing data they have
        if (this.isReasonableNominee(nominee)) {
          supercluster.add(nominee);
        }
      }
    }

    return supercluster;
  }
}
```

### 5. Transaction Validator (quereus-plugin-optimystic)

Cluster participants validate transactions by re-executing:

```typescript
// In quereus-plugin-optimystic/src/transaction/validator.ts
export class QuereusTransactionValidator {
  constructor(private db: Database) {}

  async validate(
    transaction: Transaction,
    requestedOps: BlockOperation[]
  ): Promise<ValidationResult> {
    // 1. Verify engine matches
    if (!transaction.engine.startsWith('quereus-sql@')) {
      return {
        valid: false,
        reason: `Unknown engine: ${transaction.engine}`
      };
    }

    // 2. Parse payload
    const payload: QuereusTransactionPayload = JSON.parse(transaction.payload);

    // 3. Verify schema version
    const localSchemaVersion = await this.getSchemaVersion();
    if (localSchemaVersion !== payload.schemaVersion) {
      return {
        valid: false,
        reason: `Schema mismatch: local=${localSchemaVersion}, tx=${payload.schemaVersion}`
      };
    }

    // 4. Verify read dependencies (optimistic concurrency control)
    for (const read of transaction.reads) {
      const currentRevision = await this.getBlockRevision(read.blockId);
      if (currentRevision !== read.revision) {
        return {
          valid: false,
          reason: `Stale read: block=${read.blockId}, expected=${read.revision}, current=${currentRevision}`
        };
      }
    }

    // 5. Re-execute SQL statements
    const localActions = await this.reExecuteSQL(transaction, payload);

    // 6. Extract block operations from local execution
    const localOps = this.extractBlockOperations(localActions);

    // 7. Filter to only the ops this cluster is responsible for
    const relevantLocalOps = localOps.filter(op =>
      requestedOps.some(req => req.blockId === op.blockId)
    );

    // 8. Compare block operations
    const match = this.compareBlockOps(relevantLocalOps, requestedOps);

    return {
      valid: match,
      reason: match ? undefined : 'Block operations mismatch'
    };
  }

  private async reExecuteSQL(
    transaction: Transaction,
    payload: QuereusTransactionPayload
  ): Promise<Map<CollectionId, Action[]>> {
    // Execute in isolated transaction context
    return await this.db.transaction(async (tx) => {
      // Set context values for determinism
      for (const [key, value] of Object.entries(payload.contextValues)) {
        tx.setContextValue(key, value);
      }

      // Execute each statement
      for (const stmt of payload.statements) {
        await tx.execute(stmt.sql, stmt.params, {
          transactionId: transaction.transactionId,
          deterministic: true  // Disallow non-deterministic functions
        });
      }

      // Extract actions from the transaction
      return await this.captureActions(tx);
    });
  }
}
```

## Package Structure

### Dependency Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌─────────┐                    ┌─────────┐                 │
│  │ quereus │                    │ db-core │                 │
│  │ (core)  │                    │ (core)  │                 │
│  └────┬────┘                    └────┬────┘                 │
│       │                              │                      │
│       │         ┌────────────────────┴──────────┐           │
│       │         │                               │           │
│       │         ▼                               ▼           │
│       │  ┌──────────────┐              ┌───────────┐        │
│       └─▶│  quereus-    │              │  db-p2p   │        │
│          │  plugin-     │              │           │        │
│          │  optimystic  │              └─────┬─────┘        │
│          └──────┬───────┘                    │              │
│                 │                            │              │
│                 └────────────┬───────────────┘              │
│                              │                              │
│                              ▼                              │
│                      ┌───────────────┐                      │
│                      │  Application  │                      │
│                      │  (uses all)   │                      │
│                      └───────────────┘                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### db-core
**Responsibilities**:
- Transaction type definition
- TransactionCoordinator for multi-collection consensus
- Built-in action-based transaction plugin (for testing)
- Block operation extraction from collections
- Validation hook integration

**New Files**:
- `src/transaction/transaction.ts` - Transaction type, Action.transaction field
- `src/transaction/coordinator.ts` - TransactionCoordinator with GATHER phase
- `src/transaction/plugins/action-plugin.ts` - Built-in action plugin
- `src/transaction/validator.ts` - Validator interface

**Dependencies**: None (core package)

### quereus
**Responsibilities**:
- VirtualTableContext extension (sql, params)
- Deterministic execution mode
- "with context" clause support

**Modified Files**:
- `src/vtab/context.ts` - Add sql, params fields
- `src/execution/executor.ts` - Populate context, enforce determinism
- `src/parser/parser.ts` - Parse "with context" clause

**Dependencies**: None (core package)

### quereus-optimystic-module
**Responsibilities**:
- VirtualTableModule implementation using db-core Trees
- No p2p dependencies (pure module)

**Files**:
- `src/optimystic-module.ts` - VirtualTableModule implementation
- `src/types.ts` - Module types

**Dependencies**: quereus, db-core

### quereus-plugin-optimystic
**Responsibilities**:
- Quereus transaction plugin (QUEREUS_TRANSACTION_ENGINE)
- Transaction capture during SQL execution
- SQL validator implementation
- Schema version hashing
- Integration with TransactionCoordinator
- P2P integration

**New Files**:
- `src/transaction/quereus-engine.ts` - Quereus transaction plugin
- `src/transaction/validator.ts` - QuereusTransactionValidator
- `src/transaction/capture.ts` - Transaction capture logic
- `src/plugin.ts` - Integrates module + p2p

**Dependencies**: quereus, quereus-optimystic-module, db-core, db-p2p

### db-p2p
**Responsibilities**:
- NetworkTransactor implementation
- Support for multi-collection consensus (GATHER phase)
- Cluster nominee queries
- No SQL-specific knowledge

**Modified Files**:
- `src/network-transactor.ts` - Add GATHER phase support

**Dependencies**: db-core

## Implementation Phases

### Phase 0: Nomenclature Alignment (db-core)
**Goal**: Align all existing code with Operation/Action/Transaction hierarchy

**Context**: The codebase currently uses "TrxId" and related terminology inconsistently. We need to establish clear nomenclature before adding multi-collection transactions.

**Tasks**:
- [ ] Audit all uses of "Trx", "TrxId", "transaction" in db-core
- [ ] Rename to use "Action" terminology consistently
- [ ] Update type names: `TrxId` → `ActionId`
- [ ] Update function names: `getTrxId()` → `getActionId()`
- [ ] Update comments and documentation
- [ ] Ensure "transaction" is reserved for the new multi-collection concept
- [ ] Update tests to use new nomenclature
- [ ] Verify no breaking changes to public API (or document them)

**Deliverable**: Consistent nomenclature throughout db-core, ready for Transaction layer

### Phase 1: Transaction Infrastructure (db-core)
**Goal**: Establish transaction type and coordinator in db-core

**Tasks**:
- [ ] Define Transaction type in db-core
- [ ] Define Action.transaction field
- [ ] Implement built-in action-based transaction plugin
- [ ] Add block operation extraction from Collections
- [ ] Create validator interface
- [ ] Basic tests for transaction structure

**Deliverable**: db-core has transaction infrastructure (no multi-collection yet)

### Phase 2: Multi-Collection Coordinator (db-core)
**Goal**: Implement multi-collection transaction coordination

**Tasks**:
- [ ] Implement TransactionCoordinator class
- [ ] Add cluster grouping logic for block operations
- [ ] Implement critical cluster identification
- [ ] Implement GATHER phase (nominee collection)
- [ ] Extend PEND/COMMIT/PROPAGATE/CHECKPOINT for multi-collection
- [ ] Tests for multi-collection coordination with action plugin

**Deliverable**: Can coordinate transactions across multiple collections

### Phase 3: Network Support (db-p2p)
**Goal**: Add network support for multi-collection consensus

**Tasks**:
- [ ] Extend NetworkTransactor for GATHER phase
- [ ] Implement cluster nominee queries
- [ ] Add nominee reasonableness checks
- [ ] Tests for network-level multi-collection transactions

**Deliverable**: Multi-collection transactions work over network

### Phase 4: Quereus Determinism (quereus)
**Goal**: Enable deterministic SQL execution

**Tasks**:
- [ ] Add `sql`, `params` to VirtualTableContext
- [ ] Populate context during execution
- [ ] Implement "with context" clause parsing
- [ ] Add deterministic execution mode
- [ ] Reject non-deterministic functions outside context
- [ ] Tests for deterministic execution

**Deliverable**: Quereus supports deterministic execution

### Phase 5: SQL Transaction Capture (quereus-plugin-optimystic)
**Goal**: Capture SQL transactions

**Tasks**:
- [ ] Define QuereusTransactionPayload type
- [ ] Implement transaction capture in OptimysticModule
- [ ] Add xBegin/xCommit hooks
- [ ] Capture SQL statements, reads, context values
- [ ] Implement schema version hashing
- [ ] Create Transaction from captured data
- [ ] Tests for transaction capture

**Deliverable**: Can capture SQL transactions

### Phase 6: SQL Validation (quereus-plugin-optimystic)
**Goal**: Validate transactions by re-executing SQL

**Tasks**:
- [ ] Implement QuereusTransactionValidator
- [ ] Add schema version validation
- [ ] Add read dependency validation
- [ ] Implement SQL re-execution
- [ ] Implement action comparison
- [ ] Integrate with db-core validator interface
- [ ] Tests for validation logic

**Deliverable**: Cluster participants can validate SQL transactions

### Phase 7: Integration & Testing
**Goal**: End-to-end integration and testing

**Tasks**:
- [ ] Integrate TransactionCoordinator with OptimysticModule
- [ ] Add validation to cluster consensus handlers
- [ ] End-to-end tests with multiple peers
- [ ] Test constraint validation across network
- [ ] Test schema mismatch handling
- [ ] Test stale read detection
- [ ] Test multi-collection atomicity
- [ ] Performance testing and optimization

**Deliverable**: Fully functional SQL-validated distributed transactions

## Design Decisions

### 1. Nomenclature: Operation → Action → Transaction
- **Operation**: Block-level mutation (lowest level)
- **Action**: Collection-level mutation (middle level)
- **Transaction**: Multi-collection mutation (highest level)

This hierarchy clarifies the abstraction layers and makes the code more maintainable.

### 2. No Global Transaction Log
Transactions are recorded in each affected collection's log, not a separate global log. This maintains scalability - no single bottleneck for all transactions.

### 3. Critical Cluster Consensus via GATHER Phase
Instead of a persistent "supercluster", we use a temporary coordination:
- GATHER phase collects nominees from all critical clusters
- Merged nominee list used for consensus
- Nodes spot-check nominees from other neighborhoods
- No persistent supercluster structure needed

### 4. Pluggable Transaction Engines
The transaction payload is engine-specific, allowing:
- SQL validation (Quereus)
- Other rule systems (future)
- Built-in action-based plugin (testing)

This keeps db-core generic while enabling powerful validation.

### 5. Actions Carry Transaction Context
Actions include transaction CID (and optionally full transaction) so validators have all needed information without separate lookups.

### 6. Read Tracking at Block Level
For Phase 1, track reads at block granularity:
- Simpler implementation
- Sufficient for optimistic concurrency control
- Can refine to row-level later if needed

### 7. Determinism via "with context"
Non-deterministic functions (NOW(), RANDOM()) are captured through "with context" clauses:
- Quereus rejects non-deterministic functions outside context
- Context values captured and included in transaction
- All peers use same context values during re-execution
- Example: `SELECT * FROM users WITH CONTEXT (now: NOW()) WHERE created < now`

### 8. Schema Version Hashing
All participants must have matching schema versions:
- Schema changes prohibited during normal operation
- Schema changes require cluster-wide coordination (future work)
- Focus on validation for now

### 9. TransactionId() Integration
Use TransactionId() function for transaction identification:
- Returns current transaction's ID
- Useful for audit trails and debugging
- Included in transaction for deterministic re-execution

### 10. Performance Trade-offs
Accept cost of re-executing SQL on cluster participants:
- Still better than blockchain (not everyone replicates everything)
- Only cluster participants for affected blocks re-execute
- Can optimize later with Merkle trees, sampling, caching

## Success Criteria

1. **Multi-Collection Atomicity**: Transactions affecting multiple collections (table + indexes) commit atomically or not at all
2. **Constraint Validation**: PRIMARY KEY, UNIQUE, CHECK, NOT NULL constraints validated across the network
3. **Collation Correctness**: String comparisons respect declared collations
4. **Schema Consistency**: All peers reject transactions with schema mismatches
5. **Deterministic Execution**: Same SQL produces same actions on all peers
6. **Conflict Detection**: Stale reads detected and rejected
7. **Critical Cluster Consensus**: All log tail clusters participate in consensus
8. **Pluggable Engines**: Built-in action plugin and Quereus plugin both work

## Key Architectural Insights

### 1. Scalability Through Decentralization
No global transaction log - each collection maintains its own log. Transactions are recorded in all affected collection logs, maintaining scalability.

### 2. Temporary Supercluster Coordination
Critical clusters form temporary consensus groups via GATHER phase, not persistent superclusters. This avoids creating new bottlenecks.

### 3. Separation of Mechanism and Policy
- **db-core**: Provides mechanism (multi-collection transactions, validation hooks)
- **quereus-plugin-optimystic**: Provides policy (SQL validation)
- **db-p2p**: Provides transport (no SQL knowledge)

This separation enables:
- Testing multi-collection transactions without SQL
- Alternative validation strategies
- Reuse of components

### 4. Action as Unit of Replication
Actions remain the unit of replication and replay. Transactions are a coordination layer above actions, not a replacement.

### 5. Validation Through Re-execution
Rather than trying to validate block operations directly, validators re-execute the transaction payload and compare resulting actions. This ensures semantic correctness, not just structural correctness.

## Putting It All Together: Example Flow

### Scenario
Client executes: `INSERT INTO users (id, name) VALUES (1, 'Alice')`

This affects:
- Main table collection (users)
- Index collection (users_by_name)

### Step-by-Step Flow

**1. Client Execution (quereus-plugin-optimystic)**
```typescript
// User calls:
await db.execute("INSERT INTO users (id, name) VALUES (1, 'Alice')");

// OptimysticModule.xBegin() called
// - Creates TransactionCapture

// OptimysticModule.xUpdate() called
// - Captures SQL: "INSERT INTO users..."
// - Executes: Updates main table collection
// - Executes: Updates index collection
// - Tracks affected collections: [users, users_by_name]

// OptimysticModule.xCommit() called
// - Creates QuereusTransactionPayload
// - Creates Transaction with CID
// - Calls TransactionCoordinator.executeTransaction()
```

**2. GATHER Phase (db-core TransactionCoordinator)**
```typescript
// Identify critical blocks:
// - users collection → log tail block 0xABCD
// - users_by_name collection → log tail block 0x1234

// Query clusters:
// - 0xABCD cluster → nominees: {peer1, peer2, peer3}
// - 0x1234 cluster → nominees: {peer4, peer5, peer6}

// Supercluster: {peer1, peer2, peer3, peer4, peer5, peer6}
```

**3. PEND Phase (db-p2p NetworkTransactor)**
```typescript
// Send to all block clusters:
// - Transaction (engine, payload, reads, CID, actions)
// - Block operations for their blocks
// - Supercluster nominee list

// Each cluster participant validates:
// - Parse QuereusTransactionPayload
// - Check schema version matches
// - Check read dependencies
// - Re-execute: INSERT INTO users (id, name) VALUES (1, 'Alice')
// - Compare resulting actions with proposed
// - Vote: accept/reject
```

**4. COMMIT Phase (db-p2p NetworkTransactor)**
```typescript
// Send commit to critical clusters:
// - 0xABCD cluster (users log tail)
// - 0x1234 cluster (users_by_name log tail)

// Each critical cluster:
// - Achieves consensus among supercluster
// - All must succeed for transaction to commit
// - If any fails, entire transaction aborts
```

**5. PROPAGATE Phase**
```typescript
// Notify all block clusters of success
// Clusters finalize their local changes
```

**6. CHECKPOINT Phase**
```typescript
// Append to collection logs:
// - users log: records actions for users collection
// - users_by_name log: records actions for index collection

// Each log entry includes:
// - Transaction CID
// - Actions for that collection
// - Transaction metadata (for future validators)
```

### What This Achieves

✅ **Atomicity**: Both collections commit or neither
✅ **Validation**: All cluster participants verified the INSERT is valid
✅ **Constraint Checking**: PRIMARY KEY uniqueness validated
✅ **Index Consistency**: Index updated atomically with main table
✅ **Determinism**: All validators got same result from re-execution
✅ **Scalability**: No global transaction log, no single bottleneck

