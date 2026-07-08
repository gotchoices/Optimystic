import type { ITransactor, IKeyNetwork, CollectionId, PeerId, IRepo, IBlockChangeNotifier, CollectionChangeListener, TransactionSigner } from '@optimystic/db-core';
import { Tree, NetworkTransactor, isBlockChangeNotifier, bytesToB64url } from '@optimystic/db-core';
import {
	createLibp2pNode,
	Libp2pKeyPeerNetwork,
	RepoClient,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
	signPeer,
} from '@optimystic/db-p2p';
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
import type { RowData, ParsedOptimysticOptions, TransactionState } from '../types.js';
import type { Libp2p, PrivateKey } from '@libp2p/interface';
import { createLogger } from '../logger.js';

const log = createLogger('collection-factory');

/**
 * Factory for creating and managing tree collections
 */
export class CollectionFactory {
  private transactors = new Map<string, ITransactor>();
  private libp2pNodes = new Map<string, { node: Libp2p; coordinatedRepo: IRepo; blockChangeNotifier?: IBlockChangeNotifier }>();
  private customTransactorCtors = new Map<string, new (...args: any[]) => ITransactor>();
  private customKeyNetworkCtors = new Map<string, new (...args: any[]) => IKeyNetwork>();

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
        return await this.createLocalTransactor(options);

      case 'test':
        return await this.createTestTransactor();

      case 'mesh-test':
        return await this.createMeshTestTransactor();

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
   * Subscribe to per-collection change notifications for `collectionId` on the
   * transactor resolved from `options`, keeping the network-vs-local resolution
   * inside the factory (where transactor construction already lives).
   *
   * Feature-detects {@link IBlockChangeNotifier}: a transactor that doesn't
   * implement it (e.g. a custom transactor, or an injected test mock) yields a
   * logged no-op with an inert unsubscribe. The `network` and `mesh-test`
   * transactors DO implement it (via {@link NetworkTransactor}) but no-op
   * internally when they have no co-located `localChangeNotifier` — so reactive
   * watching degrades gracefully to the consumer's existing fetch/poll behaviour
   * either way.
   *
   * Returns a promise for the (idempotent) unsubscribe handle.
   */
  async subscribeToCollectionChanges(
    options: ParsedOptimysticOptions,
    collectionId: CollectionId,
    listener: CollectionChangeListener
  ): Promise<() => void> {
    const transactor = await this.getOrCreateTransactor(options);
    if (!isBlockChangeNotifier(transactor)) {
      log(
        `[optimystic] transactor '${options.transactor}' does not support change notifications; ` +
        `reactive watch is a no-op for collection '${collectionId}'`
      );
      return () => { };
    }
    return transactor.onCollectionChange(collectionId, listener);
  }

  /**
   * Create a network transactor
   */
  private async createNetworkTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    // Create or get libp2p node
    const nodeKey = this.getNodeKey(options);
    let nodeInfo = this.libp2pNodes.get(nodeKey);

