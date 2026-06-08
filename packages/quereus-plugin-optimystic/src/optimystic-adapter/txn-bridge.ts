import type { TransactionCoordinator, ITransactionEngine } from '@optimystic/db-core';
import { TransactionSession } from '@optimystic/db-core';
import type { TransactionState, ParsedOptimysticOptions } from '../types.js';
import { CollectionFactory } from './collection-factory.js';
import { generateStampId } from '../util/generate-stamp-id.js';

/**
 * Minimal tree surface the bridge needs to flush (at commit) or discard (at
 * rollback) DML that was staged into the collection tracker but not yet pushed
 * to the transactor. `@optimystic/db-core`'s `Tree` satisfies this structurally,
 * so both the main-table tree and index trees can share one dirty set without
 * generic-parameter friction.
 */
export interface DirtyTree {
  sync(): Promise<void>;
  discardChanges(): void;
}

/**
 * Transaction bridge between Quereus and Optimystic.
 *
 * This bridge handles both:
 * 1. Legacy mode: Direct collection sync (when no coordinator/engine is set)
 * 2. Transaction mode: Using TransactionSession for distributed consensus
 */
export class TransactionBridge {
  private currentTransaction: TransactionState | null = null;
  private collectionFactory: CollectionFactory;
  /** Accumulated SQL statements for the current transaction */
  private accumulatedStatements: string[] = [];
  /**
   * Trees with DML staged this transaction (main table + touched index trees).
   * Populated by {@link markDirty} at DML time; flushed at commit (legacy mode)
   * or discarded at rollback. This is the authoritative set rather than
   * `currentTransaction.collections` because the vtab's main collection is
   * long-lived (created before the txn) and index trees are created with a
   * throwaway txnState, so neither reliably lands in that map.
   */
  private dirtyTrees = new Set<DirtyTree>();
  /** Optional transaction session for distributed consensus */
  private session: TransactionSession | null = null;
  /** Optional coordinator for transaction mode */
  private coordinator: TransactionCoordinator | null = null;
  /** Optional engine for transaction mode */
  private engine: ITransactionEngine | null = null;
  /** Schema hash provider function */
  private schemaHashProvider: (() => Promise<string>) | null = null;

  constructor(collectionFactory: CollectionFactory) {
    this.collectionFactory = collectionFactory;
  }

  /**
   * Configure the transaction bridge for distributed consensus mode.
   *
   * When configured, transactions will use TransactionSession for
   * coordinated commit with validation.
   *
   * @param coordinator - The transaction coordinator
   * @param engine - The transaction engine (e.g., QuereusEngine)
   * @param schemaHashProvider - Function to get the current schema hash
   */
  configureTransactionMode(
    coordinator: TransactionCoordinator,
    engine: ITransactionEngine,
    schemaHashProvider: () => Promise<string>
  ): void {
    this.coordinator = coordinator;
    this.engine = engine;
    this.schemaHashProvider = schemaHashProvider;
  }

  /**
   * Check if transaction mode is enabled.
   */
  isTransactionModeEnabled(): boolean {
    return this.coordinator !== null && this.engine !== null;
  }

  /**
   * Begin a new transaction.
   *
   * If transaction mode is enabled, creates a TransactionSession for
   * distributed consensus. Otherwise, uses legacy direct sync mode.
   *
   * Following SQLite semantics: if a transaction is already active,
   * this is a no-op and returns the existing transaction.
   */
  async beginTransaction(options: ParsedOptimysticOptions): Promise<TransactionState> {
    if (this.currentTransaction?.isActive) {
      // Already in transaction - SQLite semantics: BEGIN is a no-op
      return this.currentTransaction;
    }

    const transactor = await this.collectionFactory.getOrCreateTransactor(options);
    const peerId = this.collectionFactory.getPeerId(options);

    // Clear any previously accumulated statements + staged-tree tracking
    this.accumulatedStatements = [];
    this.dirtyTrees.clear();

    // Create TransactionSession if transaction mode is enabled
    if (this.coordinator && this.engine && this.schemaHashProvider) {
      const schemaHash = await this.schemaHashProvider();
      this.session = await TransactionSession.create(
        this.coordinator,
        this.engine,
        peerId,
        schemaHash
      );
    } else {
      this.session = null;
    }

    // Generate transaction ID from session or legacy method
    const transactionId = this.session
      ? this.session.getStampId()
      : generateStampId(peerId);

    this.currentTransaction = {
      transactor,
      isActive: true,
      collections: new Map(),
      stampId: transactionId,
    };

    return this.currentTransaction;
  }

