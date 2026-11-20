import type { ITransactor, IKeyNetwork, CollectionId, IRepo, IBlockChangeNotifier, IBlockDurabilityNotifier, CollectionChangeListener, TransactionSigner, TreeCollectionOptions, ICohortReachability, BlobService } from '@optimystic/db-core';
import { Tree, NetworkTransactor, isBlockChangeNotifier, isBlockDurabilityNotifier, bytesToB64url } from '@optimystic/db-core';
import { randomBytes } from '@noble/hashes/utils.js';
import {
	createLibp2pNode,
	createNodeNetworkTransactor,
	DEFAULT_CLUSTER_SIZE,
	Libp2pKeyPeerNetwork,
	StorageRepo,
	MemoryRawStorage,
	MemoryKVStore,
	MemoryPieceStore,
	SingleMachineBlobService,
	type BlobPinIndex,
	type ReadCacheLease,
	withReadCache,
	signPeer,
	type OptimysticClientNodeAttachments,
	type OptimysticNodeAttachments,
	type CollectionWatchHandle,
	type CollectionTailReader,
	committedTailReader,
} from '@optimystic/db-p2p';
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
import type { RowData, ParsedOptimysticOptions, TransactionState } from '../types.js';
import type { Libp2p } from '@libp2p/interface';
import { createLogger } from '../logger.js';
import { addListener } from './listeners.js';
import { BlobScopeRegistration } from './blob-scope-registration.js';
import type { NetworkBinding } from './blob-scope-registration.js';
import { LateBoundCohortReachability } from './late-bound-reachability.js';
import { compareTreeKeys } from '../schema/key-encoding.js';

const log = createLogger('collection-factory');
/** One line per blob backend this factory resolves (docs/debugging.md §quereus-plugin sub-namespaces). */
const blobLog = createLogger('blob');

/**
 * A blob service that also lets its pins be read back by owner label — which is how a host
 * inspects what the plugin holds, and how the plugin's own later parts find their pins again after a
 * restart. Both services the SQL layer can sit on carry it (`NodeBlobService` and
 * `SingleMachineBlobService` in `packages/db-p2p/src/blob/`).
 */
export type SqlBlobBackendService = BlobService & BlobPinIndex;

/**
 * One network's blob store, as the SQL layer needs it: the network binding — the transactor key
 * and its transactor, through which this network's reference trees and scope registry are read and
 * written — plus the blob service over it.
 */
export interface BlobBackend extends NetworkBinding {
	readonly service: SqlBlobBackendService;
}

/**
 * A libp2p node this factory holds. Nodes it builds itself (`createLibp2pNode`) carry the full
 * {@link OptimysticNodeAttachments} surface. A host injects nodes through `registerLibp2pNode`: a
 * client node (`servesBlocks: false`, {@link OptimysticClientNodeAttachments}), which carries no repo,
 * store or change notifier, or a node carrying none of the surface — hence every attachment optional,
 * so every read of one has to face the possibility that this particular node does not have it.
 */
