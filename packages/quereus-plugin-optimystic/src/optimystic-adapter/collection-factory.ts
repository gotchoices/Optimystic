import type { ITransactor, CollectionId } from '@optimystic/db-core';
import { Tree } from '@optimystic/db-core';
import { NetworkTransactor } from '@optimystic/db-core';
import type { RowData, ParsedOptimysticOptions, TransactionState } from '../types.js';
import { createKeyNetwork } from './key-network.js';
import type { IRepo } from '@optimystic/db-core';
import type { PeerId, Libp2p } from '@libp2p/interface';

/**
 * Factory for creating and managing tree collections
 */
export class CollectionFactory {
  private transactors = new Map<string, ITransactor>();
  private libp2pNodes = new Map<string, { node: Libp2p; coordinatedRepo: IRepo }>();

  /**
   * Create or get a tree collection
   * Collections are only cached within a transaction to ensure proper isolation
   */
  async createOrGetCollection(
    options: ParsedOptimysticOptions,
    txnState?: TransactionState
  ): Promise<Tree<string, RowData>> {
    const collectionKey = this.getCollectionKey(options);

    // Check transaction-specific cache (only cache within transaction scope)
    if (txnState?.isActive && txnState.collections.has(collectionKey)) {
      return txnState.collections.get(collectionKey)!;
    }

    // Create new collection
    const transactor = await this.getOrCreateTransactor(options);
    const collectionId = this.parseCollectionId(options.collectionUri);

    const compare = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

    // Schema tree uses simple [key, value] tuples, not RowData arrays
    const isSchemaTree = options.collectionUri === 'tree://optimystic/schema';
    const keyExtractor = isSchemaTree
      ? (entry: any) => entry[0] as string  // For schema tree: [tableName, schema]
      : (entry: RowData) => this.extractKeyFromEntry(entry);  // For data trees: extract from RowData

    const collection = await Tree.createOrOpen<string, RowData>(
      transactor,
      collectionId,
      keyExtractor,
      compare // Total order
    );

    // Store in transaction-specific cache (if we have an active transaction)
    if (txnState?.isActive) {
      txnState.collections.set(collectionKey, collection);
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

      case 'local':
        return await this.createLocalTransactor();

      case 'test':
        return await this.createTestTransactor();

      default:
        return await this.createCustomTransactor(options.transactor);
    }
  }

  /**
   * Get or create a transactor (with caching)
   */
  async getOrCreateTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
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
    // Create or get libp2p node
    const nodeKey = this.getNodeKey(options);
    let nodeInfo = this.libp2pNodes.get(nodeKey);

    if (!nodeInfo) {
      // Create a new libp2p node with all necessary services
      const { createLibp2pNode } = await import('@optimystic/db-p2p');

      const node = await createLibp2pNode({
        port: options.libp2pOptions?.port ?? 0,
        networkName: options.libp2pOptions?.networkName ?? 'optimystic',
        bootstrapNodes: options.libp2pOptions?.bootstrapNodes ?? [],
        storageType: 'memory',
        fretProfile: 'edge',
        clusterSize: 1,
        clusterPolicy: {
          allowDownsize: true,
          sizeTolerance: 1.0
        },
        arachnode: {
          enableRingZulu: true
        }
      });

      // Get the coordinatedRepo that was created by createLibp2pNode
      const coordinatedRepo = (node as any).coordinatedRepo as IRepo;
      if (!coordinatedRepo) {
        throw new Error('Failed to get coordinatedRepo from libp2p node');
      }

      nodeInfo = { node, coordinatedRepo };
      this.libp2pNodes.set(nodeKey, nodeInfo);
    }

    const { node, coordinatedRepo } = nodeInfo;

    // Create Libp2pKeyPeerNetwork which implements both IKeyNetwork and IPeerNetwork
    const { Libp2pKeyPeerNetwork, RepoClient } = await import('@optimystic/db-p2p');
    const keyNetwork = new Libp2pKeyPeerNetwork(node);
    const protocolPrefix = `/optimystic/${options.libp2pOptions?.networkName ?? 'optimystic'}`;

    const getRepo = (peerId: PeerId): IRepo => {
      // If it's the local peer, return the coordinated repo
      if (peerId.toString() === node.peerId.toString()) {
        return coordinatedRepo;
      }
      // For remote peers, create a RepoClient
      return RepoClient.create(peerId, keyNetwork, protocolPrefix);
    };