  /**
   * Commit the current transaction.
   *
   * If transaction mode is enabled, commits through TransactionSession
   * for distributed consensus. Otherwise, uses legacy direct sync.
   */
  async commitTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to commit');
    }

    try {
      if (this.session) {
        // Transaction mode: commit through session for distributed consensus.
        // The DML path now STAGES into the collection trackers (no inline sync),
        // and the coordinator's commit() reads `tracker.transforms` directly, so
        // we deliberately do NOT tree.sync() here — flushing would reset the
        // trackers out from under consensus. Session-mode commit composition
        // against the staging DML path is not yet covered by a real-DML test;
        // see fix/optimystic-session-mode-commit-composition.
        const result = await this.session.commit();
        if (!result.success) {
          throw new Error(result.error || 'Transaction commit failed');
        }
      } else {
        // Legacy mode: flush every tree that staged DML this transaction. This
        // replaces the inline updateAndSync that Tree.replace() used to perform
        // at DML time — deferring the flush to commit is what lets a deferred
        // (subquery-bearing) CHECK rejection roll back cleanly: the constraint
        // throws before this point, so the staged trees are discarded never
        // having touched storage.
        for (const tree of this.dirtyTrees) {
          await tree.sync();
        }
      }

      this.currentTransaction.isActive = false;
      this.accumulatedStatements = [];
      this.session = null;
      this.dirtyTrees.clear();

    } catch (error) {
      // If commit fails, rollback
      await this.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Rollback the current transaction.
   *
   * Discards local changes and clears session state.
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to rollback');
    }

    // Rollback session if in transaction mode
    if (this.session && !this.session.isRolledBack()) {
      try {
        await this.session.rollback();
      } catch {
        // Ignore rollback errors - we're already cleaning up
      }
    }

    // Discard staged-but-unsynced DML in BOTH modes. Quereus runs deferred row
    // constraints BEFORE connection.commit(), so a constraint-failure rollback
    // reaches here while every staged tree is still un-synced — dropping the
    // tracker transforms reverts in-memory reads and leaves storage untouched,
    // which is the actual fix for the deferred-constraint atomicity bug. Safe
    // for already-synced/clean trees too (reset of an empty tracker is a no-op).
    for (const tree of this.dirtyTrees) {
      tree.discardChanges();
    }
    this.dirtyTrees.clear();

    // Clean up local state
    this.currentTransaction.collections.clear();
    this.currentTransaction.isActive = false;

    this.accumulatedStatements = [];
    this.session = null;

    // Note: We intentionally do NOT clear the collection factory cache here.
    // The transactor cache contains pre-registered transactors that should persist
    // across transactions. Clearing them would cause the factory to create new
    // disconnected transactors instead of using the registered ones.
  }

  /**
   * Get the current transaction state.
   */
  getCurrentTransaction(): TransactionState | null {
    return this.currentTransaction;
  }

  /**
   * Get the current transaction session (if in transaction mode).
   */
  getSession(): TransactionSession | null {
    return this.session;
  }

  /**
   * Check if a transaction is currently active.
   */
  isTransactionActive(): boolean {
    return this.currentTransaction?.isActive ?? false;
  }

  /**
   * Register a tree that has staged DML this transaction so it is flushed at
   * commit (legacy mode) or discarded at rollback. The vtab DML path calls this
   * for the main-table tree and each touched index tree after staging. Idempotent
   * — repeated marks of the same tree collapse in the Set.
   */
  markDirty(tree: DirtyTree): void {
    this.dirtyTrees.add(tree);
  }

  /**
   * Add a SQL statement to the accumulated statements for the current transaction.
   * Statements are only accumulated when a transaction is active.
   *
   * In transaction mode, this also forwards the statement to the TransactionSession
   * for distributed consensus tracking.
   *
   * @param statement The deterministic SQL statement to accumulate
   */
  addStatement(statement: string): void {
    if (!this.currentTransaction?.isActive) {
      return;
    }

    this.accumulatedStatements.push(statement);

    // In transaction mode, also track in session
    // Note: We pass empty actions since the virtual table already applied changes
    // The session just needs to track the statement for the Transaction record
    if (this.session) {
      // We don't await here - statement tracking is synchronous
      // The session's execute() will just accumulate the statement
      // Actions are already applied by the virtual table
      void this.session.execute(statement, []);
    }
  }

  /**
   * Get all accumulated SQL statements for the current transaction.
   * @returns Array of SQL statements in execution order
   */
  getStatements(): readonly string[] {
    return this.accumulatedStatements;
  }

  /**
   * Get the count of accumulated statements
   */
  getStatementCount(): number {
    return this.accumulatedStatements.length;
  }

  /**
   * Savepoint support (if needed by Quereus)
   */
  async savepoint(_name: string): Promise<void> {
    // Optimystic doesn't have explicit savepoint support
    // This would need to be implemented using collection snapshots
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Release savepoint
   */
  async releaseSavepoint(_name: string): Promise<void> {
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Rollback to savepoint
   */
  async rollbackToSavepoint(_name: string): Promise<void> {
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.currentTransaction?.isActive) {
      await this.rollbackTransaction();
    }
    this.currentTransaction = null;
  }
}