    if (!nodeInfo) {
      const node = await createLibp2pNode({
        port: options.libp2pOptions?.port ?? 0,
        networkName: options.libp2pOptions?.networkName ?? 'optimystic',
        bootstrapNodes: options.libp2pOptions?.bootstrapNodes ?? [],
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

      // The hosting node exposes its StorageRepo as an IBlockChangeNotifier
      // (libp2p-node-base sets `node.blockChangeNotifier = storageRepo`). Feed it
      // to the transactor so reactive consumers can observe commits that land on
      // this node's storage. Absent on nodes that don't host collection blocks.
      const blockChangeNotifier = (node as any).blockChangeNotifier as IBlockChangeNotifier | undefined;

      nodeInfo = { node, coordinatedRepo, blockChangeNotifier };
      this.libp2pNodes.set(nodeKey, nodeInfo);
    }

    const { node, coordinatedRepo, blockChangeNotifier } = nodeInfo;

    const keyNetwork = this.resolveKeyNetwork(options.keyNetwork, node);
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
      dialTimeoutMs: 3_000,
      keyNetwork,
      getRepo,
      localChangeNotifier: blockChangeNotifier,
    });
  }

  /**
   * Create a local transactor (single-node, no network).
   * Uses `options.rawStorageFactory` when supplied so hosts can plug in a
   * persistent backend; otherwise falls back to in-memory `MemoryRawStorage`.
   */
  private async createLocalTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    const rawStorage = options.rawStorageFactory?.() ?? new MemoryRawStorage();
    const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));

    // LocalTransactor implementation (simple wrapper around StorageRepo).
    // Also implements IBlockChangeNotifier by delegating to the StorageRepo —
    // the same instance that emits commit notifications — so single-process,
    // multi-collection scenarios are reactive without libp2p.
    const transactor: ITransactor & IBlockChangeNotifier = {
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
      onCollectionChange: storageRepo.onCollectionChange.bind(storageRepo),
    };
    return transactor;
  }

  /**
   * Create a test transactor (in-memory, single-node)
   */
  private async createTestTransactor(): Promise<ITransactor> {
    const memoryStorage = new MemoryRawStorage();

    const storageRepo = new StorageRepo((blockId) => new BlockStorage(blockId, memoryStorage));

    // Simple local transactor that wraps StorageRepo; also an IBlockChangeNotifier
    // (delegating to the StorageRepo) so plugin-level reactive-watch specs can
    // observe commit notifications without libp2p.
    const transactor: ITransactor & IBlockChangeNotifier = {
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
      onCollectionChange: storageRepo.onCollectionChange.bind(storageRepo),
    };
    return transactor;
  }

  /**
   * Create a mesh-test transactor: real production stack (StorageRepo +
   * CoordinatorRepo + NetworkTransactor) over a 1-node mock mesh. Used by
   * plugin-level specs that want to exercise the full transactor→repo
   * contract without spinning up real libp2p.
   *
   * NOTE: change notifications are NOT wired for `mesh-test`. `buildNetworkTransactor`
   * does not pass a `localChangeNotifier`, so the resulting `NetworkTransactor`
   * feature-detects as a notifier but its `onCollectionChange` is an inert no-op
   * (reactive watch silently degrades to fetch/poll). Wiring it would mean
   * threading the mesh's per-node StorageRepo through the testing harness; left
   * unsupported pending a demonstrated need.
   */
  private async createMeshTestTransactor(): Promise<ITransactor> {
    const mesh = await createMesh(1, {
      responsibilityK: 1,
      clusterSize: 1,
      superMajorityThreshold: 0.51,
    });
    return buildNetworkTransactor(mesh);
  }

  /**
   * Create a custom transactor
   */
  private async createCustomTransactor(name: string): Promise<ITransactor> {
    const CustomTransactor = this.customTransactorCtors.get(name);
    if (!CustomTransactor) {
      throw new Error(
        `Custom transactor '${name}' not found. Register it first using collectionFactory.registerCustomTransactor().`
      );
    }

    return new CustomTransactor();
  }

  /**
   * Resolve a key network by type, using built-in or custom implementations.
   * Returns Libp2pKeyPeerNetwork (which implements both IKeyNetwork and IPeerNetwork)
   * for the built-in 'libp2p' type. Custom implementations must also satisfy both interfaces.
   */
  private resolveKeyNetwork(type: string, libp2pNode: Libp2p): Libp2pKeyPeerNetwork {
    switch (type) {
      case 'libp2p':
        return new Libp2pKeyPeerNetwork(libp2pNode);
      default: {
        const CustomKeyNetwork = this.customKeyNetworkCtors.get(type);
        if (!CustomKeyNetwork) {
          throw new Error(
            `Custom key network '${type}' not found. Register it first using collectionFactory.registerCustomKeyNetwork().`
          );
        }
        return new CustomKeyNetwork() as unknown as Libp2pKeyPeerNetwork;
      }
    }
  }

  /**
   * Parse collection URI to extract collection ID
   */
  private parseCollectionId(uri: string): CollectionId {
    if (!uri) {
      throw new Error('Collection URI is required');
    }
    // Parse URIs like 'tree://mydb/users' or just 'users'
    // Use the full path as the collection ID to ensure uniqueness
    // (e.g., index trees at tree://test/products/index/idx_name must not
    //  collide with the main table at tree://test/products)
    if (uri.startsWith('tree://')) {
      const path = uri.substring(7); // Remove 'tree://'
      return path as unknown as CollectionId;
    }
    return uri as unknown as CollectionId;
  }

  /**
   * Canonical collection id for an options set. This is the same id used as the
   * collection's header block id and stamped on every block's
   * `header.collectionId` (see {@link TransactorSource.createBlockHeader}), so it
   * is exactly the {@link CollectionChangeEvent.collectionId} value emitted when
   * the collection's blocks commit. Use this for both subscription matching and
   * for asserting against emitted events.
   */
  getCollectionId(options: ParsedOptimysticOptions): CollectionId {
    return this.parseCollectionId(options.collectionUri);
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
   * A {@link TransactionSigner} bound to the current libp2p node's Ed25519 identity key, or
   * `undefined` when no node/key is available (legacy `local`/`test`/`mesh-test` transactors, or a
   * node created without an exposed key). The session is then built unsigned — unchanged behavior.
   *
   * The returned closure mirrors the reactivity / matchmaking node-signer pattern in
   * `libp2p-node-base.ts`: `signPeer` (async libp2p `PrivateKey.sign`) over the canonical
   * client-signature payload, base64url-encoded via the same {@link bytesToB64url} helper the verify
   * side decodes with. A verifying node with `requireClientSignature` on derives the client's public
   * key straight from `stamp.peerId` (which is this node's peer-id string), so no key is distributed.
   *
   * Signing is always safe to inject: it only adds a `signature` field, which nodes that do not enforce
   * verification ignore. Enforcement (rejecting unsigned/invalid) is the verifier side's decision.
   */
  getSigner(options: ParsedOptimysticOptions): TransactionSigner | undefined {
    const nodeKey = this.getNodeKey(options);
    const nodeInfo = this.libp2pNodes.get(nodeKey);
    // The node's identity key is attached by createLibp2pNode (see libp2p-node-base.ts —
    // `(node as any).peerPrivateKey`). Absent for injected/legacy nodes and all non-network
    // transactors, in which case there is no client signer and the transaction is left unsigned.
    // NOTE: a node injected via registerLibp2pNode that was NOT built by createLibp2pNode carries no
    // peerPrivateKey, so signing silently disables for it; harmless today (enforcement is off by
    // default) but if a deployment enforces verification against such a node, thread the key through.
    const privateKey = (nodeInfo?.node as unknown as { peerPrivateKey?: PrivateKey } | undefined)?.peerPrivateKey;
    if (!privateKey) {
      return undefined;
    }
    return async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(privateKey, payload));
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
   * Register a custom transactor class by name.
   * When `options.transactor` matches `name`, the factory will instantiate this class.
   */
  registerCustomTransactor(name: string, ctor: new (...args: any[]) => ITransactor): void {
    this.customTransactorCtors.set(name, ctor);
  }

  /**
   * Register a custom key network class by name.
   * When `options.keyNetwork` matches `name`, the factory will instantiate this class.
   */
  registerCustomKeyNetwork(name: string, ctor: new (...args: any[]) => IKeyNetwork): void {
    this.customKeyNetworkCtors.set(name, ctor);
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
      log('Stopping libp2p node: %s', key);
      await node.stop();
    }
    this.libp2pNodes.clear();
  }
}
