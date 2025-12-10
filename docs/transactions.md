# Multi-Collection Transactions with Pluggable Validation

## Overview

This document describes the architecture for multi-collection transactions in Optimystic, with support for pluggable validation engines. The primary use case is SQL-validated transactions where cluster participants independently validate by re-executing SQL statements.

## Terminology

To support multi-collection transactions, we introduce a clear hierarchy:

- **Operation**: A mutation to a single block (lowest level)
- **Action**: A logical mutation to a single collection, resulting in one or more operations
- **Transaction**: A logical mutation spanning multiple collections, resulting in one or more actions per collection

### Transaction Identity

Transactions have two distinct identifiers:

- **Transaction Stamp** (`stampId`): Created at transaction BEGIN, remains stable throughout the transaction lifecycle. Contains peer ID, timestamp, schema hash, and engine ID. Exposed to users via `StampId()` UDF.
- **Transaction CID** (`cid`): Computed at COMMIT as a hash of the stamp + statements + reads. This is the final, immutable transaction identity used in logs and block references.

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
6. **Pluggable execution engines**: The transaction 'statements' payload is engine-specific (SQL for Quereus, actions for testing, etc.)
7. **Critical cluster consensus**: All log tail clusters (critical blocks) must participate in consensus
8. **Deterministic replay**: Validators re-execute the transaction statements and verify the resulting block operations match
9. **Actions with return values**: Actions can return results (for reads, queries, etc.)
10. **Collection-specific operations**: Collections define their own action types (Tree has scan, Diary has append, etc.)

### Transaction Structure

```typescript
// Stamp ID: Hash of the stamp (exposed to users via StampId() UDF)
type StampId = string;

// Transaction Stamp: Created at BEGIN, stable throughout transaction
type TransactionStamp = {
  peerId: PeerId;           // Who initiated the transaction
  timestamp: number;        // When transaction started (milliseconds)
  schemaHash: string;       // Hash of schema version(s) for validation
  engineId: string;         // Which engine (e.g., 'quereus@0.5.3')
  id: StampId;              // Identity of stamp (Hash of peerId + timestamp + schemaHash + engineId)- stable throughout transaction
};

// Transaction: Finalized at COMMIT
type Transaction = {
  // Reference to the stamp
  stampId: StampId;

  // Engine-specific statements (for replay/validation)
  statements: string;  // For Quereus: SQL statements; for ActionsEngine: JSON-encoded actions

  // Read dependencies for optimistic concurrency control
  reads: ReadDependency[];

  // Transaction identifier 
  id: string;  // used in logs (hash of stampId + statements + reads)
};

type ReadDependency = {
  blockId: BlockId;
  revision: number;  // Expected revision
};

// Actions reference the transaction they came from
type Action<T> = {
  type: ActionType;
  data: T;
  transaction: Transaction;
};

// Action handlers can return values (for reads, queries, etc.)
type ActionHandler<T, TResult = void> = (
  action: Action<T>,
  store: BlockStore<IBlock>
) => Promise<TResult>;
```

### Transaction Execution Flow

The transaction system separates **statement execution** (handled by engines) from **transaction coordination** (handled by the coordinator).

#### Architecture Layers

1. **Transaction Engine** (e.g., QuereusEngine, ActionsEngine)
   - Takes coordinator as constructor argument
   - Receives statements from user code
   - Translates statements into actions
   - Calls `coordinator.applyActions(actions, stampId)` to execute immediately

2. **Transaction Coordinator**
   - Applies actions to collections (creates collections if needed)
   - Actions are immediately executed, updating local snapshots (snapshot isolation)
   - Orchestrates GATHER/PEND/COMMIT/CANCEL phases across collections
   - Does NOT re-execute actions during commit (already applied)

3. **Transaction Session**
   - Stateful session manager for incremental transaction building
   - Accumulates statements as they arrive
   - On commit: compiles statements → Transaction, calls coordinator.commit()

#### Flow Example (Quereus SQL)

