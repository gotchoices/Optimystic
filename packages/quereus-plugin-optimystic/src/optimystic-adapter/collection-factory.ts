import type { ITransactor, IKeyNetwork, CollectionId, PeerId, IRepo, IBlockChangeNotifier, CollectionChangeListener, TransactionSigner } from '@optimystic/db-core';
import { Tree, NetworkTransactor, isBlockChangeNotifier, bytesToB64url } from '@optimystic/db-core';
import { randomBytes } from '@noble/hashes/utils.js';
import {
	createLibp2pNode,
	DEFAULT_CLUSTER_SIZE,
	Libp2pKeyPeerNetwork,
	RepoClient,
	StorageRepo,
	BlockStorage,
	MemoryRawStorage,
	type CachedRawStorage,
	withReadCache,
	signPeer,
	type OptimysticNodeAttachments,
} from '@optimystic/db-p2p';
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
import type { RowData, ParsedOptimysticOptions, TransactionState } from '../types.js';
import type { Libp2p } from '@libp2p/interface';
import { createLogger } from '../logger.js';

const log = createLogger('collection-factory');

/**
 * A libp2p node this factory holds. Nodes it builds itself (`createLibp2pNode`) carry the full
 * {@link OptimysticNodeAttachments} surface; nodes a host injects through `registerLibp2pNode`
 * may carry none of it — hence `Partial`, so every read of an attachment has to face the
 * possibility that this particular node does not have one.
 */
type FactoryNode = Libp2p & Partial<OptimysticNodeAttachments>;

/**
 * A short, whitespace-free identifier for one node, used only to label trace lines.
 * Four random bytes rendered base64url — six characters, enough that two nodes in one
 * mesh do not collide by accident, short enough to sit on every line without crowding it.
 *
 * Drawn from `@noble/hashes` like every other random draw in this repo, rather than
 * `globalThis.crypto`, so the module keeps loading everywhere the package claims to run
 * (React Native has no global WebCrypto without a polyfill).
 */
function randomNodeTag(): string {
  return bytesToB64url(randomBytes(4));
}

/**
 * Factory for creating and managing tree collections
 */
export class CollectionFactory {
  /**
   * This node's tag, printed as `node=` on every cross-node trace line
   * (`commit:collections`, `index:tree-open`, `index:seek`). See {@link nodeTag}.
   */
  private nodeTagValue = randomNodeTag();
  private transactors = new Map<string, ITransactor>();
  private libp2pNodes = new Map<string, { node: FactoryNode; coordinatedRepo: IRepo; blockChangeNotifier?: IBlockChangeNotifier }>();
  private customTransactorCtors = new Map<string, new (...args: any[]) => ITransactor>();
  private customKeyNetworkCtors = new Map<string, new (...args: any[]) => IKeyNetwork>();
  /**
   * Raw-storage read caches this factory put in front of host-supplied storage (one per `local`
   * transactor over a non-memory backend — see {@link withReadCache}). Tracked only so
   * {@link dispose} can release their shared-pool registrations.
   */
  private readCaches: CachedRawStorage[] = [];

  /**
   * Create or get a tree collection, bringing it into existence when nothing has ever
   * been committed under its id.
   * Collections are only cached within a transaction to ensure proper isolation
   */
  async createOrGetCollection(
    options: ParsedOptimysticOptions,
    txnState?: TransactionState
  ): Promise<Tree<string, RowData>> {
    const cached = this.getCachedCollection(options, txnState);
    if (cached) {
      return cached;
    }

    const { transactor, collectionId, keyExtractor, compare } = await this.resolveTreeArgs(options);
    const collection = await Tree.createOrOpen<string, RowData>(
      transactor,
      collectionId,
      keyExtractor,
      compare // Total order
    );

    this.cacheCollection(options, txnState, collection);
    return collection;
  }

  /**
   * Get an EXISTING tree collection, or `undefined` when no header block has ever been
   * committed under its id. The read-only counterpart to {@link createOrGetCollection}:
   * use it wherever an absent collection must read as absent rather than as empty.
   *
   * A miss is deliberately NOT cached — the same transaction may create the collection
   * a moment later, and a negative cache entry would keep it invisible for the rest of
   * the transaction.
   */
  async getCollection(
    options: ParsedOptimysticOptions,
    txnState?: TransactionState
  ): Promise<Tree<string, RowData> | undefined> {
    const cached = this.getCachedCollection(options, txnState);
    if (cached) {
      return cached;
    }

    const { transactor, collectionId, keyExtractor, compare } = await this.resolveTreeArgs(options);
    const collection = await Tree.open<string, RowData>(
      transactor,
      collectionId,
      keyExtractor,
      compare // Total order
    );
    if (!collection) {
      return undefined;
    }

    this.cacheCollection(options, txnState, collection);
    return collection;
  }

