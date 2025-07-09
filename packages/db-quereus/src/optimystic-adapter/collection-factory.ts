import type { ITransactor, CollectionId } from '@optimystic/db-core';
import { Tree } from '@optimystic/db-core';
import { NetworkTransactor } from '@optimystic/db-core';
import type { RowData, ParsedOptimysticOptions, TransactionState } from '../types.js';
import { createKeyNetwork } from './key-network.js';

/**
 * Factory for creating and managing tree collections
 */
export class CollectionFactory {
  private collections = new Map<string, Tree<string, RowData>>();
  private transactors = new Map<string, ITransactor>();

  /**
   * Create or get a tree collection
   */
  async createOrGetCollection(
    options: ParsedOptimysticOptions,
    txnState?: TransactionState
  ): Promise<Tree<string, RowData>> {
    const collectionKey = this.getCollectionKey(options);

    // If we have an active transaction, check if the collection is already loaded
    if (txnState?.isActive && txnState.collections.has(collectionKey)) {
      return txnState.collections.get(collectionKey);
    }

    // Check if we have a cached collection (for non-transactional access)
    if (!txnState && this.collections.has(collectionKey)) {
      const collection = this.collections.get(collectionKey)!;
      // TODO: Check if collection is stale and needs update()
      return collection;
    }

    // Create new collection
    const transactor = await this.getOrCreateTransactor(options);
    const collectionId = this.parseCollectionId(options.collectionUri);

    const collection = await Tree.createOrOpen<string, RowData>(
      transactor,
      collectionId,
      (entry: RowData) => this.extractKeyFromEntry(entry), // Key extractor
      (a: string, b: string) => a.localeCompare(b) // String comparison
    );

    // Store in appropriate cache
    if (txnState?.isActive) {
      txnState.collections.set(collectionKey, collection);
    } else {
      this.collections.set(collectionKey, collection);
    }

    return collection;
  }

  /**
   * Create a transactor for the given configuration
   */
  async createTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    switch (options.transactor) {
      case 'network':
        return await this.createNetworkTransactor(options);

      case 'test':
        return await this.createTestTransactor();

      default:
        return await this.createCustomTransactor(options.transactor);
    }
  }

  /**
   * Get or create a transactor (with caching)
   */
  private async getOrCreateTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    const transactorKey = this.getTransactorKey(options);

    if (this.transactors.has(transactorKey)) {
      return this.transactors.get(transactorKey)!;
    }

    const transactor = await this.createTransactor(options);
    this.transactors.set(transactorKey, transactor);
    return transactor;
  }

  /**
   * Create a network transactor
   */
  private async createNetworkTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    const keyNetwork = await createKeyNetwork(
      options.keyNetwork,
      options.libp2p,
      options.libp2pOptions
    );

    return new NetworkTransactor(keyNetwork);
  }

  /**
   * Create a test transactor
   */
  private async createTestTransactor(): Promise<ITransactor> {
    // Import test transactor from db-core test utilities
    try {
      const { TestTransactor } = await import('@optimystic/db-core/test');
      return new TestTransactor();
    } catch (error) {
      throw new Error('Test transactor not available. Make sure @optimystic/db-core test utilities are installed.');
    }
  }

  /**
   * Create a custom transactor
   */
  private async createCustomTransactor(name: string): Promise<ITransactor> {
    // This would use the custom registry from key-network.ts
    const { getCustomRegistry } = await import('./key-network.js');
    const registry = getCustomRegistry();

    const CustomTransactor = registry.transactors.get(name);
    if (!CustomTransactor) {
      throw new Error(`Custom transactor '${name}' not found. Register it first using registerTransactor().`);
    }

    return new CustomTransactor();
  }

  /**
   * Parse collection URI to extract collection ID
   */
  private parseCollectionId(uri: string): CollectionId {
    // Parse URIs like 'tree://mydb/users' or just 'users'
    if (uri.startsWith('tree://')) {
      const path = uri.substring(7); // Remove 'tree://'
      const parts = path.split('/');
      if (parts.length >= 2) {
        return parts[1]; // Return the collection name part
      }
      return path;
    }
    return uri;
  }

  /**
   * Extract key from entry (assumes first element is the primary key)
   */
  private extractKeyFromEntry(entry: RowData): string {
    if (entry.length === 0) {
      throw new Error('Entry must have at least one element (primary key)');
    }
    const key = entry[0];
    if (typeof key !== 'string') {
      throw new Error('Primary key must be a string');
    }
    return key;
  }

  /**
   * Generate a unique key for collection caching
   */
  private getCollectionKey(options: ParsedOptimysticOptions): string {
    return `${options.collectionUri}:${options.transactor}:${options.keyNetwork}`;
  }

  /**
   * Generate a unique key for transactor caching
   */
  private getTransactorKey(options: ParsedOptimysticOptions): string {
    return `${options.transactor}:${options.keyNetwork}`;
  }

  /**
   * Clear all cached collections (useful for testing or cleanup)
   */
  clearCache(): void {
    this.collections.clear();
    this.transactors.clear();
  }

  /**
   * Sync a collection (call collection.sync())
   */
  async syncCollection(collection: Tree<string, RowData>): Promise<void> {
    // The Tree class doesn't expose sync directly, but we can call updateAndSync
    // This is a placeholder - we'd need to check the actual Tree API
    // await collection.updateAndSync();

    // For now, we'll assume the sync happens as part of the replace operation
    // which calls updateAndSync internally
  }
}