```
┌─────────────────────────────────────────────────────────────┐
│                    Quereus Module                           │
│  1. Receive SQL statement from Quereus engine               │
│  2. Determine affected collections from mutation request    │
│  3. Log statement to session (create session if needed)     │
│  4. Translate statement → actions                           │
│  5. Call coordinator.applyActions(actions, stampId)         │
│     • Coordinator creates collections if needed             │
│     • Actions executed immediately (snapshot isolation)     │
│     • Actions recorded in trackers (pending state)          │
│  6. More statements...                                      │
│  7. Call session.commit()                                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Transaction Coordinator (db-core)              │
│                                                             │
│  Coordinator receives commit request with:                  │
│    • Transaction (stampId + statements + reads)             │
│    • Actions already applied to collections (in trackers)   │
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
│    • Collect all operations from collection trackers        │
│    • Compute hash of ALL operations (across all blocks)     │
│    • Send to all affected block clusters:                   │
│      - Full Transaction (for replay/validation)             │
│      - Operations hash (single hash for entire transaction) │
│      - Which blocks this peer should coordinate + revisions │
│      - Supercluster nominee list (if multi-collection)      │
│    • Each cluster validates (see below)                     │
│                                                             │
│  Phase 3: COMMIT                                            │
│    • Send commit to all critical clusters (log tails)       │
│    • Each critical cluster achieves consensus               │
│    • All must succeed for transaction to proceed            │
│    • Transaction logged by CID (not actions)                │
│                                                             │
│  Phase 4: PROPAGATE (managed by clusters)                   │
│    • Clusters finalize their local changes                  │
│    • Client doesn't manage this phase                       │
│                                                             │
│  Phase 5: CHECKPOINT (managed by clusters)                  │
│    • Clusters append to their collection's log              │
│    • Log entry references Transaction CID                   │
│    • Full Transaction stored (statements + reads)           │
│    • Client doesn't manage this phase                       │
│                                                             │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Cluster Participants (Validators)              │
│                                                             │
│  During PEND Phase:                                         │
│    1. Receive Transaction + operations hash + block list    │
│    2. Verify stamp.engineId matches local engine            │
│    3. Verify stamp.schemaHash matches local schema          │
│    4. Verify read dependencies (no stale reads)             │
│    5. Re-execute transaction.statements through engine      │
│       • Engine translates statements → actions              │
│       • Actions applied to local collections (temp state)   │
│       • Operations collected from trackers                  │
│    6. Compute hash of ALL operations (entire transaction)   │
│    7. Compare with sender's operations hash                 │
│    8. If match → PEND the blocks this peer coordinates      │
│    9. If mismatch → Reject (Byzantine fault or bug)         │
│                                                             │
│  During COMMIT Phase (critical clusters only):              │
│    1. Achieve consensus with other critical clusters        │
│    2. Commit to log if consensus reached                    │
│    3. Log entry contains Transaction (by CID)               │
│                                                             │
│  During PROPAGATE Phase (cluster-managed):                  │
│    1. Finalize local block changes                          │
│    2. Make changes visible                                  │
│                                                             │
│  During CHECKPOINT Phase (cluster-managed):                 │
│    1. Append Transaction to collection log                  │
│    2. Transaction referenced by CID                         │
│    3. Full Transaction stored for future replay             │
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

### 1. Transaction Types (db-core)

The core transaction structures in db-core:

```typescript
// In db-core/src/transaction/transaction.ts

// Transaction Stamp: Created at BEGIN, stable throughout transaction
export type TransactionStamp = {
  peerId: PeerId;           // Who initiated the transaction
  timestamp: number;        // When transaction started (milliseconds)
  schemaHash: string;       // Hash of schema version(s) for validation
  engineId: string;         // Which engine (e.g., 'quereus@0.5.3')
};

// Stamp ID: Hash of the stamp
export type StampId = string;

// Helper to create stamp ID
export function createStampId(stamp: TransactionStamp): StampId {
  return hash(JSON.stringify(stamp));
}

// Transaction: Finalized at COMMIT
export type Transaction = {
  // Reference to the stamp (stable ID)
  stampId: StampId;

  // Engine-specific statements (for replay/validation)
  statements: string;

  // Read dependencies for optimistic concurrency control
  reads: ReadDependency[];

  // Content identifier (hash of stampId + statements + reads)
  // This is the final transaction identity used in logs
  cid: string;
};

export type ReadDependency = {
  blockId: BlockId;
  revision: number;
};

// Actions carry their transaction stamp ID
export type Action<T> = {
  type: ActionType;
  data: T;
  transaction?: StampId; // Transaction stamp ID (stable throughout execution)
};
```

### 2. Built-in Actions Engine (db-core)

For testing and simple use cases, db-core provides a built-in actions engine:

```typescript
// In db-core/src/transaction/actions-engine.ts
export const ACTIONS_ENGINE_ID = "actions@1.0.0";

export type ActionsStatement = {
  // Direct specification of actions for a single collection
  collectionId: CollectionId;
  actions: Action<unknown>[];
};

// The ActionsEngine takes a coordinator and applies actions directly
export class ActionsEngine implements ITransactionEngine {
  constructor(private coordinator: TransactionCoordinator) {}