    return new NetworkTransactor({
      timeoutMs: 30_000,
      abortOrCancelTimeoutMs: 5_000,
      keyNetwork,
      getRepo,
    });
  }

  /**
   * Create a local transactor (in-memory, single-node, no network)
   */
  private async createLocalTransactor(): Promise<ITransactor> {
    const { StorageRepo, BlockStorage, MemoryRawStorage } = await import('@optimystic/db-p2p');

    // Create a shared memory storage for all blocks
    const memoryStorage = new MemoryRawStorage();
    const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, memoryStorage));

    // LocalTransactor implementation (simple wrapper around StorageRepo)
    return {
      async get(blockGets) {
        return await storageRepo.get(blockGets);
      },
      async getStatus(_trxRefs) {
        throw new Error('getStatus not implemented in local transactor');
      },
      async pend(request) {
        return await storageRepo.pend(request);
      },
      async commit(request) {
        return await storageRepo.commit(request);
      },
      async cancel(trxRef) {
        return await storageRepo.cancel(trxRef);
      },
    } as ITransactor;
  }

  /**
   * Create a test transactor (in-memory, single-node)
   */
  private async createTestTransactor(): Promise<ITransactor> {
    const { StorageRepo, BlockStorage, MemoryRawStorage } = await import('@optimystic/db-p2p');

    // Create a shared memory storage for all blocks
    const memoryStorage = new MemoryRawStorage();

    const storageRepo = new StorageRepo((blockId) => new BlockStorage(blockId, memoryStorage));

    // Simple local transactor that wraps StorageRepo
    return {
      async get(blockGets) {
        return await storageRepo.get(blockGets);
      },
      async getStatus(_trxRefs) {
        throw new Error('getStatus not implemented in test transactor');
      },
      async pend(request) {
        return await storageRepo.pend(request);
      },
      async commit(request) {
        return await storageRepo.commit(request);
      },
      async cancel(trxRef) {
        return await storageRepo.cancel(trxRef);
      },
    } as ITransactor;
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
    if (!uri) {
      throw new Error('Collection URI is required');
    }
    // Parse URIs like 'tree://mydb/users' or just 'users'
    if (uri.startsWith('tree://')) {
      const path = uri.substring(7); // Remove 'tree://'
      const parts = path.split('/');
      if (parts.length >= 2) {
        return parts[1]! as unknown as CollectionId; // collection name part
      }
      return path as unknown as CollectionId;
    }
    return uri as unknown as CollectionId;
  }

  /**
   * Extract key from entry
   * Entry format: [primaryKey, encodedRow]
   */
  private extractKeyFromEntry(entry: RowData): string {
    return entry[0];
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
   * Get the peer ID from the current libp2p node (if available)
   */
  getPeerId(options: ParsedOptimysticOptions): string | undefined {
    const nodeKey = this.getNodeKey(options);
    const nodeInfo = this.libp2pNodes.get(nodeKey);
    return nodeInfo?.node.peerId.toString();
  }

  /**
   * Register an existing libp2p node for use by the factory.
   * This allows tests to inject pre-created nodes instead of having the factory create new ones.
   */
  registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo: IRepo): void {
    const nodeKey = `${networkName}:0`; // Use port 0 as default for registered nodes
    this.libp2pNodes.set(nodeKey, { node, coordinatedRepo });
  }

  /**
   * Register an existing transactor for use by the factory.
   * This allows tests to inject pre-created transactors.
   */
  registerTransactor(key: string, transactor: ITransactor): void {
    this.transactors.set(key, transactor);
  }

  /**
   * Generate a unique key for libp2p node caching
   */
  private getNodeKey(options: ParsedOptimysticOptions): string {
    const networkName = options.libp2pOptions?.networkName ?? 'optimystic';
    const port = options.libp2pOptions?.port ?? 0;
    return `${networkName}:${port}`;
  }

  /**
   * Clear all cached transactors (useful for testing or cleanup)
   * Note: Collections are only cached within transactions, not globally
   */
  clearCache(): void {
    this.transactors.clear();
  }

  /**
   * Shutdown all libp2p nodes
   */
  async shutdown(): Promise<void> {
    for (const [key, { node }] of this.libp2pNodes.entries()) {
      console.log(`Stopping libp2p node: ${key}`);
      await node.stop();
    }
    this.libp2pNodes.clear();
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
