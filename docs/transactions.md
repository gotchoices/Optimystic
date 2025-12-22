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

- **Transaction Stamp ID** (`stamp.id`): Created at transaction BEGIN, remains stable throughout the transaction lifecycle. This is a hash of the stamp fields (peer ID, timestamp, schema hash, engine ID). Exposed to users via `StampId()` UDF.
- **Transaction ID** (`transaction.id`): Computed at COMMIT as a hash of the stamp.id + statements + reads. This is the final, immutable transaction identity used in logs and block references.

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
// Transaction Stamp: Created at BEGIN, stable throughout transaction
type TransactionStamp = {
  peerId: string;           // Who initiated the transaction
  timestamp: number;        // When transaction started (milliseconds)
  schemaHash: string;       // Hash of schema version(s) for validation
  engineId: string;         // Which engine (e.g., 'quereus@0.5.3')
  id: string;               // Stamp ID (hash of peerId + timestamp + schemaHash + engineId) - stable throughout transaction
};

// Transaction: Finalized at COMMIT
type Transaction = {
  // The transaction stamp (contains stable stamp.id)
  stamp: TransactionStamp;

  // Engine-specific statements (for replay/validation)
  statements: string[];  // Array of statements - for Quereus: SQL statements; for ActionsEngine: JSON-encoded actions

  // Read dependencies for optimistic concurrency control
  reads: ReadDependency[];

  // Transaction identifier used in logs (hash of stamp.id + statements + reads)
  id: string;
};

type ReadDependency = {
  blockId: BlockId;
  revision: number;  // Expected revision
};