  async executeStatement(statement: string, stampId: StampId): Promise<void> {
    const actionsStatement: ActionsStatement = JSON.parse(statement);

    // Apply actions through coordinator
    await this.coordinator.applyActions(
      [actionsStatement],
      stampId
    );
  }

  async execute(transaction: Transaction): Promise<void> {
    // For validation/replay: parse all statements and apply
    const statements: ActionsStatement[] = JSON.parse(transaction.statements);

    for (const statement of statements) {
      await this.coordinator.applyActions([statement], transaction.stampId);
    }
  }
}
```

This allows testing multi-collection transactions without Quereus.

### 3. Quereus Transaction Engine (quereus-plugin-optimystic)

The Quereus-specific transaction engine:

```typescript
// In quereus-plugin-optimystic/src/transaction/quereus-engine.ts
export const QUEREUS_ENGINE_ID = "quereus@0.5.3";

export type QuereusStatements = {
  // SQL statements in execution order
  statements: Array<{
    sql: string;
    params: SqlValue[];
  }>;
};

// The QuereusEngine wraps a Quereus database instance
export class QuereusEngine implements ITransactionEngine {
  constructor(private db: QuereusDatabase) {}

  async executeStatement(statement: string, stampId: StampId): Promise<void> {
    const { sql, params } = JSON.parse(statement);

    // Execute SQL through Quereus
    // Quereus module will translate to actions and call coordinator.applyActions()
    await this.db.exec(sql, params, { stampId });
  }

  async execute(transaction: Transaction): Promise<void> {
    // For validation/replay: execute all SQL statements
    const statements: QuereusStatements = JSON.parse(transaction.statements);

    for (const stmt of statements.statements) {
      await this.db.exec(stmt.sql, stmt.params, { stampId: transaction.stampId });
    }
  }

  async getSchemaHash(): Promise<string> {
    // Serialize schema from catalog
    const schema = await this.db.catalog.serialize();
    return hash(schema);
  }
}

// Optimystic Module (virtual table module for Quereus)
class OptimysticModule implements VirtualTableModule {
  private session?: TransactionSession;

  constructor(
    private coordinator: TransactionCoordinator,
    private collectionId: CollectionId
  ) {}

  async xUpdate(context: VirtualTableContext, ...): Promise<void> {
    // Get or create session from context
    const stampId = context.stampId || this.createStampId();
    if (!this.session || this.session.stampId !== stampId) {
      this.session = new TransactionSession(
        this.coordinator,
        stampId,
        QUEREUS_ENGINE_ID
      );
    }

    // Log the SQL statement to the session
    const statement = JSON.stringify({
      sql: context.sql,
      params: context.params || []
    });
    await this.session.execute(statement);

    // Determine affected collections from mutation request
    const affectedCollections = [
      this.collectionId,
      ...this.indexManager.getIndexCollectionIds()
    ];

    // Translate statement to actions
    const actions = this.translateToActions(context);

    // Apply actions through coordinator
    await this.coordinator.applyActions(
      affectedCollections.map(collectionId => ({
        collectionId,
        actions: actions.filter(a => a.collectionId === collectionId)
      })),
      stampId
    );
  }

  async xCommit(context: VirtualTableContext): Promise<void> {
    if (!this.session) return;

    // Commit the session (compiles statements → Transaction, orchestrates PEND/COMMIT)
    await this.session.commit();
    this.session = undefined;
  }

  async xRollback(context: VirtualTableContext): Promise<void> {
    if (!this.session) return;

    await this.session.rollback();
    this.session = undefined;
  }

  private createStampId(): StampId {
    const stamp: TransactionStamp = {
      peerId: this.coordinator.peerId,
      timestamp: Date.now(),
      schemaHash: await this.getSchemaHash(),
      engineId: QUEREUS_ENGINE_ID
    };
    return createStampId(stamp);
  }

  private async getSchemaHash(): Promise<string> {
    // Get schema hash from engine or cache
    // Avoid recomputing if schema hasn't changed
    return this.schemaHashCache || await this.computeSchemaHash();
  }

```

### 4. Transaction Session (db-core)

Manages incremental transaction building:

```typescript
// In db-core/src/transaction/session.ts
export class TransactionSession {
  private readonly statements: string[] = [];
  private committed = false;
  private rolledBack = false;

  constructor(
    private readonly coordinator: TransactionCoordinator,
    public readonly stampId: StampId,
    public readonly engineId: string
  ) {}

  async execute(statement: string): Promise<void> {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction already finalized');
    }

    // Accumulate the statement for later compilation
    this.statements.push(statement);

    // Execute through engine (engine will call coordinator.applyActions)
    const engine = this.coordinator.getEngine(this.engineId);
    await engine.executeStatement(statement, this.stampId);
  }