type FactoryNode = Libp2p & Partial<Omit<OptimysticNodeAttachments, 'servesBlocks'>> & { servesBlocks?: boolean };

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
  /**
   * Transactor constructions still in flight, by the key {@link transactors} will hold them under.
   * A table's first initialization opens its collection and reads the catalog together, and both
   * resolve the same transactor: without this, each would miss {@link transactors} and build its
   * own — two libp2p nodes, or two `local` stores neither of which sees the other's writes.
   */
  // NOTE: dispose()/clearCache() do not touch this map, so a construction in flight across them
  // still lands in `transactors` afterwards (as the old await-then-set did). If a host ever
  // disposes while a table is mid-initialization, drop in-flight results that settle after dispose.
  private transactorsInFlight = new Map<string, Promise<ITransactor>>();
  /** `coordinatedRepo` is absent exactly for a node that coordinates nothing: a client (`servesBlocks: false`). */
  private libp2pNodes = new Map<string, { node: FactoryNode; coordinatedRepo?: IRepo; blockChangeNotifier?: IBlockChangeNotifier }>();
  private customTransactorCtors = new Map<string, new (...args: any[]) => ITransactor>();
  private customKeyNetworkCtors = new Map<string, new (...args: any[]) => IKeyNetwork>();
  /**
   * This factory's leases on the raw-storage read caches in front of host-supplied storage (one
   * per `local` transactor over a non-memory backend — see {@link withReadCache}). The cache
   * behind a lease is shared with every other consumer of the same backing store in this
   * process, so these are claims, not owned objects. Tracked only so {@link dispose} can
   * release them.
   */
  private readCacheLeases: ReadCacheLease[] = [];
  /**
   * The network watches this factory opened ({@link watchCollectionOverNetwork}) and nobody has
   * closed yet. Tracked so {@link dispose} can close them: a host that closes its `Database` and
   * disposes the plugin without dropping its tables would otherwise leave each watch renewing its
   * cohort registration until the node stops.
   */
  private networkWatches = new Set<CollectionWatchHandle>();
  /**
   * One tail reader per transactor, handed to every network watch through it: the watch service reads
   * the tails of every collection that shares a reader in one call per tick, so sharing is what makes an
   * idle tick one request however many tables are watched.
   */
  private tailReaders = new WeakMap<ITransactor, CollectionTailReader>();
  /**
   * The sealed-segment refusal callback every tree this factory opens is built with
   * ({@link setSealedRefusedListener}): the offline queue's, so a replay that refuses a queued
   * entry's segment reaches the queue whichever of this `Database`'s collections reported it.
   * `Collection.onSealedRefused` is fixed at construction and the collections open before any
   * `plugin.offline.enter()`, which is why the listener is set once, at registration, rather than
   * per tree.
   */
  private sealedRefusedListener: TreeCollectionOptions['onSealedRefused'];
  /**
   * Told when a tree this factory opens adopts commits it did not write, with the tree's collection
   * id ({@link setExternalCommitsListener}): the materialized-view follower's, set once at registration
   * for the reason {@link sealedRefusedListener} is.
   */
  private externalCommitsListener: ((collectionId: CollectionId, rev: number) => void) | undefined;
  /**
   * The one stable gate per transactor key that {@link getCohortReachability} hands out, standing in
   * for the gate registered for the key ({@link registerCohortReachability}) and for the always-open
   * gate until one is.
   */
  private cohortGates = new Map<string, LateBoundCohortReachability>();
  /** One blob backend per transactor key, by that key ({@link getBlobBackend}). */
  private blobBackends = new Map<string, BlobBackend>();
  /**
   * Blob-backend resolutions still in flight, by the key {@link blobBackends} will hold them under
   * — for the reason {@link transactorsInFlight} exists: two tables on one network resolving at
   * once must share one store of pieces, records and pins. A resolution that fails is not
   * remembered, so the next caller tries again.
   */
  // NOTE: as for {@link transactorsInFlight}, dispose() does not touch this map, so a resolution in
  // flight across a dispose still lands in `blobBackends` and its service escapes the set dispose
  // stopped. Same remedy if hosts ever dispose mid-initialization: drop results that settle after.
  private blobBackendsInFlight = new Map<string, Promise<BlobBackend>>();
  /** The single-machine services this factory BUILT, so {@link dispose} can stop them. A `network`
   * backend's service belongs to its node and is stopped by {@link shutdown}. */
  private singleMachineBlobServices = new Set<SingleMachineBlobService>();
  /** Told once per backend, the first time it resolves ({@link onBlobBackendResolved}). */
  private blobBackendListeners = new Set<(backend: BlobBackend) => void>();
  /**
   * This factory's blob-scope registrations, keyed by (transactor key, scope) — which reference
   * trees it has confirmed in which network's scope registry (docs/blobs.md §Registering
   * references). Public because the DDL paths that write the registry are on the module, not here,
   * and they reach it through {@link networkBinding} rather than {@link getBlobBackend}: a registry
   * entry is written through the network's transactor alone, so a statement that writes one has no
   * reason to resolve (and then remember) that network's piece store and blob records. It is NOT a
   * saving on building the libp2p node — `networkBinding` resolves the transactor, which for
   * `network` is what builds or reuses the node, exactly as the backend path does.
   */
  readonly blobScopes = new BlobScopeRegistration();

  /**
   * Set the refusal callback every tree opened from now on carries (see {@link sealedRefusedListener}).
   * Once: a second controller would silently take the first's refusals.
   */
  setSealedRefusedListener(listener: NonNullable<TreeCollectionOptions['onSealedRefused']>): void {
    if (this.sealedRefusedListener !== undefined) throw new Error('a sealed-segment refusal listener is already set on this factory');
    this.sealedRefusedListener = listener;
  }

  /**
   * Set the listener every tree opened from now on reports adopted commits to
   * (`TreeCollectionOptions.onExternalCommits`, bound to the tree's collection id). Once, as
   * {@link setSealedRefusedListener}. The listener runs inside the collection's await-free adopt step,
   * under its latch, so it must only record.
   */
  setExternalCommitsListener(listener: (collectionId: CollectionId, rev: number) => void): void {
    if (this.externalCommitsListener !== undefined) throw new Error('an external-commits listener is already set on this factory');
    this.externalCommitsListener = listener;
  }

  /** The collection options both open paths pass to `Tree`: the refusal callback and the adopted-commits
   * callback, each when one is set. Never a merge declaration: the table classifies per statement and
   * passes the lane on each write. */
  private treeOptions(collectionId: CollectionId): Pick<TreeCollectionOptions, 'onSealedRefused' | 'onExternalCommits'> | undefined {
    const external = this.externalCommitsListener;
    if (this.sealedRefusedListener === undefined && external === undefined) return undefined;
    return {
      onSealedRefused: this.sealedRefusedListener,
      onExternalCommits: external === undefined ? undefined : rev => external(collectionId, rev),
    };
  }

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
      compare, // Total order
      undefined,
      this.treeOptions(collectionId)
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
      compare, // Total order
      undefined,
      this.treeOptions(collectionId)
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

    // Both tree flavours key on the first tuple element: data trees hold
    // `[primaryKey, encodedRow]`, the schema catalog holds `[catalogKey, PersistedTableSchema]`
    // (whose second element is an object, not a string — it rides through as RowData).
    const keyExtractor = (entry: RowData) => this.extractKeyFromEntry(entry);

    return { transactor, collectionId, keyExtractor, compare: compareTreeKeys };
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
   * Get or create a transactor (with caching). Concurrent callers for one key share a single
   * construction ({@link transactorsInFlight}); a construction that fails is not remembered, so
   * the next caller tries again.
   */
  async getOrCreateTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    const transactorKey = this.getTransactorKey(options);

    if (this.transactors.has(transactorKey)) {
      return this.transactors.get(transactorKey)!;
    }

    let inFlight = this.transactorsInFlight.get(transactorKey);
    if (!inFlight) {
      inFlight = this.createTransactor(options)
        .then(transactor => {
          this.transactors.set(transactorKey, transactor);
          return transactor;
        })
        .finally(() => this.transactorsInFlight.delete(transactorKey));
      this.transactorsInFlight.set(transactorKey, inFlight);
    }
    return await inFlight;
  }

  /**
   * The blob store of the network `options` binds to (docs/blobs.md §SQL), created on first use and
   * then shared by every table and every `SqlBlobService` on that transactor key — so one network
   * means one set of pieces, one set of blob records and one set of pins.
   *
   * Where the blobs live:
   *
   *  - **`network`**: the node's own service, `node.blobs`, over `NodeOptions.pieceStorage` and the
   *    blob records in `NodeOptions.kvStore`. A node a host injected through
   *    {@link registerLibp2pNode} may carry none (the attachments are optional), and then this falls
   *    through to the single-machine arm.
   *  - **everything else** (`local`, `test`, `mesh-test`, a custom transactor): a
   *    `SingleMachineBlobService` over `options.blobStorageFactory`, or over memory when none is
   *    given. Its cohort is this machine alone, so a committed reference's durability stays `local`.
   *
   * Concurrent callers for one key share a single resolution ({@link blobBackendsInFlight}); a
   * resolution that fails is not remembered, so the next caller tries again. Resolution always goes
   * through {@link getOrCreateTransactor} — the backend carries that transactor, and for `network`
   * it is also what builds or reuses the node.
   */
  async getBlobBackend(options: ParsedOptimysticOptions): Promise<BlobBackend> {
    const key = this.getTransactorKey(options);
    const resolved = this.blobBackends.get(key);
    if (resolved) return resolved;

    let inFlight = this.blobBackendsInFlight.get(key);
    if (!inFlight) {
      inFlight = this.resolveBlobBackend(key, options)
        .then(backend => {
          this.blobBackends.set(key, backend);
          this.announceBlobBackend(backend);
          return backend;
        })
        .finally(() => this.blobBackendsInFlight.delete(key));
      this.blobBackendsInFlight.set(key, inFlight);
    }
    return await inFlight;
  }

  /**
   * The transactor and key of `options`'s network, with NO blob service resolved — all the scope
   * registry needs ({@link blobScopes}). Deliberately not {@link getBlobBackend}: see that field.
   */
  async networkBinding(options: ParsedOptimysticOptions): Promise<NetworkBinding> {
    return { key: this.getTransactorKey(options), transactor: await this.getOrCreateTransactor(options) };
  }

  /**
   * Be told about each blob backend once: for every backend already resolved, at once as this is
   * called, and then for each one that resolves later. Returns an idempotent unsubscribe.
   *
   * The replay of the already-resolved backends is what makes this safe to subscribe at any point:
   * a listener that reconciles each network's pins (`feat-sql-columns-hold-blob-references`) must
   * see every network, not only the ones whose first table came after it subscribed. A listener
   * that throws is logged and does not disturb the resolution reporting to it.
   */
  onBlobBackendResolved(listener: (backend: BlobBackend) => void): () => void {
    // A listener already in the set must not be replayed to a second time: the set would hold it
    // once either way, so without this check "once per backend" would break for the one host
    // mistake that is invisible from the outside — subscribing the same function twice.
    const replay = !this.blobBackendListeners.has(listener);
    const unsubscribe = addListener(this.blobBackendListeners, listener);
    if (replay) {
      for (const backend of [...this.blobBackends.values()]) {
        this.callBlobBackendListener(listener, backend);
      }
    }
    return unsubscribe;
  }

  private announceBlobBackend(backend: BlobBackend): void {
    for (const listener of [...this.blobBackendListeners]) {
      this.callBlobBackendListener(listener, backend);
    }
  }

  private callBlobBackendListener(listener: (backend: BlobBackend) => void, backend: BlobBackend): void {
    try {
      listener(backend);
    } catch (error) {
      blobLog('blob:backend-listener-threw key=%s %o', backend.key, error);
    }
  }

  private async resolveBlobBackend(key: string, options: ParsedOptimysticOptions): Promise<BlobBackend> {
    // Also what builds or reuses the node a `network` backend reads its blob service off.
    const transactor = await this.getOrCreateTransactor(options);
    const nodeInfo = options.transactor === 'network'
      ? this.libp2pNodes.get(this.getNodeKey(options))
      : undefined;
    const nodeBlobs = nodeInfo?.node.blobs;
    if (nodeBlobs !== undefined) {
      return { key, service: nodeBlobs, transactor };
    }
    // The two ways here, and an operator reading one of them wants to know which: no node at all
    // (every transactor but `network`, and a `network` transactor a host registered directly) is the
    // configuration working as intended; a node that carries no blob service is a host-injected one
    // that cannot hold blobs for its network.
    const reason = nodeInfo === undefined ? 'transactor-has-no-node' : 'node-without-blobs';
    const service = new SingleMachineBlobService(
      options.blobStorageFactory?.() ?? { pieces: new MemoryPieceStore(), kv: new MemoryKVStore() },
    );
    service.start();
    this.singleMachineBlobServices.add(service);
    blobLog('blob:backend-single-machine key=%s reason=%s', key, reason);
    return { key, service, transactor };
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
   * Wake `listener` whenever `collectionId` commits on any machine, through the node's
   * cohort-topic watch service (`node.reactivityWatch` in `@optimystic/db-p2p`) — as opposed to
   * {@link subscribeToCollectionChanges}, which hears only commits this node's own storage applies.
   *
   * Resolves `undefined` when there is no watch service to use: a transactor other than
   * `network`, one registered directly with no node behind it, or a node built without
   * `cohortTopic.enabled` (an injected node may not have been built with it). Otherwise resolves
   * the watch's close, which is idempotent. The watch itself returns at once and does its network
   * work in the background, so neither this call nor the close waits on the network.
   */
  async watchCollectionOverNetwork(
    options: ParsedOptimysticOptions,
    collectionId: CollectionId,
    listener: () => void
  ): Promise<(() => Promise<void>) | undefined> {
    if (options.transactor !== 'network') {
      return undefined;
    }
    const transactor = await this.getOrCreateTransactor(options);
    const watchService = this.libp2pNodes.get(this.getNodeKey(options))?.node.reactivityWatch;
    if (!watchService) {
      return undefined;
    }
    const handle = watchService.watch({ collectionId, tails: this.tailReaderFor(transactor), onChange: listener });
    // NOTE: a dispose() landing during the await above has already emptied this set, so the handle
    // escapes it and lives until its table's DROP closes it; if hosts ever dispose while tables are
    // still initializing, refuse new watches after dispose (or close them on the spot).
    this.networkWatches.add(handle);
    return async () => {
      this.networkWatches.delete(handle);
      await handle.close();
    };
  }

  private tailReaderFor(transactor: ITransactor): CollectionTailReader {
    let reader = this.tailReaders.get(transactor);
    if (!reader) {
      reader = committedTailReader(transactor);
      this.tailReaders.set(transactor, reader);
    }
    return reader;
  }

  /**
   * Create a network transactor
   */
  private async createNetworkTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    // Create or get libp2p node
    const nodeKey = this.getNodeKey(options);
    let nodeInfo = this.libp2pNodes.get(nodeKey);

    if (!nodeInfo) {
      // NOTE: no `pieceStorage` and no `kvStore`, so the plugin's own node keeps blob pieces and
      // blob records in memory and loses them on restart — every pin with them, after which the
      // next sweep deletes the pieces (the node logs its own `node-wiring` warning for each). A
      // host that needs them persistent THROUGH the plugin has no option for it today: thread
      // `blobStorageFactory` into this call's `pieceStorage` and `kvStore` when one does. A host
      // that builds its own node and registers it with `registerLibp2pNode` already can.
      const node = await createLibp2pNode({
        port: options.libp2pOptions?.port ?? 0,
        networkName: options.libp2pOptions?.networkName ?? 'optimystic',
        bootstrapNodes: options.libp2pOptions?.bootstrapNodes ?? [],
        linkRoundTripMs: options.libp2pOptions?.linkRoundTripMs,
        cohortTopic: options.libp2pOptions?.cohortTopic,
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
    this.registerNodeCohortReachability(this.getTransactorKey(options), node);

    const protocolPrefix = `/optimystic/${options.libp2pOptions?.networkName ?? 'optimystic'}`;
    const keyNetwork = this.resolveKeyNetwork(options.keyNetwork, node, protocolPrefix);

    return createNodeNetworkTransactor({
      peerId: node.peerId,
      keyNetwork,
      coordinatedRepo,
      storageRepo: node.storageRepo,
      protocolPrefix,
      linkDeadlines: node.linkDeadlines,
      localChangeNotifier: blockChangeNotifier,
      clock: node.hlcClock,
    });
  }

  /**
   * Register `node`'s reachability gate (`node.cohortReachability`) for the transactor under `key`,
   * unless a gate is registered there already: one a test or host registered explicitly wins. A node a
   * host injected without building it through `createLibp2pNode` may carry none; its transactor then
   * stays always reachable, and nothing wakes the drain but its own re-check timer.
   */
  private registerNodeCohortReachability(key: string, node: FactoryNode): void {
    const gate = this.cohortGateFor(key);
    if (node.cohortReachability !== undefined && !gate.bound) gate.bind(node.cohortReachability);
  }

  /**
   * Create a local transactor (single-node, no network).
   * Uses `options.rawStorageFactory` when supplied so hosts can plug in a
   * persistent backend; otherwise falls back to in-memory `MemoryRawStorage`.
   *
   * A host-supplied backend gets the write-through read cache here — the one composition
   * seam for the local transactor. Without it `BlockStorage` re-reads block metadata on
   * essentially every operation, which over a filesystem backend is hundreds of reads of the
   * same tiny files per statement. The cache is ONE PER BACKING STORE in this process, not one
   * per transactor: `withReadCache` recognises a store it already fronts (by
   * `getStoreIdentity()`, e.g. two `FileRawStorage` over one directory, or by object) and
   * hands back the same cache under a fresh lease, so two `Database`s registered over one
   * directory see each other's commits. A re-opened `Database` therefore starts cold only if
   * every earlier lease over that store was released (`plugin.dispose()`); otherwise it joins
   * the still-warm shared cache, which is coherent because every in-process write went
   * through it. `MemoryRawStorage` passes through unwrapped (nothing to save), and so does a
   * backend the host already read-cached — in EITHER documented construction
   * (`new CachedRawStorage(inner)` or `new KvRawStorage(new CachedStoreDriver(driver))`,
   * the latter preferred when the backend's driver is reachable). `withReadCache` detects both
   * via the `readCached` capability rather than by class, and hands such a storage back with no
   * lease, so it stays the host's to dispose.
   */
  private async createLocalTransactor(options: ParsedOptimysticOptions): Promise<ITransactor> {
    const { storage: rawStorage, lease } = withReadCache(
      options.rawStorageFactory?.() ?? new MemoryRawStorage(), 'quereus:local');
    // Only a lease THIS call was handed is ours to release. A host that hands an already
    // read-cached storage to `register()` gets it back unchanged, with no lease, and keeps
    // owning it.
    if (lease) {
      this.readCacheLeases.push(lease);
    }
    const storageRepo = new StorageRepo(rawStorage);

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
        // This writer runs in the storage's own process and the storage applies every pend alone,
        // so each record is stamped with this run (`MessageOptions.localWriter`): a process that
        // exits between a write's pend and its commit over a persistent `rawStorageFactory` store
        // would otherwise leave a record the next run reads as a live reservation and refuses every
        // later write on, exactly as a one-machine networked group did (GitHub #54).
        return await storageRepo.pend(request, { localWriter: true });
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

    const storageRepo = new StorageRepo(memoryStorage);

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
        //
        // NOTE: such a node carries no storage-claim filter (`filterStorageClaimMerges`, installed by
        // `createLibp2pNodeBase`), so a peer that sends it a repo or cluster request is recorded in its
        // peerStore as serving and this key network will select it. Harmless while such a node registers
        // neither protocol, so nobody sends it one; if a host's foreign node ever serves storage, install
        // the filter on it in `registerLibp2pNode`.
        // The node's own deadlines where it carries them (a db-p2p node attaches `linkDeadlines`); the
        // key network falls back to the undeclared defaults otherwise.
        return new Libp2pKeyPeerNetwork(libp2pNode, DEFAULT_CLUSTER_SIZE, undefined, undefined, undefined, undefined, protocolPrefix, libp2pNode.linkDeadlines);
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
   * The full-replication event source (`BlockDurabilityReachedEvent`) of the node behind the
   * `network` transactor: its `StorageRepo`, whose under-replication ledger records the copies a
   * write acknowledged below full replication still owes. `undefined` for every other transactor —
   * `local`, `test` and `mesh-test` keep no ledger and run no drain, so nothing would ever fire —
   * and for an injected node built without a store, a client (`servesBlocks: false`) among them: no
   * ledger entry is ever recorded on a client, so a commit it writes is never followed to full here.
   */
  getBlockDurabilityNotifier(options: ParsedOptimysticOptions): IBlockDurabilityNotifier | undefined {
    if (options.transactor !== 'network') {
      return undefined;
    }
    const store = this.libp2pNodes.get(this.getNodeKey(options))?.node.storageRepo;
    return isBlockDurabilityNotifier(store) ? store : undefined;
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
   * Register an existing libp2p node for use by the factory, instead of having the factory create one.
   * `coordinatedRepo` defaults to the node's own (`node.coordinatedRepo`). A client node
   * (`servesBlocks: false`) has none and needs none: its reads and writes all go to serving machines.
   */
  registerLibp2pNode(networkName: string, node: FactoryNode, coordinatedRepo: IRepo | undefined = node.coordinatedRepo): void {
    const nodeKey = `${networkName}:0`; // Use port 0 as default for registered nodes
    this.libp2pNodes.set(nodeKey, { node, coordinatedRepo, blockChangeNotifier: node.blockChangeNotifier });
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
   * The gate saying whether the cohort behind `options`' transactor can be reached now
   * (`ICohortReachability`, docs/offline-sync.md §When to submit: the reachability gate). The offline
   * queue asks it before submitting an entry, and a live read in offline mode before it refreshes
   * (docs/offline-sync.md §Reads in offline mode), so both ask one gate; the offline-mode controller
   * also subscribes to its `onChange`, which wakes the drain. The same object for every call with one
   * transactor key, late-bound to the registration ({@link LateBoundCohortReachability}): a gate
   * registered after a table took this one is the one it asks and hears. A transactor with no gate
   * registered is always reachable and never wakes anyone — `local`, `test` and `mesh-test` have no
   * cohort to lose; the `network` transactor registers its node's ({@link createNetworkTransactor}).
   */
  getCohortReachability(options: ParsedOptimysticOptions): ICohortReachability {
    return this.cohortGateFor(this.getTransactorKey(options));
  }

  /**
   * Register the reachability gate for the transactor under `key` — `${transactor}:${keyNetwork}`, the
   * key {@link registerTransactor} takes. For tests and hosts; the `network` transactor registers its
   * node's gate itself unless one is registered here first. Replaces any gate registered under `key`
   * before, moving every wake subscription to it.
   */
  registerCohortReachability(key: string, reachability: ICohortReachability): void {
    this.cohortGateFor(key).bind(reachability);
  }

  private cohortGateFor(key: string): LateBoundCohortReachability {
    let gate = this.cohortGates.get(key);
    if (gate === undefined) {
      gate = new LateBoundCohortReachability();
      this.cohortGates.set(key, gate);
    }
    return gate;
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
   *
   * The blob backends go with them: each carries the transactor of its key
   * ({@link BlobBackend.transactor}), so keeping one past the transactor it names would hand a
   * reader of this network's reference trees a transactor nothing else writes through. For
   * `network` that costs nothing — the node, and so `node.blobs`, outlives this, and the next
   * resolution finds the same store. For every other transactor the next resolution builds a fresh
   * single-machine store, which is coherent with the block store `test` and `local` also rebuild
   * from scratch here. The service left behind stays in {@link singleMachineBlobServices} and is
   * stopped by {@link dispose} (its sweep timer is unref'd until then).
   */
  clearCache(): void {
    this.transactors.clear();
    this.blobBackends.clear();
    // A memo for a key whose transactor has been replaced would skip a registration that is
    // genuinely needed on the new one.
    this.blobScopes.clear();
  }

  /**
   * Release this factory's leases on the raw-storage read caches (see `withReadCache` in
   * `@optimystic/db-p2p`) and forget the transactors built over them. A cache is cleared and
   * its registration with the process-wide `SharedCachePool` retired only when the LAST lease
   * over its backing store releases — another `Database` in this process still reading through
   * it keeps it alive and warm.
   *
   * Explicit because nothing else reaches this factory when the hosting `Database` closes: the
   * vtab module's `disconnect` is per-statement and its `destroy` is DROP TABLE. Call it after
   * `db.close()`. A host that skips it keeps its lease for the life of the process, so the
   * store's cache stays registered (and a later `Database` over the same store starts warm
   * rather than cold) and its entries stay charged against the shared budget until the pool
   * evicts them as cold — hygiene, not correctness (the pool always evicts, never refuses, and
   * the warm cache is coherent with every in-process write).
   *
   * Also closes every network watch still open ({@link watchCollectionOverNetwork}), for the same
   * reason: a closed `Database`'s tagged tables are never dropped, so nothing else would release
   * them, and each would keep renewing its cohort registration until the node stops.
   *
   * Safe to call more than once. A transactor requested afterwards is rebuilt from scratch
   * (the storage factory is invoked again and takes a fresh lease — on a cold cache if nobody
   * else holds one over that store), so a stray statement after dispose is coherent. Does NOT
   * stop libp2p nodes; that is {@link shutdown}, which calls this as its last step.
   */
  async dispose(): Promise<void> {
    const leases = this.readCacheLeases;
    this.readCacheLeases = [];
    const watches = [...this.networkWatches];
    this.networkWatches.clear();
    // The single-machine blob services this factory built ({@link getBlobBackend}). Their sweep
    // timer is unref'd, so this is hygiene rather than a leak — but a service nobody stops can run
    // a sweep against a store the host has since closed. A `network` backend's service belongs to
    // the node and is stopped by {@link shutdown}.
    const blobServices = [...this.singleMachineBlobServices];
    this.singleMachineBlobServices.clear();
    this.blobBackends.clear();
    this.blobScopes.clear();
    this.transactors.clear();
    for (const watch of watches) {
      await watch.close();
    }
    for (const service of blobServices) {
      await service.stop();
    }
    for (const lease of leases) {
      await lease.release();
    }
  }

  /**
   * Shutdown all libp2p nodes, then release the read caches ({@link dispose}).
   */
  async shutdown(): Promise<void> {
    // A network transactor keeps re-sending cancels it could not land; through a stopped node they
    // never would, and the retry timer would keep the transactor and the node alive.
    for (const transactor of this.transactors.values()) {
      if (transactor instanceof NetworkTransactor) transactor.stop();
    }
    for (const [key, { node }] of this.libp2pNodes.entries()) {
      log('Stopping libp2p node: %s', key);
      await node.stop();
    }
    this.libp2pNodes.clear();
    await this.dispose();
  }
}
