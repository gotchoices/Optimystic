import type { ITransactor } from '@optimystic/db-core';
import type { TransactionState, ParsedOptimysticOptions } from '../types.js';
import { CollectionFactory } from './collection-factory.js';

/**
 * Transaction bridge between Quereus and Optimystic
 */
export class TransactionBridge {
  private currentTransaction: TransactionState | null = null;
  private collectionFactory: CollectionFactory;

  constructor(collectionFactory: CollectionFactory) {
    this.collectionFactory = collectionFactory;
  }

  /**
   * Begin a new transaction
   */
  async beginTransaction(options: ParsedOptimysticOptions): Promise<TransactionState> {
    if (this.currentTransaction?.isActive) {
      throw new Error('Transaction already active');
    }

    const transactor = await this.collectionFactory.createTransactor(options);

    this.currentTransaction = {
      transactor,
      isActive: true,
      collections: new Map(),
    };

    return this.currentTransaction;
  }

  /**
   * Commit the current transaction
   */
  async commitTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to commit');
    }

    try {
      // Sync all collections used in this transaction
      for (const [, collection] of this.currentTransaction.collections) {
        await this.collectionFactory.syncCollection(collection);
      }

      // The commit happens through the sync operation
      // In Optimystic, changes are applied locally and then synced
      this.currentTransaction.isActive = false;

    } catch (error) {
      // If sync fails, we need to rollback
      await this.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Rollback the current transaction
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.currentTransaction?.isActive) {
      throw new Error('No active transaction to rollback');
    }

    // In Optimystic, rollback means discarding the local changes
    // Since collections are caches, we just clear them
    this.currentTransaction.collections.clear();
    this.currentTransaction.isActive = false;

    // Clear the collection factory cache to force fresh collections
    this.collectionFactory.clearCache();
  }

  /**
   * Get the current transaction state
   */
  getCurrentTransaction(): TransactionState | null {
    return this.currentTransaction;
  }

  /**
   * Check if a transaction is currently active
   */
  isTransactionActive(): boolean {
    return this.currentTransaction?.isActive ?? false;
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