  async commit(): Promise<void> {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction already finalized');
    }

    // Compile statements into complete transaction
    const transaction: Transaction = {
      stampId: this.stampId,
      statements: this.compileStatements(),
      reads: [], // TODO: Track reads during execution
      cid: createTransactionCid(
        this.stampId,
        this.compileStatements(),
        []
      )
    };

    // Execute through coordinator (orchestrates PEND/COMMIT)
    await this.coordinator.commit(transaction);

    this.committed = true;
  }

  async rollback(): Promise<void> {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction already finalized');
    }

    // Rollback through coordinator
    await this.coordinator.rollback(this.stampId);

    this.rolledBack = true;
  }

  private compileStatements(): string {
    // Engine-specific compilation
    // For ActionsEngine: JSON array of statements
    // For QuereusEngine: JSON object with statements array
    return JSON.stringify(this.statements);
  }
}
```

### 5. Transaction Coordinator (db-core)

Coordinates multi-collection transactions with critical cluster consensus:

```typescript
// In db-core/src/transaction/coordinator.ts
export class TransactionCoordinator {
  constructor(
    private transactor: ITransactor,
    private collections: Map<CollectionId, Collection>,
    private engines: Map<string, ITransactionEngine>
  ) {}

  // Apply actions to collections (called by engines during statement execution)
  async applyActions(
    actions: CollectionActions[],
    stampId: StampId
  ): Promise<void> {
    for (const { collectionId, actions: collectionActions } of actions) {
      // Get or create collection
      let collection = this.collections.get(collectionId);
      if (!collection) {
        collection = await this.createCollection(collectionId);
        this.collections.set(collectionId, collection);
      }

      // Apply each action (tagged with stampId)
      for (const action of collectionActions) {
        const taggedAction = { ...action, transaction: stampId };
        await collection.act(taggedAction);
      }
    }
  }

  // Commit a transaction (actions already applied, orchestrate PEND/COMMIT)
  async commit(transaction: Transaction): Promise<void> {
    // Collect operations from collection trackers
    const operations = await this.collectOperations(transaction.stampId);

    // Compute hash of ALL operations (entire transaction)
    const operationsHash = this.hashOperations(operations);

    // Group operations by block
    const blockOperations = this.groupByBlock(operations);

    // Identify critical clusters (log tail clusters for affected collections)
    const criticalClusters = await this.getCriticalClusters(
      Array.from(this.getAffectedCollections(transaction.stampId))
    );

    // Execute consensus phases
    await this.executeConsensus(
      transaction,
      operationsHash,
      blockOperations,
      criticalClusters
    );
  }

  // Rollback a transaction (undo applied actions)
  async rollback(stampId: StampId): Promise<void> {
    // Clear trackers for this transaction
    for (const collection of this.collections.values()) {
      await collection.clearPending(stampId);
    }
  }

  private async executeConsensus(
    transaction: Transaction,
    operationsHash: string,
    blockOperations: Map<BlockId, { rev: number; operations: Operation[] }>,
    criticalClusters: Set<ClusterId>
  ): Promise<void> {
    // Phase 1: GATHER - Collect critical cluster nominees (skip if single collection)
    const superclusterNominees = await this.gatherPhase(criticalClusters);

    // Phase 2: PEND - Distribute to all block clusters for validation
    await this.pendPhase(transaction, operationsHash, blockOperations, superclusterNominees);

    // Phase 3: COMMIT - Consensus across critical clusters
    await this.commitPhase(transaction, criticalClusters);

    // Phases 4-5 (PROPAGATE, CHECKPOINT) are cluster-managed
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
        if (this.isReasonableNominee(nominee)) {
          supercluster.add(nominee);
        }
      }
    }

    return supercluster;
  }

  private async pendPhase(
    transaction: Transaction,
    operationsHash: string,
    blockOperations: Map<BlockId, { rev: number; operations: Operation[] }>,
    superclusterNominees: Set<PeerId> | null
  ): Promise<void> {
    // Send PEND request to each affected block cluster
    const pendRequests = Array.from(blockOperations.entries()).map(
      ([blockId, { rev }]) => ({
        transaction,
        operationsHash,
        blocks: [{ blockId, rev }],
        policy: { superclusterNominees }
      })
    );

    await Promise.all(
      pendRequests.map(req => this.transactor.pend(req))
    );
  }
}
```

### 6. ITransactor Interface Updates (db-core)

The `ITransactor` interface needs updates to support transaction validation:

```typescript
// In db-core/src/transactor.ts