  /** The transactor + Tree construction arguments an open path needs, resolved from options. */
  private async resolveTreeArgs(options: ParsedOptimysticOptions): Promise<{
    transactor: ITransactor;
    collectionId: CollectionId;
    keyExtractor: (entry: RowData) => string;
    compare: (a: string, b: string) => -1 | 0 | 1;
  }> {
    const transactor = await this.getOrCreateTransactor(options);
    const collectionId = this.parseCollectionId(options.collectionUri);

    const compare = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

    // Both tree flavours key on the first tuple element: data trees hold
    // `[primaryKey, encodedRow]`, the schema catalog holds `[tableName, StoredTableSchema]`
    // (whose second element is an object, not a string — it rides through as RowData).
    const keyExtractor = (entry: RowData) => this.extractKeyFromEntry(entry);

    return { transactor, collectionId, keyExtractor, compare };
  }

  /** Transaction-scoped cache lookup; collections are never cached beyond a transaction
   *  so two transactions can never share a tracker. */
  private getCachedCollection(
    options: ParsedOptimysticOptions,
    txnState?: TransactionState
  ): Tree<string, RowData> | undefined {
    const collectionKey = this.getCollectionKey(options);
    return txnState?.isActive ? txnState.collections.get(collectionKey) : undefined;
  }

  private cacheCollection(
    options: ParsedOptimysticOptions,
    txnState: TransactionState | undefined,
    collection: Tree<string, RowData>
  ): void {
    if (txnState?.isActive) {
      txnState.collections.set(this.getCollectionKey(options), collection);
    }
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

      // The coordinatedRepo the node built. Typed on the node's attachment surface, so
      // no presence check: createLibp2pNode always attaches it.
      const coordinatedRepo = node.coordinatedRepo;

      // The hosting node exposes its StorageRepo as an IBlockChangeNotifier
      // (libp2p-node-base sets `node.blockChangeNotifier = storageRepo`). Feed it
      // to the transactor so reactive consumers can observe commits that land on
      // this node's storage.
      const blockChangeNotifier = node.blockChangeNotifier;

      nodeInfo = { node, coordinatedRepo, blockChangeNotifier };
      this.libp2pNodes.set(nodeKey, nodeInfo);
    }

    const { node, coordinatedRepo, blockChangeNotifier } = nodeInfo;

    const protocolPrefix = `/optimystic/${options.libp2pOptions?.networkName ?? 'optimystic'}`;
    const keyNetwork = this.resolveKeyNetwork(options.keyNetwork, node, protocolPrefix);

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
   *
   * A host-supplied backend is wrapped in the write-through read cache here — the one
   * composition seam for the local transactor. Without it `BlockStorage` re-reads block
   * metadata on essentially every operation, which over a filesystem backend is hundreds
   * of reads of the same tiny files per statement. The factory is called once per transactor
   * (and this factory is built fresh per plugin `register`), so the cache is owned by this
   * transactor alone and a re-opened `Database` starts cold — coherent by construction.
   * `MemoryRawStorage` passes through unwrapped (nothing to save).
   */
  private async createLocalTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    const { storage: rawStorage, ownedCache } = withReadCache(
      options.rawStorageFactory?.() ?? new MemoryRawStorage(), 'quereus:local');
    // Only a cache THIS call constructed is ours to release. A host that hands the same
    // pre-built `CachedRawStorage` to several `register()` calls (the documented way to share
    // one store across in-process consumers) gets it back unchanged and keeps owning it.
    if (ownedCache) {
      this.readCaches.push(ownedCache);
    }
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
  private resolveKeyNetwork(type: string, libp2pNode: FactoryNode, protocolPrefix: string): Libp2pKeyPeerNetwork {
    switch (type) {
      case 'libp2p': {
        // Prefer the node's OWN key network. `createLibp2pNode` builds one with the
        // node's configured cluster size, network mode, persistence, reputation and
        // protocol prefix, and attaches it there; constructing a second one from
        // defaults would silently give every transactor-level findCluster /
        // findCoordinator a different-width cohort with network scoping disabled — a
        // different peer set and coordinator than the node's own consensus path uses.
        const attached = libp2pNode.keyNetwork;
        if (attached) {
          return attached;
        }
        // A node injected by a host that did not build it through createLibp2pNode
        // carries no key network. Reputation is unknowable here and the cluster size is
        // only guessable — DEFAULT_CLUSTER_SIZE is what a db-p2p node that declares no
        // clusterSize resolves to, so it is the least-surprising stand-in for a node whose
        // config we cannot see. It is deliberately NOT `1`, the width this factory gives the
        // nodes it builds itself above: that value is chosen for a single-node edge profile
        // and asserting it of someone else's node would be a guess dressed as knowledge.
        // The network name IS known, though, so scope selection to this network's peers.
        // Passing the prefix is deliberate
        // even though the constructor leaves it optional "because most call sites don't
        // know the network name": this call site does, and the SAME prefix string is what
        // `getRepo` hands every `RepoClient.create` dial the transactor makes — a peer
        // that scoping excludes could never have negotiated this transactor's repo
        // protocol anyway, so scoping only removes guaranteed-failure candidates.
        //
        // NOTE: a host injecting a node through `registerLibp2pNode` should be able to hand
        // in its key network rather than have one guessed from defaults here. If a real host
        // ever needs a cluster size other than the default, widen `registerLibp2pNode` to take
        // the node's own key network (or its cluster size) rather than growing more guesses.
        return new Libp2pKeyPeerNetwork(libp2pNode, DEFAULT_CLUSTER_SIZE, undefined, undefined, undefined, undefined, protocolPrefix);
      }
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
    // The node's identity key is attached by createLibp2pNode (see OptimysticNodeAttachments).
    // Absent for injected/legacy nodes and all non-network transactors, in which case there is no
    // client signer and the transaction is left unsigned.
    // NOTE: a node injected via registerLibp2pNode that was NOT built by createLibp2pNode carries no
    // peerPrivateKey, so signing silently disables for it; harmless today (enforcement is off by
    // default) but if a deployment enforces verification against such a node, thread the key through.
    const privateKey = nodeInfo?.node.peerPrivateKey;
    if (!privateKey) {
      return undefined;
    }
    return async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(privateKey, payload));
  }