// Actions reference the transaction stamp ID they came from
type Action<T> = {
  type: ActionType;
  data: T;
  transaction: string;  // stamp.id
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

### 1. Transaction Engine Interface (db-core)

Engines translate domain-specific statements into actions. The engine interface is minimal - engines don't need to track state or manage transactions:

```typescript
// In db-core/src/transaction/engine.ts
export interface ITransactionEngine {
  /**
   * Execute a complete transaction and return the resulting actions.
   * This is used both during transaction building (to translate statements)
   * and during validation/replay (to verify operations hash).
   *
   * @param transaction - The transaction to execute
   * @returns ExecutionResult with success flag and actions (if successful)
   */
  execute(transaction: Transaction): Promise<ExecutionResult>;
}

export type ExecutionResult = {
  success: boolean;
  error?: string;
  actions?: CollectionActions[];
};

export type CollectionActions = {
  collectionId: string;
  actions: Action<any>[];
};
```

### 2. Built-in Actions Engine (db-core)

For testing and simple use cases, db-core provides a built-in actions engine:

```typescript
// In db-core/src/transaction/actions-engine.ts
export const ACTIONS_ENGINE_ID = "actions@1.0.0";

// The ActionsEngine takes a coordinator and applies actions directly
// Each statement is a JSON-encoded CollectionActions object
export class ActionsEngine implements ITransactionEngine {
  constructor(private coordinator: TransactionCoordinator) {}

  async execute(transaction: Transaction): Promise<ExecutionResult> {
    try {
      // Parse all statements (each is a JSON-encoded CollectionActions)
      const actions: CollectionActions[] = transaction.statements.map(stmt =>
        JSON.parse(stmt)
      );

      return { success: true, actions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to parse actions'
      };
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

// The QuereusEngine wraps a Quereus database instance and coordinator
export class QuereusEngine implements ITransactionEngine {
  constructor(
    private db: QuereusDatabase,
    private coordinator: TransactionCoordinator
  ) {}

  async execute(transaction: Transaction): Promise<ExecutionResult> {
    try {
      const actions: CollectionActions[] = [];

      // Execute each SQL statement and collect resulting actions
      for (const statement of transaction.statements) {
        const { sql, params } = JSON.parse(statement);

        // Execute SQL through Quereus
        // The Optimystic virtual table module will translate to actions
        // and call coordinator.applyActions()
        const result = await this.db.exec(sql, params, {
          stampId: transaction.stamp.id
        });

        // Collect actions from the execution
        // (In practice, actions are collected from the coordinator's trackers)
      }

      return { success: true, actions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to execute SQL'
      };
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

Manages incremental transaction building. The session:
1. Creates a stable transaction stamp at BEGIN (in constructor)
2. Acts as a container for statements
3. Enlists the engine to translate statements to actions (if not already provided)
4. Commits by creating a complete Transaction and calling coordinator.commit()

```typescript
// In db-core/src/transaction/session.ts
export class TransactionSession {
  private readonly statements: string[] = [];
  private readonly stamp: TransactionStamp;  // Created at BEGIN, stable throughout transaction
  private committed = false;
  private rolledBack = false;

  constructor(
    private readonly coordinator: TransactionCoordinator,
    private readonly engine: ITransactionEngine,
    peerId: string = 'local',
    schemaHash: string = ''
  ) {
    // Create stamp at BEGIN (stable throughout transaction)
    this.stamp = createTransactionStamp(
      peerId,
      Date.now(),
      schemaHash,
      'unknown' // TODO: Get engine ID from engine
    );
  }

  async execute(statement: string, actions?: CollectionActions[]): Promise<{ success: boolean; error?: string }> {
    if (this.committed || this.rolledBack) {
      return { success: false, error: 'Transaction already finalized' };
    }

    // If actions not provided, enlist engine to translate statement
    let actionsToApply: CollectionActions[];
    if (actions) {
      actionsToApply = actions;
    } else {
      const tempTransaction: Transaction = {
        stamp: this.stamp,
        statements: [statement],
        reads: [],
        id: 'temp'
      };
      const result = await this.engine.execute(tempTransaction);
      if (!result.success || !result.actions) {
        return { success: false, error: result.error || 'Failed to translate statement' };
      }
      actionsToApply = result.actions;
    }

    // Apply actions through coordinator
    await this.coordinator.applyActions(actionsToApply, this.stamp.id);
    this.statements.push(statement);
    return { success: true };
  }

  async commit(): Promise<ExecutionResult> {
    if (this.committed) {
      return { success: false, error: 'Transaction already committed' };
    }
    if (this.rolledBack) {
      return { success: false, error: 'Transaction already rolled back' };
    }

    // Create the complete transaction
    const transaction: Transaction = {
      stamp: this.stamp,
      statements: this.statements,
      reads: [], // TODO: Track reads during statement execution
      id: createTransactionId(this.stamp.id, this.statements, [])
    };

    // Commit through coordinator (which will orchestrate PEND/COMMIT)
    await this.coordinator.commit(transaction);

    this.committed = true;
    return { success: true };
  }

  async rollback(): Promise<ExecutionResult> {
    if (this.committed) {
      return { success: false, error: 'Transaction already committed' };
    }
    if (this.rolledBack) {
      return { success: false, error: 'Transaction already rolled back' };
    }

    // Rollback through coordinator
    await this.coordinator.rollback(this.stamp.id);

    this.rolledBack = true;
    return { success: true };
  }

  getStampId(): string {
    return this.stamp.id;
  }

  getStamp(): TransactionStamp {
    return this.stamp;
  }
}
```

### 5. Transaction Coordinator (db-core)

Coordinates multi-collection transactions. The coordinator is mostly unaware of statements - it just manages collections:
1. Takes actions and plays them against collections (creating collections as needed)
2. Commits, given a transaction, by running the appropriate phases against the collection(s) involved

```typescript
// In db-core/src/transaction/coordinator.ts
export class TransactionCoordinator {
  constructor(
    private readonly transactor: ITransactor,
    private readonly collections: Map<CollectionId, Collection<any>>
  ) {}

  // Apply actions to collections (called by engines during statement execution)
  async applyActions(
    actions: CollectionActions[],
    stampId: string
  ): Promise<void> {
    for (const { collectionId, actions: collectionActions } of actions) {
      // Get collection
      const collection = this.collections.get(collectionId);
      if (!collection) {
        throw new Error(`Collection not found: ${collectionId}`);
      }

      // Apply each action (tagged with stampId)
      for (const action of collectionActions) {
        const taggedAction = { ...(action as any), transaction: stampId };
        await collection.act(taggedAction);
      }
    }
  }

  // Commit a transaction (actions already applied, orchestrate PEND/COMMIT)
  async commit(transaction: Transaction): Promise<void> {
    // 1. Collect operations from collection trackers and identify critical blocks
    const collectionTransforms = new Map<CollectionId, Transforms>();
    const criticalBlocks = new Map<CollectionId, BlockId>();
    const allOperations: any[] = [];

    for (const [collectionId, collection] of this.collections.entries()) {
      // Check if this collection has pending changes for this transaction
      const transforms = collection.tracker.transforms;
      const hasChanges = Object.keys(transforms.inserts).length +
                         Object.keys(transforms.updates).length +
                         transforms.deletes.length > 0;

      if (hasChanges) {
        collectionTransforms.set(collectionId, transforms);

        // Collect all operations from this collection's transforms
        for (const [blockId, block] of Object.entries(transforms.inserts)) {
          allOperations.push({ type: 'insert', collectionId, blockId, block });
        }
        for (const [blockId, operations] of Object.entries(transforms.updates)) {
          allOperations.push({ type: 'update', collectionId, blockId, operations });
        }
        for (const blockId of transforms.deletes) {
          allOperations.push({ type: 'delete', collectionId, blockId });
        }

        // Get the log tail block ID (critical block) for this collection
        const log = await Log.open(collection.tracker, collectionId);
        if (log) {
          const tailPath = await (log as any).chain.getTail();
          if (tailPath) {
            criticalBlocks.set(collectionId, tailPath.block.header.id);
          }
        }
      }
    }

    if (collectionTransforms.size === 0) {
      return; // Nothing to commit
    }

    // 2. Compute hash of ALL operations across ALL collections
    // This hash is used for validation - validators re-execute the transaction
    // and compare their computed operations hash with this one
    // TODO: Pass operationsHash to PEND phase when we update PendRequest type
    const _operationsHash = this.hashOperations(allOperations);

    // 3. Execute consensus phases (GATHER, PEND, COMMIT)
    const coordResult = await this.coordinateTransaction(
      transaction,
      collectionTransforms,
      criticalBlocks
    );

    if (!coordResult.success) {
      throw new Error(`Transaction commit failed: ${coordResult.error}`);
    }
  }

  // Rollback a transaction (undo applied actions)
  async rollback(_stampId: string): Promise<void> {
    // Clear trackers for all collections
    // This discards all pending changes that were applied via applyActions()
    // TODO: In the future, we may want to track which collections were affected by
    // a specific stampId and only reset those trackers
    for (const collection of this.collections.values()) {
      collection.tracker.reset();
    }
  }

  private hashOperations(operations: any[]): string {
    const operationsData = JSON.stringify(operations);
    let hash = 0;
    for (let i = 0; i < operationsData.length; i++) {
      const char = operationsData.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `ops:${Math.abs(hash).toString(36)}`;
  }

  private async coordinateTransaction(
    transaction: Transaction,
    collectionTransforms: Map<CollectionId, Transforms>,
    criticalBlocks: Map<CollectionId, BlockId>
  ): Promise<{ success: boolean; error?: string }> {
    // Phase 1: GATHER - Collect critical cluster nominees (skip if single collection)
    const superclusterNominees = criticalBlocks.size > 1
      ? await this.gatherPhase(criticalBlocks)
      : null;

    // Phase 2: PEND - Distribute to all block clusters for validation
    const pendResult = await this.pendPhase(
      transaction,
      collectionTransforms,
      criticalBlocks,
      superclusterNominees
    );
    if (!pendResult.success) {
      await this.cancelPhase(transaction, criticalBlocks);
      return pendResult;
    }

    // Phase 3: COMMIT - Consensus across critical clusters
    const commitResult = await this.commitPhase(transaction, criticalBlocks);
    if (!commitResult.success) {
      await this.cancelPhase(transaction, criticalBlocks);
      return commitResult;
    }

    // Phases 4-5 (PROPAGATE, CHECKPOINT) are cluster-managed
    return { success: true };
  }

  private async gatherPhase(
    criticalBlocks: Map<CollectionId, BlockId>
  ): Promise<Set<string>> {
    // Query each critical cluster for their participant nominees
    const nominees = new Set<string>();

    for (const blockId of criticalBlocks.values()) {
      const cluster = await this.transactor.getCluster(blockId);
      for (const peerId of cluster) {
        nominees.add(peerId);
      }
    }

    return nominees;
  }

  private async pendPhase(
    transaction: Transaction,
    collectionTransforms: Map<CollectionId, Transforms>,
    criticalBlocks: Map<CollectionId, BlockId>,
    superclusterNominees: Set<string> | null
  ): Promise<{ success: boolean; error?: string }> {
    // Send PEND request to each critical block cluster
    const pendPromises: Promise<{ success: boolean; error?: string }>[] = [];

    for (const [collectionId, blockId] of criticalBlocks.entries()) {
      const transforms = collectionTransforms.get(collectionId);
      if (!transforms) continue;

      const pendPromise = this.transactor.pend({
        transaction,
        blockId,
        transforms,
        superclusterNominees: superclusterNominees ? Array.from(superclusterNominees) : undefined
      });
      pendPromises.push(pendPromise);
    }

    const results = await Promise.all(pendPromises);
    const failed = results.find(r => !r.success);
    if (failed) {
      return failed;
    }

    return { success: true };
  }

  private async commitPhase(
    transaction: Transaction,
    criticalBlocks: Map<CollectionId, BlockId>
  ): Promise<{ success: boolean; error?: string }> {
    // Commit to all critical blocks
    const commitPromises: Promise<{ success: boolean; error?: string }>[] = [];

    for (const blockId of criticalBlocks.values()) {
      const commitPromise = this.transactor.commit({
        transaction,
        blockId
      });
      commitPromises.push(commitPromise);
    }

    const results = await Promise.all(commitPromises);
    const failed = results.find(r => !r.success);
    if (failed) {
      return failed;
    }

    return { success: true };
  }

  private async cancelPhase(
    transaction: Transaction,
    criticalBlocks: Map<CollectionId, BlockId>
  ): Promise<void> {
    // Cancel pending actions on all critical blocks
    const cancelPromises: Promise<void>[] = [];

    for (const blockId of criticalBlocks.values()) {
      const cancelPromise = this.transactor.cancel({
        transaction,
        blockId
      });
      cancelPromises.push(cancelPromise);
    }

    await Promise.all(cancelPromises);
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

**Context**: The codebase uses "ActionId/ActionRev" as the canonical type names, with "TrxId/TrxRev" as deprecated aliases for backward compatibility.

**Tasks**:
- [x] Audit all uses of "Trx", "TrxId", "transaction" in db-core
- [x] Rename to use "Action" terminology consistently
- [x] Update type names: `TrxId` → `ActionId` (TrxId kept as deprecated alias)
- [x] Update function names: `getTrxId()` → `getActionId()`
- [x] Update comments and documentation
- [x] Ensure "transaction" is reserved for the new multi-collection concept
- [x] Update tests to use new nomenclature (renamed generate-*-trx-id.ts to generate-*-action-id.ts)
- [x] Verify no breaking changes to public API (deprecated aliases maintained for backward compatibility)

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
- [x] Implement operation collection from trackers (in commit() method)
- [x] Implement operation hashing (hashOperations() method)
- [x] Implement critical cluster identification (via Log.open() and chain.getTail())
- [x] Implement GATHER phase (gatherPhase() method - skips for single collection)
- [x] Implement PEND phase (pendPhase() method - sends transaction + operationsHash + superclusterNominees)
- [x] Implement COMMIT phase (commitPhase() method - commits to all critical blocks)
- [x] Update PendRequest type (transaction, operationsHash, superclusterNominees)
- [x] Tests for multi-collection coordination with ActionsEngine (comprehensive test suite in transaction.spec.ts)

**Deliverable**: Can coordinate transactions across multiple collections ✅

### Phase 3: Network Support (db-p2p)
**Goal**: Add network support for multi-collection consensus and validation

**Tasks**:
- [x] Update PendRequest type in ITransactor interface (includes transaction, operationsHash, superclusterNominees)
- [x] Implement TransactionValidator (generic, engine-agnostic) in db-core/src/transaction/validator.ts
  - [x] Verify stamp.engineId matches local engine
  - [x] Verify stamp.schemaHash matches local schema
  - [ ] Verify read dependencies (TODO: will be implemented with proper block versioning)
  - [x] Re-execute transaction through engine
  - [x] Compute operations hash from temp coordinator
  - [x] Compare with sender's operations hash
- [x] Extend NetworkTransactor for GATHER phase (queryClusterNominees method)
- [x] Implement cluster nominee queries (in network-transactor.ts)
- [ ] Add nominee reasonableness checks (spot-checking nominees from other neighborhoods)
- [x] Tests for transaction validation (in transaction.spec.ts)

**Deliverable**: Multi-collection transactions work over network with validation (mostly complete)

### Phase 4: Quereus Engine (quereus-plugin-optimystic) ✓ COMPLETE
**Goal**: Implement QuereusEngine for SQL transaction execution

**Implementation**: `packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts`

**Tasks**:
- [x] Define QuereusStatements type (array of {sql, params})
- [x] Implement QuereusEngine class
  - [x] Constructor takes QuereusDatabase and TransactionCoordinator
  - [x] execute() - execute all statements from Transaction
  - [x] getSchemaHash() - query schema and hash
- [x] Implement schema hash caching (avoid recomputing if unchanged)
- [x] Tests for QuereusEngine (11 tests in quereus-engine.spec.ts)

**Deliverable**: QuereusEngine can execute and validate SQL transactions

### Phase 5: Optimystic Module Integration (quereus-plugin-optimystic) ✅
**Goal**: Integrate TransactionSession into OptimysticModule

**Tasks**:
- [x] Update TransactionBridge to use TransactionSession
  - [x] Add `configureTransactionMode(coordinator, engine, schemaHashProvider)` method
  - [x] Create TransactionSession in `beginTransaction()` when configured
  - [x] Use session's stampId as transactionId
  - [x] Forward statements to session via `session.execute()`
  - [x] Commit through session in `commitTransaction()`
  - [x] Rollback through session in `rollbackTransaction()`
- [x] Log SQL statements to session in xUpdate (via `addStatement()`)
- [x] StampId created by TransactionSession with:
  - [x] peerId from CollectionFactory
  - [x] timestamp from Date.now()
  - [x] schemaHash from schemaHashProvider
  - [x] engineId = QUEREUS_ENGINE_ID

**Deliverable**: SQL statements flow through TransactionSession → Coordinator ✅

### Phase 6: StampId() UDF (quereus-plugin-optimystic)
**Goal**: Expose StampId() UDF for SQL users

**Tasks**:
- [x] Implement StampId() UDF in Quereus (functions/transaction-id.ts)
- [x] Pass stampId through VirtualTableContext (via TransactionBridge)
- [x] Document usage (for deduplication, auditing) - documented in README.md
- [x] Tests for StampId() UDF (transaction-id.spec.ts - comprehensive test suite)

**Deliverable**: Users can access transaction stamp ID in SQL ✅

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

### 7. Transaction Stamp vs Transaction ID
Two distinct identifiers serve different purposes:
- **Stamp ID** (`stamp.id`): Created at BEGIN (hash of peerId + timestamp + schemaHash + engineId), stable throughout, exposed to users via `StampId()` UDF
- **Transaction ID** (`transaction.id`): Computed at COMMIT (hash of stamp.id + statements + reads), final immutable identity, used in logs
- Both are hashes, both are internal to their respective structures
- Stamp contains: peerId, timestamp, schemaHash, engineId, id
- Transaction contains: stamp, statements, reads, id

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
9. **Stamp/ID Separation**: Stamp.id stable throughout (created at BEGIN), transaction.id computed at commit
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
Clear separation between layers with simplified dependencies:
- **Engine Layer**: Translates statements → actions (QuereusEngine, ActionsEngine). Engines take coordinator as constructor argument.
- **Coordinator Layer**: Mostly unaware of statements - just manages collections. Applies actions to collections, orchestrates consensus phases.
- **Session Layer**: Container for statements, creates stamp at BEGIN, enlists engine to translate statements, commits by creating Transaction and calling coordinator.commit()
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