export type PendRequest = {
  transaction: Transaction;        // Full transaction for replay/validation
  operationsHash: string;          // Hash of ALL operations (entire transaction)
  blocks: Array<{                  // Which blocks this peer should coordinate
    blockId: BlockId;
    rev: number;                   // Expected revision
  }>;
  policy: {
    superclusterNominees?: Set<PeerId>; // For multi-collection consensus
  };
};

export interface ITransactor {
  // ... existing methods ...

  // PEND: Validate and prepare transaction
  pend(request: PendRequest): Promise<{ success: boolean; error?: string }>;

  // Query cluster nominees for GATHER phase
  queryClusterNominees(clusterId: ClusterId): Promise<Set<PeerId>>;
}
```

### 7. Transaction Validator (cluster participants)

Cluster participants validate transactions by re-executing:

```typescript
// In db-p2p or similar (cluster participant logic)
export class TransactionValidator {
  constructor(
    private coordinator: TransactionCoordinator,
    private engines: Map<string, ITransactionEngine>
  ) {}

  async validate(request: PendRequest): Promise<ValidationResult> {
    const { transaction, operationsHash, blocks } = request;

    // 1. Get the stamp to verify engine and schema
    const stamp = await this.getStamp(transaction.stampId);
    if (!stamp) {
      return { valid: false, reason: 'Unknown transaction stamp' };
    }

    // 2. Verify engine matches
    const engine = this.engines.get(stamp.engineId);
    if (!engine) {
      return {
        valid: false,
        reason: `Unknown engine: ${stamp.engineId}`
      };
    }

    // 3. Verify schema hash (engine-specific)
    const localSchemaHash = await engine.getSchemaHash();
    if (localSchemaHash !== stamp.schemaHash) {
      return {
        valid: false,
        reason: `Schema mismatch: local=${localSchemaHash}, stamp=${stamp.schemaHash}`
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

    // 5. Re-execute transaction statements through engine
    // This creates a temporary coordinator state for validation
    const tempCoordinator = this.createTempCoordinator();
    const engine = this.engines.get(stamp.engineId)!;

    await engine.execute(transaction);

    // 6. Collect ALL operations from temp coordinator's trackers
    const localOperations = await tempCoordinator.collectOperations(transaction.stampId);

    // 7. Compute hash of ALL operations (entire transaction)
    const localOperationsHash = this.hashOperations(localOperations);

    // 8. Compare with sender's operations hash
    if (localOperationsHash !== operationsHash) {
      return {
        valid: false,
        reason: `Operations hash mismatch: local=${localOperationsHash}, sender=${operationsHash}`
      };
    }

    // 9. Validation succeeded - PEND the blocks this peer coordinates
    for (const { blockId, rev } of blocks) {
      await this.transactor.pend({
        transaction,
        operationsHash,
        blocks: [{ blockId, rev }],
        policy: request.policy
      });
    }

    return { valid: true };
  }

  private createTempCoordinator(): TransactionCoordinator {
    // Create a temporary coordinator for validation
    // Uses same collections but isolated tracker state
    return new TransactionCoordinator(
      this.transactor,
      new Map(this.coordinator.collections),
      this.engines
    );
  }

  private hashOperations(operations: Operation[]): string {
    // Deterministic hash of all operations
    const serialized = JSON.stringify(
      operations.map(op => ({
        blockId: op.blockId,
        type: op.type,
        data: op.data
      }))
    );
    return hash(serialized);
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
- Transaction types (TransactionStamp, Transaction)
- TransactionCoordinator for applying actions and orchestrating consensus
- TransactionSession for incremental transaction building
- Built-in ActionsEngine (for testing)
- ITransactionEngine interface
- Block operation extraction from collections

**Key Files**:
- `src/transaction/transaction.ts` - Transaction types (TransactionStamp, Transaction, StampId)
- `src/transaction/coordinator.ts` - TransactionCoordinator (applyActions, commit, rollback)
- `src/transaction/session.ts` - TransactionSession (execute, commit, rollback)
- `src/transaction/actions-engine.ts` - Built-in ActionsEngine
- `src/transactor.ts` - Updated PendRequest with transaction validation

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
- QuereusEngine (implements ITransactionEngine)
- OptimysticModule (VirtualTableModule with transaction support)
- Schema hashing (for validation)
- Integration with TransactionCoordinator
- P2P integration

**Key Files**:
- `src/transaction/quereus-engine.ts` - QuereusEngine (executeStatement, execute, getSchemaHash)
- `src/optimystic-module.ts` - OptimysticModule with TransactionSession integration
- `src/plugin.ts` - Integrates module + coordinator + p2p

**Dependencies**: quereus, db-core, db-p2p

### db-p2p
**Responsibilities**:
- NetworkTransactor implementation
- Support for multi-collection consensus (GATHER phase)
- Cluster nominee queries
- Transaction validation (re-execution through engines)
- No SQL-specific knowledge (engine-agnostic)

**Modified Files**:
- `src/network-transactor.ts` - Updated PendRequest handling, GATHER phase support
- `src/transaction-validator.ts` - Generic transaction validator (uses ITransactionEngine)

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
**Goal**: Establish transaction types and basic infrastructure

**Tasks**:
- [x] Define TransactionStamp type (peerId, timestamp, schemaHash, engineId)
- [x] Define Transaction type (stampId, statements, reads, cid)
- [x] Define StampId type and createStampId() helper
- [x] Update Action type to include transaction: StampId field
- [x] Implement ActionsEngine (executeStatement, execute)
- [x] Implement TransactionSession (execute, commit, rollback)
- [x] Basic tests for transaction structure

**Deliverable**: db-core has transaction infrastructure with stamp/CID separation

### Phase 2: Multi-Collection Coordinator (db-core)
**Goal**: Implement multi-collection transaction coordination

**Tasks**:
- [x] Implement TransactionCoordinator.applyActions() (called by engines)
- [x] Implement TransactionCoordinator.commit() (orchestrates PEND/COMMIT)
- [x] Implement TransactionCoordinator.rollback() (clears trackers)
- [ ] Implement operation collection from trackers
- [ ] Implement operation hashing (single hash for entire transaction)
- [ ] Implement critical cluster identification
- [ ] Implement GATHER phase (nominee collection, skip if single collection)
- [ ] Implement PEND phase (send transaction + operations hash + block list)
- [ ] Implement COMMIT phase (consensus across critical clusters)
- [ ] Update PendRequest type (transaction, operationsHash, blocks, policy)
- [ ] Tests for multi-collection coordination with ActionsEngine

**Deliverable**: Can coordinate transactions across multiple collections

### Phase 3: Network Support (db-p2p)
**Goal**: Add network support for multi-collection consensus and validation

**Tasks**:
- [ ] Update PendRequest type in ITransactor interface
- [ ] Implement TransactionValidator (generic, engine-agnostic)
  - [ ] Verify stamp.engineId matches local engine
  - [ ] Verify stamp.schemaHash matches local schema
  - [ ] Verify read dependencies
  - [ ] Re-execute transaction through engine
  - [ ] Compute operations hash from temp coordinator
  - [ ] Compare with sender's operations hash
- [ ] Extend NetworkTransactor for GATHER phase
- [ ] Implement cluster nominee queries
- [ ] Add nominee reasonableness checks
- [ ] Tests for network-level multi-collection transactions

**Deliverable**: Multi-collection transactions work over network with validation

### Phase 4: Quereus Engine (quereus-plugin-optimystic)
**Goal**: Implement QuereusEngine for SQL transaction execution

**Tasks**:
- [ ] Define QuereusStatements type (array of {sql, params})
- [ ] Implement QuereusEngine class
  - [ ] Constructor takes QuereusDatabase
  - [ ] executeStatement() - execute single SQL statement
  - [ ] execute() - execute all statements (for validation)
  - [ ] getSchemaHash() - serialize catalog and hash
- [ ] Implement schema hash caching (avoid recomputing if unchanged)
- [ ] Tests for QuereusEngine

**Deliverable**: QuereusEngine can execute and validate SQL transactions

### Phase 5: Optimystic Module Integration (quereus-plugin-optimystic)
**Goal**: Integrate TransactionSession into OptimysticModule

**Tasks**:
- [ ] Update OptimysticModule to use TransactionSession
- [ ] Create/get session from context.stampId
- [ ] Log SQL statements to session in xUpdate
- [ ] Translate SQL to actions
- [ ] Call coordinator.applyActions() with stampId
- [ ] Implement xCommit (session.commit())
- [ ] Implement xRollback (session.rollback())
- [ ] Implement createStampId() helper
  - [ ] Get peerId from coordinator
  - [ ] Get timestamp from Date.now()
  - [ ] Get schemaHash from engine (cached)
  - [ ] Set engineId to QUEREUS_ENGINE_ID
- [ ] Tests for module integration

**Deliverable**: SQL statements flow through TransactionSession → QuereusEngine → Coordinator

### Phase 6: StampId() UDF (quereus-plugin-optimystic)
**Goal**: Expose StampId() UDF for SQL users

**Tasks**:
- [ ] Implement StampId() UDF in Quereus
- [ ] Pass stampId through VirtualTableContext
- [ ] Document usage (for deduplication, auditing)
- [ ] Tests for StampId() UDF

**Deliverable**: Users can access transaction stamp ID in SQL

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
The transaction statements are engine-specific, allowing:
- SQL validation (QuereusEngine)
- Other rule systems (future)
- Built-in ActionsEngine (testing)

This keeps db-core generic while enabling powerful validation.

### 5. Engine Takes Coordinator, Not Vice Versa
Engines take the coordinator as a constructor argument:
- Coordinator is the "database" - the core abstraction
- Engines are statement translators/executors
- Engines call `coordinator.applyActions()` to execute
- Clean separation: coordinator doesn't know about engines during construction

### 6. Actions Carry Transaction Stamp ID
Actions include `transaction: StampId` field:
- StampId is stable throughout transaction lifecycle
- Used to track which actions belong to which transaction
- Validators can look up full Transaction by stampId if needed

### 7. Transaction Stamp vs Transaction CID
Two distinct identifiers serve different purposes:
- **StampId**: Created at BEGIN, stable throughout, exposed to users via `StampId()` UDF
- **CID**: Computed at COMMIT, final immutable identity, used in logs
- Stamp contains: peerId, timestamp, schemaHash, engineId
- CID is hash of: stampId + statements + reads

### 8. Blocks Don't Receive Operations, They Validate Transactions
Key insight: Blocks don't need the full operation details during PEND:
- Send full Transaction (statements) for replay
- Send operations hash (single hash for entire transaction)
- Send which blocks this peer should coordinate
- Receiving node replays transaction, computes own operations hash
- If hashes match → validation succeeds
- Broader validation: every participant validates entire transaction

### 9. Schema Hash in Transaction Stamp
Schema hash is part of the stamp (not transaction):
- Computed at transaction BEGIN
- All participants must match for validation to succeed
- Engine-specific: QuereusEngine serializes catalog, ActionsEngine may use collection list
- Cached to avoid recomputing if schema unchanged

### 10. Read Tracking at Block Level
Track reads at block granularity:
- Simpler implementation
- Sufficient for optimistic concurrency control
- Can refine to row-level later if needed

### 11. Performance Trade-offs
Accept cost of re-executing statements on cluster participants:
- Still better than blockchain (not everyone replicates everything)
- Only cluster participants for affected blocks re-execute
- Broader validation: each participant validates entire transaction
- Can optimize later with Merkle trees, sampling, caching

## Success Criteria

1. **Multi-Collection Atomicity**: Transactions affecting multiple collections (table + indexes) commit atomically or not at all
2. **Statement Validation**: Validators re-execute statements and verify operations match
3. **Schema Consistency**: All peers reject transactions with schema mismatches (via stamp.schemaHash)
4. **Deterministic Execution**: Same statements produce same operations on all peers
5. **Conflict Detection**: Stale reads detected and rejected
6. **Critical Cluster Consensus**: All log tail clusters participate in consensus
7. **Pluggable Engines**: ActionsEngine and QuereusEngine both work
8. **Operations Hash Validation**: Single hash validates entire transaction across all blocks
9. **Stamp/CID Separation**: StampId stable throughout, CID computed at commit
10. **Engine-Agnostic Validation**: db-p2p validates any engine through ITransactionEngine interface

## Key Architectural Insights

### 1. Scalability Through Decentralization
No global transaction log - each collection maintains its own log. Transactions are recorded in all affected collection logs, maintaining scalability.

### 2. Temporary Supercluster Coordination
Critical clusters form temporary consensus groups via GATHER phase, not persistent superclusters. This avoids creating new bottlenecks.

### 3. Separation of Mechanism and Policy
- **db-core**: Provides mechanism (TransactionCoordinator, TransactionSession, ITransactionEngine)
- **quereus-plugin-optimystic**: Provides policy (QuereusEngine, schema hashing)
- **db-p2p**: Provides transport and validation (engine-agnostic)

This separation enables:
- Testing multi-collection transactions without SQL (ActionsEngine)
- Alternative validation strategies (different engines)
- Reuse of components across different use cases

### 4. Statements as Unit of Validation
Transactions are validated by re-executing statements, not by comparing operations directly:
- Validators replay transaction statements through their local engine
- Compute operations hash from resulting operations
- Compare hash with sender's hash
- Ensures semantic correctness, not just structural correctness

### 5. Layered Architecture
Clear separation between layers:
- **Engine Layer**: Translates statements → actions (QuereusEngine, ActionsEngine)
- **Coordinator Layer**: Applies actions, orchestrates consensus (TransactionCoordinator)
- **Session Layer**: Manages incremental transaction building (TransactionSession)
- **Network Layer**: Validates and distributes transactions (db-p2p)

### 6. Operations Hash for Efficiency
Single hash validates entire transaction:
- Avoids sending full operation details to every block
- Each validator computes hash from their replay
- Broader validation: every participant validates entire transaction
- Detects Byzantine faults or bugs in statement execution

## Putting It All Together: Example Flow

### Scenario
Client executes: `INSERT INTO users (id, name) VALUES (1, 'Alice')`

This affects:
- Main table collection (users)
- Index collection (users_by_name)

### Step-by-Step Flow

**1. BEGIN Transaction (quereus-plugin-optimystic)**
```typescript
// User calls:
await db.execute("BEGIN");

// OptimysticModule creates TransactionStamp:
const stamp: TransactionStamp = {
  peerId: coordinator.getPeerId(),
  timestamp: Date.now(),
  schemaHash: await quereusEngine.getSchemaHash(), // Cached
  engineId: 'quereus@0.5.3'
};
const stampId = createStampId(stamp);

// Create TransactionSession:
const session = new TransactionSession(coordinator, stampId, 'quereus@0.5.3');
```

**2. Execute Statement (quereus-plugin-optimystic)**
```typescript
// User calls:
await db.execute("INSERT INTO users (id, name) VALUES (1, 'Alice')");

// Session executes statement:
await session.execute("INSERT INTO users (id, name) VALUES (1, 'Alice')");

// QuereusEngine.executeStatement() called:
// - Translates SQL to actions:
//   - users collection: INSERT action
//   - users_by_name collection: INSERT action
// - Calls coordinator.applyActions([...], stampId)

// Coordinator.applyActions() called:
// - Applies actions to collections immediately (local snapshot)
// - Actions tagged with stampId
// - Operations recorded in collection trackers
```

**3. COMMIT Transaction (quereus-plugin-optimystic)**
```typescript
// User calls:
await db.execute("COMMIT");

// Session.commit() called:
// - Compiles statements: JSON.stringify(["INSERT INTO users..."])
// - Creates Transaction:
const transaction: Transaction = {
  stampId,
  statements: JSON.stringify(["INSERT INTO users (id, name) VALUES (1, 'Alice')"]),
  reads: [], // TODO: Track reads
  cid: createTransactionCid(stampId, statements, [])
};

// - Calls coordinator.commit(transaction)
```

**4. GATHER Phase (db-core TransactionCoordinator)**
```typescript
// Coordinator.commit() called:
// - Collects operations from trackers (users, users_by_name)
// - Computes operations hash (single hash for ALL operations)
// - Groups operations by block
// - Identifies critical clusters:
//   - users collection → log tail block 0xABCD
//   - users_by_name collection → log tail block 0x1234

// GATHER phase (multi-collection):
// - Query 0xABCD cluster → nominees: {peer1, peer2, peer3}
// - Query 0x1234 cluster → nominees: {peer4, peer5, peer6}
// - Supercluster: {peer1, peer2, peer3, peer4, peer5, peer6}
```

**5. PEND Phase (db-p2p NetworkTransactor)**
```typescript
// Send PendRequest to all affected block clusters:
const pendRequest: PendRequest = {
  transaction,
  operationsHash: "0xABCDEF...", // Hash of ALL operations
  blocks: [
    { blockId: "0xABCD", rev: 5 },  // users log tail
    { blockId: "0x1234", rev: 3 }   // users_by_name log tail
  ],
  policy: { superclusterNominees: {peer1, peer2, peer3, peer4, peer5, peer6} }
};

// Each cluster participant validates:
// 1. Get stamp from transaction.stampId
// 2. Verify stamp.engineId matches local engine
// 3. Verify stamp.schemaHash matches local schema
// 4. Verify read dependencies
// 5. Create temp coordinator for validation
// 6. Re-execute transaction through QuereusEngine
// 7. Collect ALL operations from temp coordinator
// 8. Compute operations hash
// 9. Compare with sender's operationsHash
// 10. If match → PEND succeeds, else reject
```

**6. COMMIT Phase (db-p2p NetworkTransactor)**
```typescript
// Send commit to critical clusters:
// - 0xABCD cluster (users log tail)
// - 0x1234 cluster (users_by_name log tail)

// Each critical cluster:
// - Achieves consensus among supercluster
// - All must succeed for transaction to commit
// - If any fails, entire transaction aborts
```

**7. PROPAGATE & CHECKPOINT Phases**
```typescript
// Notify all block clusters of success
// Clusters finalize their local changes
// Append to collection logs:
// - users log: records actions with transaction.cid
// - users_by_name log: records actions with transaction.cid

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