  /**
   * Register an existing libp2p node for use by the factory.
   * This allows tests to inject pre-created nodes instead of having the factory create new ones.
   */
  registerLibp2pNode(networkName: string, node: FactoryNode, coordinatedRepo: IRepo): void {
    const nodeKey = `${networkName}:0`; // Use port 0 as default for registered nodes
    this.libp2pNodes.set(nodeKey, { node, coordinatedRepo });
  }

  /**
   * This node's identity for diagnostics, printed as the `node=` field on
   * `commit:collections`, `index:tree-open` and `index:seek`.
   *
   * ONE factory means ONE node. The plugin's `register()` builds exactly one
   * `CollectionFactory` per registration, a registration happens once per Quereus
   * `Database`, and a `Database` is one machine's SQL surface — so the factory instance
   * is the finest identity these three lines can be attributed to, and the only one both
   * emitting sites (the virtual table and the transaction bridge) already hold.
   *
   * Without it, two nodes writing the same collection at the same instant emit
   * byte-identical lines and an operator can only attribute them positionally (by knowing
   * which machine their harness polled first), which is not possible at all for the
   * write-side line.
   *
   * Defaults to six random characters. A host that has better names for its machines —
   * an integration harness with `A`/`B`, a deployment with libp2p peer ids — should call
   * {@link setNodeTag} once at start-up so its logs read in its own vocabulary.
   */
  nodeTag(): string {
    return this.nodeTagValue;
  }

  /**
   * Name this node for diagnostics; see {@link nodeTag}.
   *
   * Rejects anything that is not a single non-empty run of non-whitespace characters:
   * the tag is printed as one whitespace-separated `node=<tag>` field, so a tag with a
   * space in it would split one trace field into two and make every line carrying it
   * unparseable. Failing here — at the one call a host makes at start-up — is far
   * cheaper than discovering it in the log of the run that needed the log.
   *
   * A field rather than a namespace suffix (which is how `db-p2p` tells its nodes apart):
   * all three lines share one `debug` namespace here, so splitting the namespace per node
   * would force an operator to know the node tags BEFORE choosing a `DEBUG=` filter. A
   * field keeps one filter and stays greppable (`grep 'node=A'`).
   */
  setNodeTag(tag: string): void {
    if (!/^\S+$/.test(tag)) {
      throw new Error(`Node tag must be a single non-empty run of non-whitespace characters; got ${JSON.stringify(tag)}`);
    }
    this.nodeTagValue = tag;
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
   * Release the raw-storage read caches this factory created — their registrations with the
   * process-wide `SharedCachePool` (see `withReadCache` in `@optimystic/db-p2p`) — and forget
   * the transactors built over them.
   *
   * Explicit because nothing else reaches this factory when the hosting `Database` closes: the
   * vtab module's `disconnect` is per-statement and its `destroy` is DROP TABLE. Call it after
   * `db.close()`. A host that skips it leaks one dead pool store handle per factory, whose
   * entries stay charged against the shared budget until the pool evicts them as cold —
   * hygiene, not correctness (the pool always evicts, never refuses).
   *
   * Safe to call more than once. A transactor requested afterwards is rebuilt from scratch
   * (the storage factory is invoked again and gets a fresh, cold cache), so a stray statement
   * after dispose is coherent — just uncached until then. Does NOT stop libp2p nodes; that is
   * {@link shutdown}, which calls this as its last step.
   */
  async dispose(): Promise<void> {
    const caches = this.readCaches;
    this.readCaches = [];
    this.transactors.clear();
    for (const cache of caches) {
      await cache.dispose();
    }
  }

  /**
   * Shutdown all libp2p nodes, then release the read caches ({@link dispose}).
   */
  async shutdown(): Promise<void> {
    for (const [key, { node }] of this.libp2pNodes.entries()) {
      log('Stopping libp2p node: %s', key);
      await node.stop();
    }
    this.libp2pNodes.clear();
    await this.dispose();
  }
}
