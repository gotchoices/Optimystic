import type { ITransactor, TransactionCoordinator, ITransactionEngine } from '@optimystic/db-core';
import { TransactionSession, createTransactionStamp, createTransactionId } from '@optimystic/db-core';
import type { TransactionState, ParsedOptimysticOptions } from '../types.js';
import { CollectionFactory } from './collection-factory.js';
import { generateStampId } from '../util/generate-stamp-id.js';
import { QUEREUS_ENGINE_ID } from '../transaction/quereus-engine.js';

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

    // Clear any previously accumulated statements
    this.accumulatedStatements = [];

    // Create TransactionSession if transaction mode is enabled
    if (this.coordinator && this.engine && this.schemaHashProvider) {
      const schemaHash = await this.schemaHashProvider();
      this.session = new TransactionSession(
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
        // Transaction mode: commit through session for distributed consensus
        const result = await this.session.commit();
        if (!result.success) {
          throw new Error(result.error || 'Transaction commit failed');
        }
      } else {
        // Legacy mode: sync all collections directly
        for (const [, collection] of this.currentTransaction.collections) {
          await this.collectionFactory.syncCollection(collection);
        }
      }

      this.currentTransaction.isActive = false;
      this.accumulatedStatements = [];
      this.session = null;

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
  async savepoint(name: string): Promise<void> {
    // Optimystic doesn't have explicit savepoint support
    // This would need to be implemented using collection snapshots
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Release savepoint
   */
  async releaseSavepoint(name: string): Promise<void> {
    throw new Error('Savepoints not yet implemented');
  }

  /**
   * Rollback to savepoint
   */
  async rollbackToSavepoint(name: string): Promise<void> {
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
