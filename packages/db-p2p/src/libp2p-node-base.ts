import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify, identifyPush } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayServer, type CircuitRelayServerInit } from '@libp2p/circuit-relay-v2';
import { peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { ConnectionGater, PrivateKey } from '@libp2p/interface';
import { clusterService } from './cluster/service.js';
import { blockTransferService } from './cluster/block-transfer-service.js';
import { repoService } from './repo/service.js';
import { StorageRepo } from './storage/storage-repo.js';
import { BlockStorage } from './storage/block-storage.js';
import { MemoryRawStorage } from './storage/memory-storage.js';
import { withReadCache, type ResolvedReadCache } from './storage/with-read-cache.js';
import type { IRawStorage } from './storage/i-raw-storage.js';
import { latestClaimFromArchive, servableProof, type ArchiveServingRepo } from './storage/block-archive.js';
import { createServedRepoProxy } from './repo/served-repo-proxy.js';
import { seedOwnedBlocksFromStorage } from './owned-block-seed.js';
import { clusterMember, type ReconcileBlockCallback, type CommitCertificateSink, type DeriveExpectedClusterCallback } from './cluster/cluster-repo.js';
import { createReconcileBlock } from './cluster/reconcile-block.js';
import { resolveClusterPolicy, type ClusterPolicyOptions } from './cluster/cluster-policy.js';
import { assertClusterSizeCoupling } from './cluster/cluster-size-coupling.js';
import { createCommitCertStore, makeClusterCommitCertExtractor, type CommitCertStore } from './cluster/commit-cert.js';
import { coordinatorRepo } from './repo/coordinator-repo.js';
import { Libp2pKeyPeerNetwork, type NetworkMode, type NetworkStatePersistence } from './libp2p-key-network.js';
import { mergePeerAddresses, publishableAddrsForPeer, type AddressLog } from './peer-address-book.js';
import type { OptimysticNode, OptimysticNodeAttachments } from './optimystic-node.js';
import { ClusterClient } from './cluster/client.js';
import type { IRepo, ICluster, ITransactionValidator, BlockId, IBlockChangeNotifier } from '@optimystic/db-core';
import type { ITransactionStateStore } from './cluster/i-transaction-state-store.js';
import { networkManagerService, type NetworkManagerService } from './network/network-manager-service.js';
import type { SpreadOnChurnConfig, SpreadOnChurnMonitor } from './cluster/spread-on-churn.js';
import { BlockTransferCoordinator } from './cluster/block-transfer.js';
import type { RebalanceMonitorConfig } from './cluster/rebalance-monitor.js';
import { fretService, Libp2pFretService } from 'p2p-fret';
import { syncService } from './sync/service.js';
import { SyncClient } from './sync/client.js';
import type { SyncResponse } from './sync/protocol.js';
import type { ClusterLatestCallback } from './repo/coordinator-repo.js';
import { RestorationCoordinator } from './storage/restoration-coordinator.js';
import { RingSelector } from './storage/ring-selector.js';
import { RingShiftCoordinator } from './storage/ring-shift-coordinator.js';
import { StorageMonitor } from './storage/storage-monitor.js';
import type { StorageMonitorConfig } from './storage/storage-monitor.js';
import { ArachnodeFretAdapter } from './storage/arachnode-fret-adapter.js';
import type { RestoreCallback, BlockArchive } from './storage/struct.js';
import type { FretService } from 'p2p-fret';
import { createCohortTopicHost, type CohortTopicHostOptions } from './cohort-topic/host.js';
import { attachCohortChangeBridge } from './cohort-topic/change-bridge.js';
import { createReactivitySelfMembershipGate, reactivityTailBytes } from './cohort-topic/reactivity-membership-gate.js';
import { Libp2pReactivityNotifyTransport, registerNotifyHandler } from './reactivity/notify-transport.js';
import {
	Libp2pReactivityRecoverTransport,
	createLibp2pRecoverDialer,
	registerRecoverHandler,
	createRecoverRequestSigners,
} from './reactivity/recover-transport.js';
import { ReactivityForwarderHost, reactivityDirectSubscribers, reactivityNotificationTopicId } from './reactivity/forwarder-host.js';
import { ReactivityOriginationManager } from './reactivity/origination-manager.js';
import { ReactivityPushStateGossipDriver, registerPushStateGossipHandler, type ReactivityGossipCollection } from './reactivity/push-state-gossip.js';
import { RotationReRegistrationScheduler } from './reactivity/rotation-rereg-scheduler.js';
import { ReactivitySubscriberRegistry } from './reactivity/subscriber-registry.js';
import { DEFAULT_REACTIVITY_PROTOCOLS, reactivityProtocolList } from './reactivity/protocols.js';
import { registerMatchmakingQueryHandler } from './matchmaking/query-transport.js';
import { DEFAULT_MATCHMAKING_PROTOCOLS, matchmakingProtocolList } from './matchmaking/protocols.js';
import { signPeer } from './cohort-topic/peer-sig.js';
import {
	createNotificationVerifier,
	createCorrelationReplayGuard,
	createStickyCohortHintCache,
	reactivityNodePolicy,
	createTierAddressing,
	createRingHash,
	Tier,
	b64urlToBytes,
	bytesToB64url,
	type NotificationV1,
	type CohortRef,
	type PushStateGossipV1,
	type PushStateInit,
	type NotificationVerifier,
} from '@optimystic/db-core';
import { PartitionDetector } from './cluster/partition-detector.js';
import { assertSuperMajorityCoupling } from './cluster/supermajority-coupling.js';
import { createLogger } from './logger.js';
import { PeerReputationService } from './reputation/peer-reputation.js';
import type { IPeerReputation } from './reputation/types.js';
import type { AuthorizeInboundStream, InboundStreamAuthorizationInit } from './inbound-authorization.js';
import { DisputeService } from './dispute/dispute-service.js';
import { DisputeClient } from './dispute/client.js';
import { sampleArbitrators } from './dispute/arbitrator-selection.js';
import type { DisputeConfig } from './dispute/types.js';

type Libp2pInit = NonNullable<Parameters<typeof createLibp2p>[0]>;
export type Libp2pTransports = NonNullable<Libp2pInit['transports']>;

/** A service that accepts post-construction injection of the running libp2p node. */
interface SetLibp2pCapable {
	setLibp2p(libp2p: Libp2p): void;
}

/** A service that accepts post-start injection of the peer-reputation view. */
interface SetReputationCapable {
	setReputation(reputation: IPeerReputation): void;
}

/**
 * The custom services that receive post-assembly dependency injection. Reaching them through this
 * typed record (rather than `(node as any).services?.fret?.setLibp2p?.(...)`) removes the silent
 * optional-chaining skips: a call like `wired.fret.setLibp2p(node)` is checked against these
 * interfaces at build time (a caller-side typo or wrong-arity call fails tsc), and if the service is
 * absent at runtime the property access throws (fail-fast) instead of being quietly no-op'd. Note the
 * config-side `services` map is itself cast (see the comment at its declaration), so a service RENAME
 * is caught here at runtime, not by tsc, and a signature change on the real service is caught only at
 * that service's own definition. All three services are unconditionally present in that config, so a
 * throw here is a genuine wiring bug, not a missing service.
 */
type WiredServices = {
	fret: SetLibp2pCapable;
	networkManager: SetLibp2pCapable & SetReputationCapable;
	repo: SetLibp2pCapable;
};

/** Logger for the reactivity node-wiring (origination/forwarder/recover/rotation composition). */
const reactivityWiringLog = createLogger('reactivity-node-wiring');

/**
 * Logger for the best-effort in-factory service wiring. These injections run during `createLibp2p`
 * internals against the unreliable `components.libp2p` proxy; the real node is re-injected
 * post-construction (see the load-bearing block after `createLibp2p`), so a failure here is logged,
 * not fatal.
 */
const wiringLog = createLogger('node-wiring');

/**
 * Factory function or instance for creating raw storage. The node wraps the resolved instance in
 * the write-through read cache (`withReadCache`, unless it is a `MemoryRawStorage` or already
 * cached) and disposes THAT WRAPPER when it stops; the instance you supplied is never disposed.
 * Do not hand one uncached instance to two concurrently running nodes — each would wrap it
 * separately and never see the other's writes (Invariant 5 in
 * `packages/db-p2p/docs/storage.md`); to share a store across concurrent in-process nodes, build
 * one `CachedRawStorage` yourself and give every node that same object. Sequential reuse (a
 * restart over the same instance) is fine: the first node's cache is disposed at stop and the
 * second starts cold.
 */
export type RawStorageProvider = IRawStorage | (() => IRawStorage);

/**
 * `ClusterPolicyOptions` is intersected in, not restated: `resolveClusterPolicy` consumes those
 * fields structurally, so a second copy of the shape here would let a newly added knob compile and
 * be silently ignored. See `cluster/cluster-policy.ts` for what each one resolves to.
 */
export type NodeOptions = ClusterPolicyOptions & {
	/**
	 * Network port. Only used by the default `listenAddrs` fallback.
	 * For non-TCP transports (e.g. WebSockets), set `listenAddrs` explicitly.
	 */
	port?: number;
	/**
	 * WebSocket listen port. When set, the Node `createLibp2pNode` defaulting
	 * branch adds `webSockets()` to the transports and `/ip4/<wsHost>/tcp/<wsPort>/ws`
	 * to the listen addrs. Browsers and other WS-only peers (RN, web) can dial here.
	 * Ignored when `transports`/`listenAddrs` are explicitly provided.
	 */
	wsPort?: number;
	/** Interface to bind the WS listener to. Defaults to `0.0.0.0`. */
	wsHost?: string;
	/**
	 * Drop the default TCP transport and TCP listen addr. Useful for browser-only
	 * bootstraps that listen on `/ws` (typically fronted as `/wss`) only.
	 * Ignored when `transports`/`listenAddrs` are explicitly provided.
	 */
	disableTcp?: boolean;
	bootstrapNodes: string[];
	networkName: string;
	fretProfile?: 'edge' | 'core';
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
	/**
	 * Init passed to `circuitRelayServer(...)` when `relay` is enabled.
	 *
	 * `@libp2p/circuit-relay-v2` defaults to `applyDefaultLimit: true`, which
	 * stamps every reservation with `Limit { data: 128 KiB, duration: 2 min }`
	 * and resets the relayed stream once either cap is hit — silently killing
	 * long-lived service↔browser circuits. Trusted local clusters (e.g. the
	 * reference-peer service nodes) should pass
	 * `{ reservations: { applyDefaultLimit: false } }` to lift the cap.
	 */
	relayServerInit?: CircuitRelayServerInit;
	/** Storage provider - either an IRawStorage instance or a factory function. Defaults to MemoryRawStorage if not provided. See {@link RawStorageProvider} for the ownership rule. */
	storage?: RawStorageProvider;
	/** Override libp2p listen multiaddrs. */
	listenAddrs?: string[];
	/**
	 * Multiaddrs to advertise INSTEAD OF the listen addrs. For a node behind a NAT / reverse proxy /
	 * DNS front that binds one address but is reachable at another. When non-empty these REPLACE the
	 * advertised set entirely — observed/relayed addresses and {@link NodeOptions.appendAnnounceAddrs}
	 * are all dropped from it. An empty array means "unset" (libp2p's own semantics).
	 */
	announceAddrs?: string[];
	/**
	 * Multiaddrs to advertise IN ADDITION TO the listen addrs. Ignored while
	 * {@link NodeOptions.announceAddrs} is non-empty.
	 */
	appendAnnounceAddrs?: string[];
	/** Override libp2p transports. */
	transports?: Libp2pTransports;

	/**
	 * Responsibility K - the replica set size for determining cluster membership.
	 * This is distinct from kBucketSize (DHT routing) and clusterSize (consensus quorum).
	 * On the repo path, a node checks whether it is in the top responsibilityK peers
	 * (by XOR distance) for the key and redirects to closer peers if not. On the cluster
	 * update path it is a small-mesh bypass threshold: when the record's peer set is
	 * smaller than this, the update is processed locally regardless of membership;
	 * otherwise a non-member redirects to the responsible peers.
	 * Default: 1 (only the closest/member peer is responsible)
	 */
	responsibilityK?: number;

	/** Arachnode storage configuration */
	arachnode?: {
		enableRingZulu?: boolean; // default: true
		storage?: StorageMonitorConfig;
	};

	/**
	 * Churn-resilient spread protocol tuning. Absent -> enabled with defaults
	 * (see SpreadOnChurnConfig). Set { enabled: false } to disable spread on this node.
	 */
	spreadOnChurn?: Partial<SpreadOnChurnConfig>;

	/**
	 * Rebalance reaction tuning. Drives the RebalanceMonitor + BlockTransferCoordinator pull-gained/
	 * push-lost/replicate-grown path when arachnode/FRET are available (the only place fretAdapter +
	 * restoration coordinator exist). The grown arm is what pushes a block this node keeps to peers
	 * that newly became co-responsible for it — the founder case: anything committed while the
	 * deployment was one node gets its second copy only through this path (bounded per pass by
	 * `growthBlockBudget`). Absent -> enabled with defaults (see RebalanceMonitorConfig). Set
	 * { enabled: false } to disable the rebalance reaction (including the grown arm) on this node.
	 * When arachnode is disabled or FRET is absent the rebalance path stays inert regardless of this
	 * flag (rebalance is a resilience optimization — except for singly-held blocks, where the grown
	 * arm is currently the only mechanism that ever creates a second copy).
	 */
	rebalance?: Partial<RebalanceMonitorConfig> & { enabled?: boolean };

	/** Transaction validator for cluster consensus */
	validator?: ITransactionValidator;

	/** Optional persistence for network state (HWM, FRET table) across restarts */
	persistence?: NetworkStatePersistence;

	/** Dispute protocol configuration */
	dispute?: Partial<DisputeConfig>;

	/**
	 * Block-transfer (churn re-replication) receiver tuning.
	 *
	 * `requirePushCertificate` (default `true`) refuses a pushed block that carries no verifying
	 * cohort commit proof — see `BlockTransferServiceInit.requirePushCertificate` for why that is
	 * the default. It is exposed here because the migration it exists for is a DEPLOYMENT decision
	 * and the escape hatch lives on the RECEIVER: a node still holding pre-proof blocks cannot
	 * certify them (the signatures no longer exist), so under the strict default those blocks never
	 * gain a new holder — which also means `BlockTransferCoordinator.confirmReplicated` never
	 * confirms them, so a rebalance never releases them and a ring shift's confirm phase aborts on
	 * them (`docs/arachnode-ring-handoff.md` § Phase B). Clearing the backlog means running the
	 * receivers with this `false` until every such block has been rewritten under current code.
	 */
	blockTransfer?: { requirePushCertificate?: boolean };

	/** Optional persistent store for 2PC transaction state (enables crash recovery) */
	transactionStateStore?: ITransactionStateStore;

	/**
	 * Optional sink for the consensus commit certificate, fired per committed action just before the
	 * commit is applied to local storage (see {@link CommitCertificateSink}). This is the cluster-side
	 * half of the reactivity origination path: a caller wiring reactivity supplies a
	 * {@link CommitCertStore}'s `put` here, then resolves it via {@link makeClusterCommitCertExtractor}
	 * when it installs the change-notifier bridge ({@link attachCohortChangeBridge}) on the running
	 * node. Absent → zero cost (no cert is assembled).
	 */
	onCommitCertificate?: CommitCertificateSink;

	/**
	 * Opt-in cohort-topic substrate activation (reactivity / matchmaking origination). Default OFF →
	 * the node keeps today's bare `blockChangeNotifier = storageRepo` behavior at zero cohort cost (no
	 * host, no cert store; a caller-supplied {@link onCommitCertificate} is the only sink). When
	 * `enabled`, the node-base constructs the cohort-topic host post-assembly, builds a real FRET-backed
	 * `selfIsCohortMember` gate over `coord_0(H(tailId ‖ "reactivity"))`, and installs the change-notifier
	 * origination bridge — making reactivity origination live for ALL collections created on the node.
	 *
	 * A failure to construct the host (or a missing FRET service) **hard-fails** node startup: the
	 * operator opted in, so silently degrading to the bare notifier would hide misconfiguration.
	 */
	cohortTopic?: {
		/** Master switch. Absent/`false` → dormant, zero cost. */
		enabled: boolean;
		/**
		 * Requested cohort size; MUST match the host's `wantK` so the membership gate checks the same
		 * cohort the host serves. Default 16 (the host's default).
		 */
		wantK?: number;
		/** Optional pass-through host tuning (profile / minSigs / fanout / gossipIntervalMs / antiDos / promotion). */
		host?: Omit<CohortTopicHostOptions, 'privateKey' | 'wantK'>;
	};

	/**
	 * Optional Ed25519 private key for this node. When provided, the libp2p
	 * node uses this identity instead of generating a fresh keypair. Use this
	 * to persist peer identity across process restarts.
	 *
	 * Accepts a libp2p `PrivateKey` (as returned by `generateKeyPair('Ed25519')`
	 * or `privateKeyFromProtobuf(...)` from `@libp2p/crypto/keys`).
	 */
	privateKey?: PrivateKey;

	/**
	 * Optional predicate deciding whether a remote peer may open one of the four Optimystic
	 * database protocols on this node (`repo`, `cluster`, `sync`, `block-transfer`). It is
	 * consulted once per inbound stream, before any frame is decoded or any operation executed.
	 *
	 * This is deliberately ONE node-level option threaded to all four services rather than four
	 * per-service options: "is this peer allowed to talk to my database?" is a property of the
	 * node, not of the protocol, and four independently-settable options make it easy to secure
	 * three surfaces and silently miss the fourth. (Each service still accepts the same option in
	 * its own init, so the services stay independently testable and usable outside this factory.)
	 *
	 * Absent → no check at all, and today's behavior exactly. Supplied → fail-closed: `false`, a
	 * throw, a rejection, or a timeout all deny and abort the stream. `remotePeerId` is the
	 * dialing peer's `PeerId.toString()`. See {@link AuthorizeInboundStream} and
	 * `docs/internals.md` § Inbound Stream Authorization.
	 *
	 * NOTE: this covers the four database protocols only. The dispute, reactivity, matchmaking,
	 * cohort-topic and libp2p built-in (identify/ping/…) protocols this node also registers are
	 * NOT gated by it. To refuse a peer at the connection level instead — every protocol at once,
	 * including identify — use {@link NodeOptions.connectionGater}.
	 */
	authorizeInboundStream?: AuthorizeInboundStream;

	/**
	 * Deadline for {@link NodeOptions.authorizeInboundStream}; expiry denies the stream (a hanging
	 * predicate would otherwise pin an inbound stream slot). Defaults to
	 * `DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS` (5s). Ignored when no predicate is supplied.
	 */
	authorizeInboundStreamTimeoutMs?: number;

	/**
	 * Optional libp2p connection gater. The libp2p browser default denies
	 * dialing insecure WebSockets and private/loopback addresses; callers
	 * that need to dial local or unsecured bootstraps (web reference dev,
	 * Playwright e2e, RN simulators) supply a permissive gater here.
	 */
	connectionGater?: ConnectionGater;
};

/**
 * Resolve the node's raw storage and put the write-through read cache in front of it. This is
 * the single place the network node resolves its `IRawStorage`, so it is the single place the
 * cache is wired (`withReadCache` states the exclusions: memory storage and already-cached
 * storage pass through unchanged). The default is a bare `MemoryRawStorage`, deliberately not
 * routed through the helper — nothing to cache.
 *
 * `ownedCache` is the cache this node built, and the ONLY thing its stop path may dispose — a
 * host that supplied its own `CachedRawStorage` keeps owning it (see {@link ResolvedReadCache}).
 */
function resolveStorage(provider: RawStorageProvider | undefined, networkName: string): ResolvedReadCache {
	if (!provider) {
		return { storage: new MemoryRawStorage(), ownedCache: undefined };
	}
	const storage = typeof provider === 'function' ? provider() : provider;
	// NOTE: the label is the network name, so N nodes on one network in one process produce N
	// identically-labelled rows in `SharedCachePool.stats()` (they are still distinct stores — the
	// pool keys on a monotonic store id, not the label). Harmless while the label is only read by
	// a human eyeballing occupancy; if pool stats ever need to attribute bytes to a SPECIFIC node,
	// fold the peer id in — it is not known here, so that would mean labelling after node
	// construction rather than at resolve time.
	return withReadCache(storage, `node:${networkName}`);
}

/**
 * Resolve the full FRET engine the cohort-topic host needs.
 *
 * `createCohortTopicHost` consumes the complete {@link FretService} engine surface — notably
 * `setActivityHandler` (and `routeAct`, size estimation, …). The value at `node.services.fret` is the
 * libp2p `Libp2pFretService` *wrapper*, which re-exports only a subset (`assembleCohort`, `routeAct`, …)
 * and keeps the real engine private behind its lazy `ensure()` accessor. By the time activation runs the
 * engine is already initialized — the wrapper's `Startable.start()` ran during `node.start()` — and the
 * engine and wrapper share one underlying routing store, so the host and the membership gate observe the
 * same cohort state. Returns the engine when reachable; otherwise the value as-is (a test may inject a
 * raw engine that needs no unwrapping).
 */
function resolveFretEngine(fret: FretService | undefined): FretService | undefined {
	if (!fret) {
		return undefined;
	}
	const candidate = fret as unknown as { ensure?: () => FretService };
	return typeof candidate.ensure === 'function' ? candidate.ensure() : fret;
}

/**
 * The raw topic id bytes of a collection's current served reactivity {@link PushState}, or `undefined` if the
 * node serves none. The forwarder host keys its served map by topicId, but a **backfill** recover request
 * carries only a collectionId — so the drain-redirect binding resolves the collection's current tail topic
 * here (the highest-`lastRevision` served PushState) before consulting `rotationRedirectFor`. While the old
 * tail is the only served state this resolves it (and its drain gate redirects); once the new tail is served
 * this resolves the new tail (no gate → no redirect), exactly as the recover serve's backfill path intends.
 */
function resolveCurrentServedTopic(forwarderHost: ReactivityForwarderHost, collectionId: string): Uint8Array | undefined {
	const ps = forwarderHost.pushStateForCollection(collectionId);
	return ps === undefined ? undefined : b64urlToBytes(ps.topicId);
}

export async function createLibp2pNodeBase(
	options: NodeOptions,
	defaults: {
		listenAddrs: string[];
		transports: Libp2pTransports;
	}
): Promise<OptimysticNode> {
	const { storage: rawStorage, ownedCache } = resolveStorage(options.storage, options.networkName);

	// Create placeholder restore callback (will be replaced after node starts)
	let restoreCallback: RestoreCallback = async (_blockId, _rev?) => {
		return undefined;
	};

	// Create shared storage layers with restoration callback
	const storageRepo = new StorageRepo((blockId) =>
		new BlockStorage(blockId, rawStorage, restoreCallback)
	);

	let clusterImpl: ICluster | undefined;
	let coordinatedRepo: IRepo | undefined;
	// The running node, bound immediately after `createLibp2p` below. Service factories that need
	// the node at REQUEST time must close over this, never over `components.libp2p`: `components`
	// is libp2p's Proxy, whose getter THROWS `MissingServiceError('libp2p not set')` for any key it
	// does not hold — and `libp2p` is not a component. The throw happens on the property read, so
	// neither `?.` nor a following `if (!libp2p) return` can catch it; it escapes as an application
	// error on whatever request touched it. Same reason fret/networkManager/repo take the node via
	// setLibp2p (see the injection block after `createLibp2p`).
	let liveNode: Libp2p | undefined;

	const clusterProxy: ICluster = {
		async update(record) {
			if (!clusterImpl) {
				throw new Error('ClusterMember not initialized');
			}
			return await clusterImpl.update(record);
		}
	};

	// Built by a named factory, not an inline literal: see `createServedRepoProxy` for why (an
	// inline object here is unreachable from every test that does not boot a libp2p node, which is
	// how it served every repair archive without its commit proof). `coordinatedRepo` is read per
	// call because it is assigned further down, after the cluster is assembled.
	const repoProxy: ArchiveServingRepo = createServedRepoProxy(storageRepo, () => coordinatedRepo);

	// The ONE authorization slice, spread verbatim into all four database-protocol service inits
	// below. Building it once (rather than repeating two option reads per service) is what makes
	// "secured three surfaces, missed the fourth" impossible: adding a fifth protocol service is a
	// spread of this object, and dropping it from one is visible at the call site.
	// Absent `authorizeInboundStream` → every service constructs its gate as `undefined` and the
	// inbound path is byte-for-byte what it was before this option existed.
	const inboundAuthorization: InboundStreamAuthorizationInit = {
		...(options.authorizeInboundStream ? { authorizeInboundStream: options.authorizeInboundStream } : {}),
		...(options.authorizeInboundStreamTimeoutMs !== undefined
			? { authorizeInboundStreamTimeoutMs: options.authorizeInboundStreamTimeoutMs }
			: {})
	};

	const nodePrivateKey = options.privateKey ?? await generateKeyPair('Ed25519');

	const listenAddrs = options.listenAddrs ?? defaults.listenAddrs;
	const transports = options.transports ?? defaults.transports;

	// --- cohort-topic substrate activation (opt-in; default off → today's bare behavior, zero cost) ---
	const cohortEnabled = options.cohortTopic?.enabled === true;
	// Resolve wantK ONCE so the post-assembly host serves and the membership gate checks the SAME cohort.
	const cohortWantK = options.cohortTopic?.wantK ?? 16;
	// When enabled, the cluster member records the consensus commit cert into this store synchronously,
	// BEFORE `storageRepo.commit` emits the change event the bridge's extractor resolves it from (see
	// cluster-repo.ts §applyConsensusOperation). Created early because the sink must be passed into
	// `clusterMember(...)` below. Composed with any caller-supplied `onCommitCertificate` so both fire.
	const certStore: CommitCertStore | undefined = cohortEnabled ? createCommitCertStore() : undefined;
	const onCommitCertificate: CommitCertificateSink | undefined = certStore
		// `certStore.put` runs FIRST so origination's cert capture cannot be defeated by a throwing caller
		// sink: the whole composed call is isolated in `ClusterMember.captureCommitCert`, so a caller sink
		// that threw before the store was written would make that commit silently never originate. Ordering
		// the store first keeps origination correct regardless of the caller sink (`put` never throws).
		? (actionId, cert): void => { certStore.put(actionId, cert); options.onCommitCertificate?.(actionId, cert); }
		: options.onCommitCertificate;

	// Every cluster-policy default lives in `cluster/cluster-policy.ts` — including WHY the admission
	// gate and the repair corroboration floor resolve the one operator field
	// (`clusterPolicy.assumedClusterSize`) to different values when it is absent. Resolved ONCE, here,
	// before anything that reads a cluster size is constructed: `networkManagerService` below,
	// `Libp2pKeyPeerNetwork`, and the spread-on-churn monitor init must all read `consensusConfig.clusterSize`
	// rather than `options.clusterSize` directly, or they can each apply their own fallback default and
	// silently disagree (ticket bug-cluster-size-resolution-single-source). `assertClusterSizeCoupling`
	// below is the fail-fast backstop if a future edit reintroduces that split.
	const consensusConfig = resolveClusterPolicy(options);

	const libp2pOptions: Libp2pInit = {
		start: false,
		privateKey: nodePrivateKey,
		// NOTE: libp2p's `AddressManagerInit` also carries `noAnnounce` and `announceFilter`; neither is
		// exposed on `NodeOptions`. Add them here the same way if a deployment ever needs to suppress a
		// specific advertised address rather than replace the whole set.
		addresses: {
			listen: listenAddrs,
			...(options.announceAddrs ? { announce: options.announceAddrs } : {}),
			...(options.appendAnnounceAddrs ? { appendAnnounce: options.appendAnnounceAddrs } : {})
		},
		connectionManager: {
			// `autoDial`, `minConnections`, and `dialQueue` were stale libp2p option keys silently
			// ignored under the former `libp2pOptions as any` (removed with this change). This libp2p
			// version has no such keys — auto-dial is now default connection-manager behavior with no
			// direct replacement — so they are dropped rather than re-cast. See review handoff.
			maxConnections: 16,
			// Renamed from the stale `inboundConnectionUpgradeTimeout`. 10_000 equals this version's
			// default, so surfacing (and correcting) the key is behavior-preserving; the old key was a no-op.
			inboundUpgradeTimeout: 10_000
		},
		...(options.connectionGater ? { connectionGater: options.connectionGater } : {}),
		transports,
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		// Narrow cast confined to the `services` field: the built-in factories (identify/dcutr/…) are
		// typed against a SECOND copy of `@libp2p/interface` pulled in transitively (via `@libp2p/crypto`),
		// whose `Uint8Array<ArrayBuffer>` vs `<ArrayBufferLike>` PeerId/key shapes are structurally
		// incompatible with the top-level copy — a dependency-dedup artifact, not a real mismatch. The cast
		// stays on this field alone so the rest of `libp2pOptions` remains fully typed as `Libp2pInit`.
		// NOTE: this cast exists ONLY because of the duplicate @libp2p/interface install; if that dedups
		// (or on a libp2p bump) drop `as unknown as NonNullable<Libp2pInit['services']>` and type the map directly.
		services: ({
			// `@libp2p/identify` is the ONE service here whose protocol id it builds itself:
			// `Identify`/`IdentifyPush` both emit `/${protocolPrefix}/id[/push]/1.0.0`, always
			// prepending the leading slash (its own default is the BARE `'ipfs'`). So this
			// prefix must stay slash-LESS — passing `/optimystic/...` yields the malformed
			// double-slash `//optimystic/<net>/id/1.0.0`. Every other service below
			// (cluster/repo/sync/blockTransfer) concatenates its own template literal and so
			// takes the slash-PREFIXED `protocolPrefix` form; do not unify the two.
			// Locked by `identify-protocol-id.spec.ts`.
			identify: identify({
				protocolPrefix: `optimystic/${options.networkName}`
			}),
			// identify/push propagates *later* address/protocol changes (relay reservation,
			// AutoNAT-learned observed addr, a service registered post-start) to already-connected
			// peers. Without it those peers keep the stale snapshot from the initial identify.
			// Two consequences, both now covered by tests rather than asserted here:
			//  - Addresses: a relay-only peer's reservation completes AFTER its first connection to
			//    the relay, so the circuit address is exactly the one identify cannot have carried.
			//    The relay's peerStore entry stays empty and a later dial by peer id alone fails
			//    with NoValidAddressesError against a reachable peer — `relay-address-propagation.spec.ts`
			//    (its gated control reproduces that failure with push removed).
			//  - Protocols: `membershipOf` in `libp2p-key-network.ts` classifies a peer serves/
			//    foreign/unknown purely from the peerStore protocol list, so a cluster/repo handler
			//    registered post-start never flips an already-connected peer to `serves` —
			//    `identify-push-propagation.spec.ts`.
			identifyPush: identifyPush({
				protocolPrefix: `optimystic/${options.networkName}`
			}),
			ping: ping(),
			// DCUtR (hole-punch) upgrades relayed node↔node connections to direct
			// ones; AutoNAT learns this node's public reachability via peer dial-back.
			// Both are always-on and depend on `identify` above. They are inert where
			// the transport can't hole-punch or dial back (e.g. browser/WS-only), which
			// is acceptable — they neither throw nor break the build in that case.
			dcutr: dcutr(),
			autoNAT: autoNAT(),
			pubsub: gossipsub({
				allowPublishToZeroTopicPeers: true,
				heartbeatInterval: 7000
			}),
			// Circuit relay server - enables this node to relay connections for other peers
			...(options.relay ? { relay: circuitRelayServer(options.relayServerInit) } : {}),

			// Custom services - create wrapper factories that inject dependencies
			cluster: (components: any) => {
				const addressLog: AddressLog = createLogger('peer-address-book', components.peerId?.toString());
				const serviceFactory = clusterService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					responsibilityK: options.responsibilityK ?? 1,
					...inboundAuthorization
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					cluster: clusterProxy,
					// Identity for membership scoping on the update path. peerId is a core
					// libp2p component, available at service-construction time.
					peerId: components.peerId,
					// Fallback addr resolver for redirect targets whose multiaddrs are not
					// already embedded in record.peers. A redirect payload is handed to a THIRD
					// party, so it answers with `publishableAddrsForPeer` — the same rule, and the
					// same function, `findCluster` uses to fill a cluster record: the publishable
					// half of our live connections plus the peer's own advertised addresses.
					getConnectionAddrs: async (peerId: any) => {
						if (!liveNode) return [];
						const conns = liveNode.getConnections?.(peerId) ?? [];
						return await publishableAddrsForPeer(liveNode, conns, peerId, addressLog);
					},
					// Inbound cluster records carry each cohort member's multiaddrs. libp2p only
					// propagates addresses between directly-connected peers, so for a cohort chosen
					// by key position this is often the ONLY way this node learns how to reach a
					// relay-only sibling. Same late-binding shape as getConnectionAddrs above:
					// `liveNode` resolves at request time, not at service construction.
					recordPeerAddresses: (peerId: any, multiaddrs: string[]) => {
						if (!liveNode) return;
						mergePeerAddresses(liveNode, peerId, multiaddrs, addressLog);
					}
				});
			},

			repo: (components: any) => {
				const serviceFactory = repoService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					responsibilityK: options.responsibilityK ?? 1,
					...inboundAuthorization
				});
				// RepoService.checkRedirect needs the running node (network manager for the
				// responsible-set computation, self id for the membership check, connection
				// addrs for redirect targets). The libp2p components.libp2p proxy does NOT
				// reliably resolve from inside a service at request time, so the node is
				// injected explicitly post-construction via setLibp2p(node) below — the same
				// mechanism networkManager/fret use — rather than forwarded here. checkRedirect
				// keys the responsible set on the RAW encoded block id
				// (getCluster(encode(blockKey)) → hashKey(encode(...))), matching the
				// coordinator's findCluster(encode(blockId)) — same cohort, no spurious redirect.
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					repo: repoProxy
				});
			},

			sync: (components: any) => {
				const serviceFactory = syncService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					...inboundAuthorization
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					repo: repoProxy
				});
			},

			// Block-transfer protocol handler for churn re-replication. Wired to the
			// *local* storageRepo (not repoProxy): a pushed replica must land in this
			// node's own storage, not be re-routed through the cluster-coordinated repo.
			blockTransfer: (components: any) => {
				const serviceFactory = blockTransferService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					// Absent → the strict default inside the service; see `blockTransfer` on the options.
					...(options.blockTransfer?.requirePushCertificate !== undefined
						? { requirePushCertificate: options.blockTransfer.requirePushCertificate }
						: {}),
					...inboundAuthorization
				});
				return serviceFactory({
					registrar: components.registrar,
					repo: storageRepo,
					// Verifying a pushed block's commit proof needs the cohort's super-majority fraction.
					// Read from the SAME resolved `consensusConfig` the member and coordinator read (whose
					// coupling `assertSuperMajorityCoupling` below already asserts) — a third copy resolving
					// its own default would defeat that.
					superMajorityThreshold: consensusConfig.superMajorityThreshold,
					// So this service's authorization denials reach the same error sink as the other three.
					logger: components.logger
				});
			},

			networkManager: (components: any) => {
				const svcFactory = networkManagerService({
					clusterSize: consensusConfig.clusterSize,
					expectedRemotes: (options.bootstrapNodes?.length ?? 0) > 0,
					allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
					clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5
				});
				const svc = svcFactory(components);
				// Best-effort proxy-time injection; the real node is re-injected post-construction below.
				try { (svc as SetLibp2pCapable).setLibp2p(components.libp2p); }
				catch (err) { wiringLog('networkManager in-factory setLibp2p failed (proxy); real node injected post-construction: %o', err); }
				return svc;
			},
			fret: (components: any) => {
				const svcFactory = fretService({
					k: 15,
					m: 8,
					capacity: 2048,
					profile: options.fretProfile ?? ((options.bootstrapNodes?.length ?? 0) > 0 ? 'core' : 'edge'),
					networkName: options.networkName,
					bootstraps: options.bootstrapNodes ?? []
				});
				const svc = svcFactory(components) as Libp2pFretService;
				// Best-effort proxy-time injection; the real node is re-injected post-construction below.
				try { (svc as SetLibp2pCapable).setLibp2p(components.libp2p); }
				catch (err) { wiringLog('fret in-factory setLibp2p failed (proxy); real node injected post-construction: %o', err); }
				return svc;
			}

			// [dispute-subsystem-dormant] The /optimystic/<network>/dispute/1.0.0 handler
			// (disputeProtocolService / DisputeProtocolService) is intentionally NOT registered here.
			// The subsystem is staged dormant pending arbitrator-set anchoring — without it, a peer
			// minting throwaway keypairs can forge a synthetic super-majority and pass resolution.
			// Gate: tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
			// Wiring plan: tickets/backlog/feat-dispute-subsystem-live-activation
		}) as unknown as NonNullable<Libp2pInit['services']>,
		// Add bootstrap nodes as needed
		peerDiscovery: [
			...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
		],
	};

	const node = await createLibp2p(libp2pOptions);

	// Bind the closure-captured node BEFORE start(): the cluster service's address-learning and
	// redirect-addr resolvers read it on every inbound request, and the first one can arrive as
	// soon as the protocol handler goes live in start().
	liveNode = node;

	// Release the raw-storage read cache's shared-pool registration when the node stops. Installed
	// FIRST — before start() and before every other stop wrapper — so it runs LAST in the wrapper
	// chain, after every monitor and service that may still read storage during its own stop. Only
	// wired for a cache THIS node built: a MemoryRawStorage passes through unwrapped, and a
	// host-supplied `CachedRawStorage` stays the host's to dispose (stopping one node must not
	// clear a cache its other consumers are still reading through). A skipped release leaks only
	// cold entries the pool evicts under pressure; the point of the polite release is honest pool
	// occupancy on a long-lived provider node.
	if (ownedCache) {
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			try {
				await previousStop();
			} finally {
				await ownedCache.dispose();
			}
		};
	}

	// Inject the REAL libp2p node into the services that need it, before start(). These are
	// load-bearing and the node has NOT started yet, so any throw fails fast and rejects node
	// creation (nothing started leaks) — far better than the service silently falling back to the
	// unreliable `components.libp2p` proxy and surfacing later as routing/consensus failures.
	const wired = node.services as unknown as WiredServices;
	wired.fret.setLibp2p(node);
	wired.networkManager.setLibp2p(node);
	// RepoService.checkRedirect resolves the network manager / self id / connection
	// addrs through this injected node (the components.libp2p proxy is unreliable
	// from inside a service at request time). Done before start() so the protocol
	// handler is live with a resolvable node from its first request.
	wired.repo.setLibp2p(node);

	await node.start();

	// Everything from here to the `return` runs against an ALREADY STARTED node (open transports,
	// listening addresses, running services). A rejection out of that span used to hand the caller an
	// error and no handle, leaving the node running with its listener port still bound — unrecoverable
	// for the caller and enough to block the port for the next start attempt. So the whole post-start
	// body rolls back: see the `catch` at the bottom of this function.
	try {

		// Initialize peer reputation service
		const reputation = new PeerReputationService();

		// Initialize cluster coordination components
		const networkMode: NetworkMode = (options.bootstrapNodes?.length ?? 0) > 0 ? 'joining' : 'forming';
		// Network-namespaced protocol prefix, threaded into the key network so coordinator/
		// cohort selection is scoped to peers that serve THIS network's cluster/repo protocol.
		// A peer that only belongs to another network sharing the same physical nodes/
		// bootstraps registers a different (network-namespaced) identify protocol, so it is
		// never selected and can't drag this network's super-majority below quorum.
		const protocolPrefix = `/optimystic/${options.networkName}`;
		const keyNetwork = new Libp2pKeyPeerNetwork(node, consensusConfig.clusterSize, undefined, networkMode, options.persistence, reputation, protocolPrefix);
		await keyNetwork.initFromPersistedState();
		const createClusterClient = (peerId: any) => ClusterClient.create(peerId, keyNetwork, protocolPrefix);

		// Inject reputation into NetworkManagerService. Load-bearing and non-optional: the service is
		// unconditionally present, so a throw is a real wiring bug. The node has already started here, but
		// no ad-hoc stop is needed: the post-start rollback `catch` at the bottom of this function stops it.
		wired.networkManager.setReputation(reputation);

		// Create partition detector and get FRET service
		const partitionDetector = new PartitionDetector();
		const fretSvc = (node as any).services?.fret as FretService | undefined;

		// Fetch a block archive from one cohort peer over the sync protocol, bounded by a
		// per-peer timeout so an unreachable peer can't stall reconciliation. Mirrors the
		// SyncClient query in `clusterLatestCallback`, but returns the full archive (which
		// carries the materialized block) rather than only the latest ActionRev.
		const fetchArchiveFromPeer = async (peerIdStr: string, blockId: BlockId): Promise<BlockArchive | undefined> => {
			let peerId: ReturnType<typeof peerIdFromString>;
			try {
				peerId = peerIdFromString(peerIdStr);
			} catch {
				return undefined;
			}
			if (peerId.equals(node.peerId)) return undefined;
			const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix);
			try {
				const response = await Promise.race<SyncResponse>([
					syncClient.requestBlock({ blockId, rev: undefined }),
					new Promise<SyncResponse>(resolve => { setTimeout(() => resolve({ success: false }), 1000).unref(); })
				]);
				return response.success ? response.archive : undefined;
			} catch {
				// Peer unreachable / no data — caller falls back to the next cohort peer.
				return undefined;
			}
		};

		// Active reconciliation for a block this member committed without a materializable base
		// (cohort drift, or a refused `missing-base-revision` commit). See `reconcile-block.ts` for
		// the corroboration rules — in particular why both quorums are capped by how many peers
		// could answer at all, which is what lets a genuinely two-node cohort heal.
		// NOTE: this and the CoordinatorRepo below must cap against the SAME
		// repairCorroborationClusterSize, or the two restoration paths disagree about how much trust a
		// lone peer gets. Safe today because both read the one `resolveClusterPolicy` result above; if
		// either ever resolves its own value, add a fail-fast coupling check like
		// `assertSuperMajorityCoupling` rather than relying on proximity.
		const reconcileBlock: ReconcileBlockCallback = createReconcileBlock({
			selfPeerId: node.peerId.toString(),
			fetchArchive: fetchArchiveFromPeer,
			// The 4th parameter is a proof reconcile verified against these exact bytes; it is
			// persisted so the repaired replica serves it onward (see StorageRepo.saveReplicatedBlock).
			saveReplicatedBlock: (blockId, block, source, verifiedProof) =>
				storageRepo.saveReplicatedBlock(blockId, block, source, verifiedProof),
			simpleMajorityThreshold: consensusConfig.simpleMajorityThreshold,
			superMajorityThreshold: consensusConfig.superMajorityThreshold,
			repairCorroborationClusterSize: consensusConfig.repairCorroborationClusterSize,
			reputation
			// `anchoring` (proof layer-2, `ProofAnchoring`) is intentionally NOT wired here yet — nor
			// is the coordinator's `proofAnchoring` below: a real implementation re-derives the
			// block's cohort from `keyNetwork.findCluster` (the same source `deriveExpectedCluster`
			// uses) and needs a churn-tolerance window so historic cohort rotation does not read as an
			// anomaly flood. Until then certification runs on layer-1 cryptography and LOGS the
			// unanchored residual. See `feat-cluster-membership-threshold-cert-anchoring`, and the
			// matching `recomputeArbitratorSet` note at the clusterMember construction below.
		});

		// Member-side membership derivation for the admission gate: independently re-derive this block's
		// responsible cluster from the SAME source the coordinator uses (IKeyNetwork.findCluster), plus FRET's
		// network-size confidence. A member gates a coordinator-declared peer set against this view before
		// voting, so a self-shrunk minority-partition set cannot be voted into super-majority (see cluster-repo
		// admitMembership). No FRET ⇒ confidence 0 ⇒ the gate fails closed for any downsize.
		const deriveExpectedCluster: DeriveExpectedClusterCallback = async (blockId) => {
			const peers = await keyNetwork.findCluster(new TextEncoder().encode(blockId));
			let confidence = 0;
			if (fretSvc) {
				try {
					confidence = fretSvc.getNetworkSizeEstimate().confidence;
				} catch {
					// Leave confidence 0 → fail closed for downsizing.
				}
			}
			return { peers: peers ?? {}, confidence };
		};

		clusterImpl = clusterMember({
			storageRepo,
			peerNetwork: keyNetwork,
			peerId: node.peerId,
			privateKey: nodePrivateKey,
			protocolPrefix,
			partitionDetector,
			fretService: fretSvc,
			validator: options.validator,
			reputation,
			consensusConfig,
			stateStore: options.transactionStateStore,
			reconcileBlock,
			onCommitCertificate,
			deriveExpectedCluster
			// `recomputeArbitratorSet` (invalidation layer-2) is intentionally NOT wired here yet: a live FRET
			// recompute needs a churn-tolerance window so it does not false-reject legitimate certificates from
			// late-joiners (a liveness regression). Until that is tuned against live topology — and the
			// cohort-topic membership-cert trust anchor (layer 3) lands — invalidation verification runs on the
			// challenger-bound set + membership + dedup (layer 1) and LOGS the residual anchoring gap. See
			// `verifyInvalidationCertificate` and `tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`.
		});

		// Cleanup cluster member intervals on node stop. Installed HERE, immediately after clusterImpl
		// exists, rather than further down: the post-start rollback only unwinds resources whose stop
		// wrapper is already installed at the moment of the throw, so a wrapper trailing its resource by
		// hundreds of lines leaves those intervals running on a failed startup. Same reasoning as the
		// owned-block-feed wrapper below.
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					(clusterImpl as import('./cluster/cluster-repo.js').ClusterMember).dispose();
				} finally {
					// Never let a dispose failure strand the transports — same try/finally shape every
					// other wrapper in this chain uses.
					await previousStop();
				}
			};
		}

		const coordinatorRepoFactory = coordinatorRepo(
			keyNetwork,
			createClusterClient,
			{
				// clusterSize is now part of consensusConfig (member + coordinator share one reference).
				...consensusConfig
			},
			fretSvc,
			reputation,
			options.transactionStateStore
		);

		// Create callback for querying cluster peers for their latest block revision. Three-way
		// contract (see ClusterLatestCallback): a CertifiedActionRev is the peer's claim, a resolved
		// `undefined` is the peer answering "I hold nothing", and a REJECTION is silence — the
		// coordinator counts it as "did not answer" and refuses to report an authoritative absent
		// over it. Transport errors must therefore propagate, not collapse into `undefined` (that
		// collapse let a slow two-node cohort report a missing block as authoritatively absent —
		// ticket cluster-read-consult-cannot-report-unreachable).
		//
		// The claim carries the cohort's commit proof for the claimed revision when the answering
		// peer retained one. It is attached UNVERIFIED — a peer chooses what to send. Both repair
		// paths verify it before weighing it (the shared layer in `cluster/certified-claims.ts`):
		// the coordinator's certifyClaim pass in `queryClusterForLatest`, and reconcile's
		// certification pass in `cluster/reconcile-block.ts`.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context?) => {
			// Self-read short-circuit: dialling self via SyncClient is a round trip
			// with no remote on the other end, and on nodes without listen addresses
			// (solo WebSocket-only, bare-RN, etc.) the self-dial can hang the dial
			// queue. Read directly from the local storage repo instead. The catch stays:
			// a local storage error is not a cohort peer being unreachable, and the
			// coordinator ignores a self rejection anyway.
			if (peerId.equals(node.peerId)) {
				try {
					const result = await storageRepo.get({ blockIds: [blockId], context });
					const latest = result[blockId]?.state?.latest;
					if (!latest) return undefined;
					// The SAME lookup a peer serving an archive uses, so a self answer and a remote
					// answer attach proofs by one rule (including the mis-pairing guard). It never
					// throws — a proof fault degrades to "no proof", never to a lost claim.
					const proof = await servableProof(storageRepo, blockId, latest);
					return proof ? { ...latest, proof } : latest;
				} catch {
					return undefined;
				}
			}
			const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix);
			// No try/catch: a dial or protocol failure rejects through to the coordinator, whose
			// per-peer deadline also bounds a hung request — slowness needs no race here.
			const response = await syncClient.requestBlock({ blockId, rev: undefined });
			if (response.success && response.archive) {
				// Projection lives with the archive shape (`latestClaimFromArchive`) rather than
				// re-read inline here — it reads the claim and its proof out of ONE revision entry,
				// so a serving peer cannot pair a proof with a revision it does not certify.
				const claim = latestClaimFromArchive(response.archive);
				if (claim) return claim;
			}
			// The peer DID answer, without data: `success:false` is the sync service's "Block not
			// found in local storage", and an archive with no usable revisions holds nothing either
			// way. Both are absent claims, not silence.
			return undefined;
		};

		coordinatedRepo = coordinatorRepoFactory({
			storageRepo,
			localCluster: clusterImpl,
			localPeerId: node.peerId,
			clusterLatestCallback,
			// Read-driven acquisition shares the commit path's reconcile callback verbatim: same bounded
			// archive fetch, same (rev, actionId) and content quorums, same monotonic saveReplicatedBlock
			// funnel. `clusterLatestCallback` alone can only tell the reader WHICH revision the cohort
			// holds; this is what moves the bytes. Only reached once a corroborated revision exists, so a
			// genuinely absent block still costs no archive fetch.
			acquireBlockFromCohort: reconcileBlock
		});

		// Fail-fast coupling: the cluster member (what accepts a super-majority as sufficient) and the
		// coordinator (what declares a transaction committed on that super-majority) MUST run the same
		// threshold, or the node would come up able to disagree with itself mid-consensus. Both are fed from
		// the single `consensusConfig` above; this asserts on their RESOLVED values so any future drift throws
		// HERE at construction. See `assertSuperMajorityCoupling`.
		assertSuperMajorityCoupling(
			clusterImpl as import('./cluster/cluster-repo.js').ClusterMember,
			coordinatedRepo as import('./repo/coordinator-repo.js').CoordinatorRepo
		);

		// Recover persisted transaction state before accepting new requests
		if (options.transactionStateStore) {
			await (clusterImpl as import('./cluster/cluster-repo.js').ClusterMember).recoverTransactions();
			await (coordinatedRepo as import('./repo/coordinator-repo.js').CoordinatorRepo).recoverTransactions();
		}

		// --- Shared owned-block set for the resilience monitors ---
		// SpreadOnChurnMonitor (sender) and RebalanceMonitor (responsibility tracker) both act on "the
		// blocks this node physically holds". They share ONE Set so the two can never drift: a single
		// owned-block feed populates it, and the rebalance responsibility-loss signal evicts from it
		// (in the rebalance block below). Both monitors take this exact instance via deps.trackedBlocks.
		const networkManager = (node as any).services?.networkManager as NetworkManagerService | undefined;

		// See the comment above `consensusConfig` for why every cluster-size consumer must read the SAME
		// resolved value. This throws at construction (rather than letting a node come up mismatched) if a
		// future edit gives `keyNetwork` or `networkManager` their own fallback again.
		assertClusterSizeCoupling(consensusConfig.clusterSize, { keyNetwork, networkManager });

		const ownedBlocks = new Set<string>();
		// Single owned-block feed: every block this node commits OR receives as a replica fires
		// storageRepo.onAnyCollectionChange. Subscribe to storageRepo DIRECTLY (not
		// node.blockChangeNotifier): the cohort-topic activation block below may replace
		// blockChangeNotifier with a decorating bridge, but storageRepo keeps emitting on its own
		// surface regardless of that opt-in. NOTE: this feed does NOT re-emit blocks already durable
		// from a previous run; those are seeded once at startup by the storage-enumeration scan wired
		// below (seedOwnedBlocksFromStorage), so a restarted node protects on-disk data without waiting
		// for each block to be touched again. Registered lazily the first time a
		// monitor that reads ownedBlocks is wired, so when BOTH monitors are disabled no subscription
		// leaks; torn down exactly once in the stop wrapper below.
		let offOwnedBlockFeed: (() => void) | undefined;
		const ensureOwnedBlockFeed = (): void => {
			if (offOwnedBlockFeed) return;
			offOwnedBlockFeed = storageRepo.onAnyCollectionChange((e) => {
				for (const blockId of e.blockIds) ownedBlocks.add(blockId);
			});
		};
		// Single owned-block-feed teardown. Registered up front (before either monitor's own stop
		// wrapper) so it runs regardless of WHICH monitor subscribed the feed - including the
		// spread-disabled / rebalance-only case. Idempotent: offOwnedBlockFeed is undefined-guarded.
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					offOwnedBlockFeed?.();
				} finally {
					await previousStop();
				}
			};
		}

		// --- Churn-resilient spread: drive SpreadOnChurnMonitor on a live node ---
		// Nothing previously activated the SENDING side of the churn-resilient spread protocol on a
		// real node. Here we init + start the monitor (sharing ownedBlocks) and ensure the single
		// owned-block feed is live, so a debounced connection:close re-pushes the node's blocks to
		// expansion-cohort peers (the receiver durably persists each push via saveReplicatedBlock).
		let spreadMonitor: SpreadOnChurnMonitor | undefined;
		if (networkManager && (options.spreadOnChurn?.enabled ?? true) !== false) {
			try {
				spreadMonitor = networkManager.initSpreadOnChurnMonitor(
					partitionDetector,
					storageRepo,
					keyNetwork,
					consensusConfig.clusterSize,
					protocolPrefix,
					ownedBlocks,
					options.spreadOnChurn,
				);
				await spreadMonitor.start();
				ensureOwnedBlockFeed();
			} catch (err) {
				// Spread is a resilience optimization, not a correctness requirement - a wiring
				// failure (e.g. FRET briefly unavailable) must NOT hard-fail node startup, unlike the
				// operator-opted-in cohortTopic block. Log and continue with spread inert.
				((node as any).logger?.forComponent?.('db-p2p:spread-on-churn'))?.('init failed: %o', err);
			}
		}

		// Expose for tests/diagnostics (mirrors node.keyNetwork / node.reputation).
		(node as any).spreadOnChurnMonitor = spreadMonitor;

		// Disposal: stop the spread monitor deterministically before the transports close. Composes
		// with the arachnode / clusterMember / cohort-topic stop wrappers (each calls its captured
		// previousStop last). Idempotent (SpreadOnChurnMonitor.stop early-returns when not running), so
		// a double node.stop() does not throw. The owned-block feed teardown is the separate up-front
		// wrapper above (shared across both monitors).
		{
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				try {
					if (spreadMonitor) await spreadMonitor.stop();
				} finally {
					await previousStop();
				}
			};
		}

		// Initialize Arachnode ring membership and restoration
		const enableArachnode = options.arachnode?.enableRingZulu ?? true;
		if (enableArachnode) {
			const log = (node as any).logger?.forComponent?.('db-p2p:arachnode');
			const fret = (node as any).services?.fret as any;

			if (fret) {
				const fretAdapter = new ArachnodeFretAdapter(fret, node.peerId.toString());

				// Blocks whose shed range has been RELEASED (Phase C of a ring shift, or a confirmed
				// rebalance release). This is the GC-eligibility signal the future storage sweep
				// (`st-storage-sweep-archival-and-capacity-estimate`) must consult: a block's local bytes may
				// be reclaimed ONLY once it appears here, so an unconfirmed / still-served range is never
				// swept. Populated strictly after replication is confirmed. See
				// docs/arachnode-ring-handoff.md § Part 2 (Local bytes vs. tracking).
				// NOTE: no sweep consumes this set yet; it is the coordinated eligibility handoff the sweep
				// ticket will read. Until then it grows unbounded — bound it when the sweep lands.
				const gcEligible = new Set<string>();
				(node as any).gcEligibleBlocks = gcEligible;

				// The ring-shift state machine (advertise→confirm→release). Wired inside the rebalance block
				// below (it needs the BlockTransferCoordinator confirmer + the cohort-size floor); left
				// undefined when the rebalance reaction is not wired, in which case ring shifts stay inert —
				// a move-out is unsafe without the confirm/release path.
				let ringShift: RingShiftCoordinator | undefined;

				const storageMonitor = new StorageMonitor(rawStorage, options.arachnode?.storage ?? {});
				const ringSelector = new RingSelector(fretAdapter, storageMonitor, {
					minCapacity: 100 * 1024 * 1024,
					thresholds: {
						moveOut: 0.85,
						moveIn: 0.40
					},
					// Damping so the ring decision cannot thrash near a boundary
					// (docs/arachnode-ring-handoff.md § Part 1).
					smoothingAlpha: 0.2,
					deadband: 0.5,
					minDwellMs: 10 * 60 * 1000
				});

				// Determine and announce ring membership
				const peerId = node.peerId.toString();
				const arachnodeInfo = await ringSelector.createArachnodeInfo(peerId);
				fretAdapter.setArachnodeInfo(arachnodeInfo);

				log?.('Announced Arachnode membership: Ring %d', arachnodeInfo.ringDepth);

				// Setup restoration coordinator with FRET adapter
				const restorationCoordinatorV2 = new RestorationCoordinator(
					fretAdapter,
					// The node's own IPeerNetwork, not an inline `dialProtocol` lambda: the lambda opened
					// streams without `runOnLimitedConnection`, so a block holder reachable only through a
					// relay looked like a peer that simply did not have the block, and it dropped the
					// caller's AbortSignal, so `SyncClient`'s per-peer dial deadline never bounded a dial.
					keyNetwork,
					`/optimystic/${options.networkName}`,
					node.peerId.toString()
				);

				// Update restore callback to use new coordinator
				const newRestoreCallback: RestoreCallback = async (blockId, rev?) => {
					return await restorationCoordinatorV2.restore(blockId, rev);
				};

				// Replace the restore callback (this is a bit hacky, but works for now)
				(storageRepo as any).createBlockStorage = (blockId: string) =>
					new BlockStorage(blockId, rawStorage, newRestoreCallback);

				// --- Rebalance reaction: drive RebalanceMonitor + react via BlockTransferCoordinator ---
				// Nothing previously activated the rebalance path on a real node: initRebalanceMonitor was
				// never called, the monitor was never start()ed, and BlockTransferCoordinator (the
				// pull-gained / push-lost reaction primitive) was never constructed in src. This block lives
				// inside the arachnode `if (fret)` gate because both dependencies only exist here — the
				// fretAdapter and the RestorationCoordinator. When arachnode is disabled or FRET is absent the
				// rebalance path stays inert (acceptable: rebalance is a resilience optimization). A wiring
				// failure here is non-fatal (log + continue), unlike the operator-opted-in cohortTopic block.
				if (networkManager && (options.rebalance?.enabled ?? true) !== false) {
					try {
						// repo → the LOCAL storageRepo (not repoProxy/coordinatedRepo): a pulled/pushed replica
						// must land in / be read from this node's own storage, same reasoning as the
						// blockTransfer service handler registration. protocolPrefix (/optimystic/<networkName>)
						// MUST match the prefix the node registers its block-transfer handler under, or every
						// lost-block push dials the wrong protocol and fails to connect.
						const coordinator = new BlockTransferCoordinator(
							storageRepo,
							keyNetwork,
							restorationCoordinatorV2,
							partitionDetector,
							protocolPrefix,
						);

						const rebalanceMonitor = networkManager.initRebalanceMonitor(
							partitionDetector,
							fretAdapter,
							ownedBlocks,
							options.rebalance,
						);
						await rebalanceMonitor.start();

						// onRebalance fires synchronously from the monitor's debounced check; the coordinator's
						// reaction (pull gained / push lost, each partition-guarded) is async, so hop it off the
						// handler rather than blocking the monitor's emit loop. handleRebalanceEvent can REJECT
						// (e.g. RestorationCoordinator.restore() throws while pulling a gained block) and a bare
						// `void` would surface that as an unhandled rejection (process-fatal on Node >=15); the
						// reaction is a resilience optimization, so swallow + log instead.
						//
						// ALONGSIDE dispatching to the coordinator, drive the shared owned-block set off this
						// authoritative responsibility signal. A GAINED block is added immediately so it is
						// tracked even before its next commit/replica touches the feed.
						//
						// A LOST block is NO LONGER released synchronously: doing so stopped spreading a block
						// whose push to the new owners might fail, drop it below the replication floor, and let a
						// later sweep reclaim it (docs/arachnode-ring-handoff.md § Why the current code violates
						// it #2). Instead the release is GATED on confirmation — the coordinator returns the lost
						// blocks it confirmed replicated to ≥ floor new owners, and ONLY those are untracked
						// (authoritative eviction from the shared set — complements spread's lazy self-prune) and
						// marked GC-eligible. A lost block whose push failed / was partition-skipped stays
						// tracked and served, and is retried on the next rebalance.
						//
						// Best-effort iteration safety: this eviction can mutate ownedBlocks while
						// SpreadOnChurnMonitor (or this monitor) is mid for...of over the same Set inside an
						// async loop. Adding/deleting a Set entry during iteration does not throw in JS — entries
						// are visited best-effort — which is acceptable for a resilience mechanism, so we
						// document it here rather than add locking.
						//
						// The event's `grown` arm (blocks this node KEEPS whose cohort acquired new peers — the
						// founder/cohort-growth case): handleRebalanceEvent pushes each grown block to the newly
						// co-responsible peers and returns a per-block GrowthOutcome in `result.growth`, which is
						// fed back into the monitor here. The monitor records a peer as seen ONLY off that
						// feedback (a confirmed replica, or a block that otherwise reached its floor), so a failed
						// push is re-detected on the next check instead of being silently dropped — bounded by
						// growthMaxAttempts, after which the monitor abandons the peer for that block (visible in
						// getGrowthDiagnostics). Nothing is released or untracked off the grown arm — the node
						// keeps serving the block either way. On the catch path NOTHING is recorded: the monitor's
						// state stays un-advanced and the next check retries, the correct outcome for a reaction
						// that threw.
						rebalanceMonitor.onRebalance((event) => {
							for (const blockId of event.gained) ownedBlocks.add(blockId);
							coordinator.handleRebalanceEvent(event).then((result) => {
								for (const blockId of result.released) {
									rebalanceMonitor.untrackBlock(blockId); // also evicts from the shared ownedBlocks set
									gcEligible.add(blockId);                 // confirmed replicated → safe to sweep
								}
								for (const [blockId, outcome] of result.growth) {
									rebalanceMonitor.recordGrowthOutcome(blockId, outcome);
								}
								if (result.underReplicated.length > 0) {
									const growthDiag = rebalanceMonitor.getGrowthDiagnostics();
									log?.('cohort-growth: %d of %d grown blocks not confirmed on new peers this pass ' +
										'(awaiting-confirmation=%d given-up-pairs=%d)',
										result.underReplicated.length, event.grown.size,
										growthDiag.blocksAwaitingConfirmation, growthDiag.abandonedPairs);
								}
							}).catch((err) => {
								// NOTE: accepted tradeoff — recording nothing here means growthMaxAttempts (which
								// only counts RECORDED incomplete outcomes) never bounds a reaction that throws
								// every time, so the re-check timer retries it at growthRecheckIntervalMs forever,
								// logging each failure. Kept deliberately: per-peer errors are already caught
								// inside the coordinator, so a throw out of handleRebalanceEvent is a coding bug,
								// and a loud unbounded retry is the right way to surface one — silently abandoning
								// the block would hide it and leave the block singly held. Revisit if a legitimate
								// recoverable condition is ever allowed to throw out of the reaction.
								log?.('rebalance reaction failed: %o', err);
							});
						});

						// Ring-shift handoff (advertise→confirm→release). It needs the confirmer (this
						// coordinator) and the cohort-size floor (this monitor), so it is wired here. The
						// `onRelease` callback runs Phase C's local effect: stop serving/spreading the shed
						// range and mark it GC-eligible — the same authoritative eviction the confirmed-rebalance
						// release performs.
						ringShift = new RingShiftCoordinator({
							fretAdapter,
							ringSelector,
							fret,
							partitionDetector,
							confirmer: coordinator,
							ownedBlocks,
							selfPeerId: peerId,
							getFloor: () => rebalanceMonitor.getCohortSize(),
							onRelease: (blockIds) => {
								for (const blockId of blockIds) {
									rebalanceMonitor.untrackBlock(blockId);
									gcEligible.add(blockId);
								}
							}
						});
						// Reconcile any stale `moving` advertisement left by a crash mid-handoff (no-op unless
						// arachnode metadata survived a restart still marked `moving`).
						ringShift.reconcileOnStart();

						// Feed owned blocks via the SINGLE shared feed (idempotent — already live if the spread
						// block above wired it). Both monitors read the same ownedBlocks set this populates.
						ensureOwnedBlockFeed();

						// Expose for tests/diagnostics (mirrors node.spreadOnChurnMonitor).
						(node as any).rebalanceMonitor = rebalanceMonitor;
						(node as any).blockTransferCoordinator = coordinator;
						(node as any).ringShiftCoordinator = ringShift;

						// Disposal: stop the monitor before transports close. Composes with the other stop
						// wrappers (each calls its captured previousStop last). Idempotent — RebalanceMonitor.stop()
						// early-returns when not running (NetworkManagerService.stop() also stops it). The shared
						// owned-block feed teardown is the separate up-front wrapper (not duplicated here).
						const previousStop = node.stop.bind(node);
						node.stop = async () => {
							try {
								await rebalanceMonitor.stop();
							} finally {
								await previousStop();
							}
						};
					} catch (err) {
						// Rebalance is a resilience optimization, not a correctness requirement - a wiring
						// failure (e.g. FRET briefly unavailable) must NOT hard-fail node startup.
						log?.('rebalance wiring init failed: %o', err);
					}
				}

				// Monitor capacity and adjust ring periodically. The damped `shouldTransition()` decides
				// WHETHER/where to move (docs/arachnode-ring-handoff.md § Part 1); the RingShiftCoordinator
				// carries the move out through the advertise→confirm→release handoff (§ Part 2) so a shift
				// never drops a key below its replication floor. The old unilateral `setArachnodeInfo` flip —
				// which changed advertised responsibility instantly with no data handoff — is gone.
				//
				// Ring shifts run ONLY when `ringShift` is wired (i.e. the rebalance reaction is enabled): a
				// move-out is unsafe without the confirm/release path, so a node with the rebalance reaction
				// disabled stays at its bootstrap ring rather than flipping unsafely.
				const monitorInterval = setInterval(async () => {
					if (!ringShift) return;
					const transition = await ringSelector.shouldTransition();
					if (transition.shouldMove && transition.direction && transition.newRingDepth !== undefined) {
						log?.('Ring transition needed: moving %s to Ring %d', transition.direction, transition.newRingDepth);
						try {
							const outcome = await ringShift.executeShift({
								direction: transition.direction,
								newRingDepth: transition.newRingDepth
							});
							log?.('Ring shift outcome: %o', outcome);
						} catch (err) {
							log?.('Ring shift failed: %o', err);
						} finally {
							// Measure the minimum dwell from the SETTLED shift (completed or rolled back), not
							// just the trigger stamped inside shouldTransition (docs/arachnode-ring-handoff.md §1.3).
							ringSelector.recordShiftSettled();
						}
					}
				}, 60_000);

				// Cleanup on node stop
				const originalStop = node.stop.bind(node);
				node.stop = async () => {
					clearInterval(monitorInterval);
					await originalStop();
				};
			} else {
				log?.('FRET service not available, Arachnode disabled');
			}
		}

		// --- Seed the shared owned-block set from already-durable storage ---
		// Blocks durable from a previous run are otherwise untracked until next touched (see the
		// onAnyCollectionChange comment above where ownedBlocks is declared). Placed here, AFTER both
		// monitor-wiring blocks (spread ~line 862, rebalance ~line 974) have had their chance to call
		// ensureOwnedBlockFeed():
		//   - Gate on offOwnedBlockFeed: only seed when a monitor actually consumes ownedBlocks; if both
		//     are disabled the set is unused and the scan (plus the background task) is wasted work.
		//   - Feed-before-scan ordering is load-bearing: because the feed is already live, a block
		//     committed/replicated DURING the scan is caught by the feed; Set.add is idempotent so the
		//     overlap is harmless. Scanning before subscribing would drop a block committed in the gap.
		//   - Fire-and-forget so a large store never blocks startup; the .catch keeps a scan rejection
		//     from becoming an unhandled rejection.
		//   - Cancellable: a stop wrapper flips seedStopping so the scan loop breaks against a
		//     stopping/closing backend rather than running the enumeration to completion.
		// NOTE: a concurrent rebalance release can untrackBlock (delete from ownedBlocks) a confirmed-
		// released block while this scan is still running, and the scan could then re-add that id. Benign
		// transient: the block is still in the metadata store (no sweep reclaims metadata yet), so a
		// re-added released block is simply re-evaluated and re-released on the next rebalance tick. Right
		// after a restart, responsibility-loss detection lags this fast metadata scan, so the window is
		// small. Accepted rather than synchronized.
		if (offOwnedBlockFeed && typeof rawStorage.listBlockIds === 'function') {
			let seedStopping = false;
			const previousStop = node.stop.bind(node);
			node.stop = async () => {
				seedStopping = true;
				await previousStop();
			};
			void seedOwnedBlocksFromStorage(rawStorage, ownedBlocks, () => seedStopping)
				.catch((err) => ((node as any).logger?.forComponent?.('db-p2p:owned-block-seed'))?.('seed failed: %o', err));
		}

		// [dispute-subsystem-dormant] The DisputeService object is constructed below so tests and
		// getDisputeStatus() work, but it is unreachable from the live network path:
		//   - No inbound handler: disputeProtocolService is NOT in the services map above.
		//   - onInvalidation is deliberately unset: maybeInvalidate() is a no-op on live nodes.
		//   - revalidate is deliberately unset: handleChallenge always votes inconclusive on live nodes.
		// Full activation requires arbitrator-set anchoring before a forged synthetic cohort can pass resolution.
		// Gate: tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
		// Wiring plan: tickets/backlog/feat-dispute-subsystem-live-activation
		// Initialize dispute service if enabled
		let disputeServiceInstance: DisputeService | undefined;
		if (options.dispute?.disputeEnabled) {
			const createDisputeClient = (peerId: any) => DisputeClient.create(peerId, keyNetwork, protocolPrefix);
			disputeServiceInstance = new DisputeService({
				peerId: node.peerId,
				privateKey: nodePrivateKey,
				peerNetwork: keyNetwork,
				createDisputeClient,
				reputation,
				validator: options.validator,
				config: options.dispute,
				selectArbitrators: async (blockId: string, excludePeers: string[], count: number, round: number, epoch: Uint8Array) => {
					const { hashKey: fretHashKey } = await import('p2p-fret');
					const fret = (node as any).services?.fret as FretService | undefined;
					if (!fret) return [];
					// Dispersed sampling: draw `count` peers from coordinates spread across the whole keyspace
					// (hash(blockId ‖ round ‖ epoch ‖ i)) rather than the block's XOR neighborhood, so an attacker
					// who owns the block's locale does not thereby own the arbitrators. `assembleCohort` already
					// filters to known members; excluding the original cluster + self keeps arbitrators independent.
					const excludeSet = new Set(excludePeers);
					// NOTE: adding the local node's own id to `exclude` makes the draw node-relative. Cross-node
					// determinism (the verifiable-recompute property) holds today only because the dissent
					// coordinator running this is itself a member of the original cluster, so `self` is already in
					// `excludePeers` — the add is a no-op and every honest node excludes the identical set. When a
					// verify-path recompute lands, it MUST reconstruct `exclude` from the challenger's identity
					// (`proof.challengerPeerId`) + original cluster, never the verifier's own id, or re-derivation diverges.
					excludeSet.add(node.peerId.toString());
					const picks = await sampleArbitrators(
						{ blockId: new TextEncoder().encode(blockId), round, epoch, count, exclude: excludeSet },
						(coord, wants) => fret.assembleCohort(coord, wants) as string[],
						fretHashKey,
					);
					return picks.map(pid => peerIdFromString(pid));
				},
			});
		}

		// The host-facing attachment surface, declared once in `optimystic-node.ts` and written here
		// through ONE object literal so every field is type-checked AND a field added to
		// `OptimysticNodeAttachments` but never assigned here is a compile error rather than an
		// `undefined` a host reads as present. Keeping it typed is load-bearing: when
		// `node.keyNetwork` was reachable only through a cast, three hosts found it easier to build a
		// SECOND Libp2pKeyPeerNetwork from constructor defaults — a different cohort width and no
		// network-membership filter than this node's own consensus path uses for the same key
		// (ticket bug-second-key-network-built-with-defaults).
		const attachments: OptimysticNodeAttachments = {
			coordinatedRepo,
			storageRepo,
			// The StorageRepo is the single commit funnel for both the coordinated and
			// direct paths, so it is the node's per-collection change-notifier origin. This is the
			// default; the cohort-topic activation block below REPLACES it with the origination-decorating
			// bridge notifier when the substrate is enabled.
			blockChangeNotifier: storageRepo,
			keyNetwork,
			reputation,
			disputeService: disputeServiceInstance,
			// The node's libp2p Ed25519 identity key. Exposed on the same attachment surface as
			// coordinatedRepo/keyNetwork so a host can bind a client-transaction signer to it (the Quereus
			// collection-factory's getSigner reuses this via signPeer). libp2p does not surface the private
			// key on its public `Libp2p` interface, so this attachment is the sanctioned in-process handle.
			// Ed25519 by construction (options.privateKey defaults to generateKeyPair('Ed25519')).
			peerPrivateKey: nodePrivateKey,
		};
		Object.assign(node, attachments);

		// --- Cohort-topic origination activation (post-node: consumes the fully-assembled node + FRET) ---
		// This is the only place that is after the node + FRET are assembled (node.start() done, fretSvc
		// available) yet before any caller can capture `blockChangeNotifier` — the Quereus collection-factory
		// captures it once, immediately after createLibp2pNode returns, and reuses that reference as
		// `localChangeNotifier` for every NetworkTransactor it builds. Installing the bridge here makes the
		// origination path live for ALL collections created on the node.
		if (cohortEnabled) {
			// The host needs the full FRET engine surface; node.services.fret is the wrapper (see resolveFretEngine).
			const fret = resolveFretEngine(fretSvc);
			if (!fret) {
				// Operator opted in; degrading silently to the bare notifier would hide misconfiguration.
				// (The started node is torn down by the post-start rollback `catch` at the bottom of this function.)
				throw new Error('cohortTopic enabled but the FRET service is unavailable on the node');
			}

			const host = await createCohortTopicHost(node, fret, {
				...(options.cohortTopic!.host ?? {}),
				// Wire the node's reputation service in as the production backing for the bootstrap-evidence
				// referee verifier (the `{ isBanned, getScore }` view `PeerReputationService` satisfies), so a
				// configured cohort genuinely gates cold-root `bootstrap: true` (PoW always; reputation when a
				// referee endorsement is offered; a signed reference to an existing parent topic on any tier).
				// The node service is the *default* backing — a caller that supplies its own `antiDos.reputation`
				// (or any other `antiDos` override) still wins, since the caller spread comes last.
				antiDos: { reputation, ...(options.cohortTopic!.host?.antiDos) },
				// committedParentTopicReader (the T0/T1 committed-tier parent-reference existence backing) is
				// intentionally left unwired: no coord-keyed committed-membership index exists yet (the
				// transaction-log commit certificate is keyed by action, not by coord_0). So the host default
				// fails T0/T1 parent-ref existence closed — a FRET-cached cert must not vouch for committed-tier
				// existence (committed-tier integrity) — while T2/T3 parent-ref consults the FRET membership cache
				// for real. The dedicated committed backing is the follow-on `cohort-topic-parent-ref-tx-log-content`;
				// an operator may still pass one via cohortTopic.host.committedParentTopicReader.
				privateKey: nodePrivateKey, // real k − x threshold signing
				wantK: cohortWantK,
			});

			// --- Cohort-topic + reactivity + matchmaking teardown ---
			// Installed HERE, immediately after `host` exists and BEFORE the ~230 lines of reactivity /
			// matchmaking wiring below, because the post-start rollback only unwinds resources whose stop
			// wrapper is already installed at the moment of the throw. With the wrapper at the END of the
			// block (where it used to live) a throw mid-wiring left the host's gossip timer and cohort-topic
			// protocol handlers running. The bindings it releases are therefore declared up front and
			// undefined-guarded — same idiom as `offOwnedBlockFeed` above — so this tears down exactly what
			// has been created so far, whether that is the host alone or the whole wiring.
			//
			// Ordering (load-bearing): release reactivity timers + protocol handlers BEFORE host.stop()
			// (which clears the cohort gossip timer + unhandles the cohort-topic protocols) BEFORE the node's
			// transports close (previousStop). Composes with the existing arachnode + clusterMember stop
			// wrappers (each calls its captured previousStop last). `node.unhandle` on a protocol that was
			// never registered does not throw — libp2p's registrar deletes each id from its handler map
			// (a miss is silently ignored) and then re-patches the peer store's advertised protocol list —
			// so the handler releases need no separate registration flags.
			const reactivityProtocols = DEFAULT_REACTIVITY_PROTOCOLS;
			const matchmakingProtocols = DEFAULT_MATCHMAKING_PROTOCOLS;
			let unsubscribeCohortBridge: (() => void) | undefined;
			let offInboundNotify: (() => void) | undefined;
			let pushStateGossip: ReactivityPushStateGossipDriver | undefined;
			let reactivityRotation: RotationReRegistrationScheduler | undefined;
			{
				const previousStop = node.stop.bind(node);
				node.stop = async (): Promise<void> => {
					try {
						reactivityRotation?.stop();
						pushStateGossip?.stop();
						offInboundNotify?.();
						await node.unhandle(reactivityProtocolList(reactivityProtocols));
						await node.unhandle(matchmakingProtocolList(matchmakingProtocols));
						unsubscribeCohortBridge?.();
						await host.stop();
					} finally {
						await previousStop();
					}
				};
			}

			// selfIsCohortMember: this node owns the collection's reactivity-topic fan-out iff it is in the
			// FRET cohort around coord_0(H(currentTailId ‖ "reactivity")). Uses db-core's default hashes
			// (createReactivityTopicAnchor / createTierAddressing / createRingHash), byte-identical to the
			// host's internal `new RingHash()` and the subscriber-side anchor, and the SAME cohortWantK as
			// the host — so the coord + cohort line up across origination and subscription.
			const selfIsCohortMember = createReactivitySelfMembershipGate({
				fret,
				selfPeerId: node.peerId.toString(),
				wantK: cohortWantK,
			});

			unsubscribeCohortBridge = attachCohortChangeBridge(
				node as unknown as { blockChangeNotifier?: IBlockChangeNotifier },
				{
					source: storageRepo,
					service: host.service,
					selfIsCohortMember,
					extractCommitCert: makeClusterCommitCertExtractor(certStore!),
				},
			).unsubscribe;

			// Expose the host so the reactivity origination wiring (and the activation test) can install
			// `CohortTopicService.onLocalCommit`.
			(node as any).cohortTopicHost = host;

			// --- Reactivity notification transport (origination → fan-out → inbound delivery → push-state gossip) ---
			// Compose notify + forwarder-host + push-state-gossip onto the cohort-topic host so a committed change
			// on a tail-cohort member actually reaches subscribers on OTHER nodes over real sockets. The change
			// bridge above fires `onLocalCommit`; this is what the emitted notifications travel over.
			// (docs/reactivity.md §Notification origination / §Propagation.) Reactivity reuses the canonical,
			// network-agnostic protocol IDs, matching the cohort-topic family's production default.
			const selfPeerId = node.peerId.toString();
			const reactivityProfile = host.profile; // Edge ⇒ subscriber-only via the policy gate; Core forwards.
			const reactivityPolicy = reactivityNodePolicy(reactivityProfile);
			// db-core default anchor + tier addressing, byte-identical to the host's `new RingHash()`, the
			// origination gate, and the subscriber-side anchor — so coord_0 derivation lines up everywhere.
			const reactivityAddressing = createTierAddressing(createRingHash());
			// Reactivity's forwarder cohort sits at coord_0 — TREE tier 0 (peer-independent), distinct from the
			// CAPACITY tier T3 the verifier/willingness use. `registry.findServing` keys on the engine's tree
			// depth, so the served reactivity engine is found at tree tier 0, never at 3.
			const REACTIVITY_FORWARDER_TREE_TIER = 0;

			// Node-level subscriber registry: a constructed ReactivitySubscriptionManager registers here so a
			// socket-delivered NotificationV1 reaches it. (The Quereus Database.watch → manager bridge that
			// CONSTRUCTS managers stays the backlog item optimystic-network-reactive-watch-integration-test.)
			const reactivitySubscribers = new ReactivitySubscriberRegistry();
			(node as any).reactivitySubscribers = reactivitySubscribers;

			// 1. Notify transport — unicast NotificationV1 send + inbound subscribe. selfPeerId guards self-dials.
			const notify = new Libp2pReactivityNotifyTransport(node, { selfPeerId });

			// 2. Forwarder host — turns the forward decision into live fan-out over the notify transport.
			const forwarderHost = new ReactivityForwarderHost({
				transport: notify,
				selfPeerId,
				profile: reactivityProfile,
				pushStateInit: (topicId: Uint8Array, n: NotificationV1): PushStateInit => ({
					collectionId: n.collectionId,
					topicId: bytesToB64url(topicId),
					tailIdAtJoin: n.tailId,
					deltaMaxBytes: reactivityPolicy.deltaMaxBytes,
				}),
				verifierFor: (): NotificationVerifier => createNotificationVerifier({ verifier: host.service.verifier(), tier: Tier.T3 }),
				directSubscribers: (topicId: Uint8Array): string[] => {
					// Find the served reactivity engine at TREE tier 0 (see REACTIVITY_FORWARDER_TREE_TIER) and read
					// its direct-subscriber records. The adapter filters to reactivity appState and maps participantId
					// bytes → dialable peer-id strings (the transport's `peerIdFromString` space) — NOT base64url,
					// which would silently fail to dial. `undefined` (no subscriber has registered here yet) ⇒ [].
					const engine = host.registry.findServing(topicId, REACTIVITY_FORWARDER_TREE_TIER);
					return engine === undefined ? [] : reactivityDirectSubscribers(engine, topicId);
				},
				// No childCohorts until cohort-topic-parent-child-link populates PushState.childCohorts (single
				// tier-0 reach today); wire the resolver anyway. A child cohort's primary is the FRET-nearest member
				// of its coord, returned as a peer-id string (the dial space).
				resolveChildPrimary: (ref: CohortRef): string | undefined => {
					const peers = fret.assembleCohort(b64urlToBytes(ref.coord), cohortWantK);
					return peers.length > 0 ? peers[0] : undefined;
				},
				deliverLocal: (topicId: Uint8Array, n: NotificationV1): void => reactivitySubscribers.deliver(topicId, n),
			});

			// Inbound notify frames → forwarder host (subscriber role delivers in-process; forwarder role fans out).
			// NOTE: the four `register*Handler` helpers below (notify / pushStateGossip / recover /
			// matchmaking query) all call `registerProtocolHandler(...)` fire-and-forget (`void`), so a rejected
			// registration escapes the post-start rollback `catch` as an UNHANDLED rejection instead of
			// failing node creation. Harmless today — every protocol id here is a fixed constant registered
			// exactly once, so the only realistic rejection is a duplicate, and that needs a caller to pass
			// overlapping custom `cohortTopic.host.protocols`. If any of these ids ever becomes
			// caller-configurable, or a helper grows a registration that can genuinely fail, make them await
			// their `registerProtocolHandler` so the failure reaches the rollback.
			registerNotifyHandler(node, reactivityProtocols.notify, notify);
			offInboundNotify = notify.onNotification((from, n): void => { void forwarderHost.onInbound(from, n); });

			// 3. Origination emit — install onLocalCommit: a member commit builds a NotificationV1 and ingests it.
			const origination = new ReactivityOriginationManager({
				service: host.service,
				resolveContext: (event) => {
					if (event.tailId === undefined) {
						return undefined; // tail-less (read-driven promotion) never originates (the gate also returns first)
					}
					return {
						// MUST reuse the gate's `reactivityTailBytes` (utf8), NOT db-core's double-hashing
						// blockIdToBytes — else origination derives a different coord than subscribers resolve.
						tailId: reactivityTailBytes(event.tailId),
						deltaMaxBytes: reactivityPolicy.deltaMaxBytes,
						// rotationHint stays undefined on a live node: the successor tail id is not knowable at the
						// filling commit (random block ids; gated on 6.5-block-id-derivation). The authoritative,
						// observable rotation signal is `event.tailId` CHANGING, which the manager observes via the
						// `markRotated` binding below. (The pre-announce remains exercised in the mock-tier harness +
						// the design simulator, both of which can synthesize the successor id.)
					};
				},
				// reactivityNotificationTopicId(n) = reactivityTopicId(b64urlToBytes(n.tailId)); since
				// n.tailId = b64url(reactivityTailBytes(tail)), this is the SAME topicId the gate assembled coord_0
				// around and the subscriber/forwarder verifier derives — closing the encoding loop.
				emit: (n): void => { void forwarderHost.ingest(reactivityNotificationTopicId(n), n); },
				// Observe-rotation: when a collection's tail id changes between commits the OLD tail's reactivity
				// topic has rotated. Start its drain so the recover serve begins redirecting to the new tree (the
				// `reactivity-rotation-recover-redirect-drain` markRotated seam). `oldTopicId` is byte-identical to
				// the topic a subscriber subscribed under (both `reactivityTopicId(reactivityTailBytes(tail))`).
				markRotated: (oldTopicId, redirect, now): void => forwarderHost.markRotated(oldTopicId, redirect, now),
			});
			origination.install();

			// 4. PushState gossip — periodic intra-cohort convergence so any member (not just the primary) can
			// serve a replay/backfill. Rides the host's cohort gossip transport (no second transport).
			pushStateGossip = new ReactivityPushStateGossipDriver({
				gossipTransport: host.gossipTransport,
				liveCollections: (): ReactivityGossipCollection[] => forwarderHost.livePushStates().map((pushState) => ({
					pushState,
					cohortCoord: reactivityAddressing.coord0(b64urlToBytes(pushState.topicId)),
				})),
				pushStateForGossip: (g: PushStateGossipV1) => forwarderHost.pushStateFor(b64urlToBytes(g.topicId)),
				// Authenticity gate: accept gossip only from a member of the cohort around the frame's reactivity
				// coord (per-frame peer-sig envelope signing is deferred — reactivity-pushstate-gossip's hardening backlog).
				isCohortMember: (fromPeerId: string, g: PushStateGossipV1): boolean =>
					fret.assembleCohort(reactivityAddressing.coord0(b64urlToBytes(g.topicId)), cohortWantK).includes(fromPeerId),
			});
			registerPushStateGossipHandler(node, reactivityProtocols.pushStateGossip, pushStateGossip);
			pushStateGossip.start();

			// 5. Recover RPC — the pull companion to notify (docs/reactivity.md §Backfill RPC / §Resume). A
			// subscriber that detected a gap, or woke from sleep past the live tail, asks a serving cohort member
			// "what did I miss?" and is brought current over a real request-reply socket. The SERVE side is live
			// here: this node answers RecoverRequestV1 frames against its live forwarder PushStates. The OUTBOUND
			// transport + signers are constructed and exposed for the subscribe factory that CONSTRUCTS managers
			// (the Quereus Database.watch app-bridge — backlog optimystic-network-reactive-watch-integration-test);
			// no node-internal manager calls them yet, exactly as the notify subscriber side is constructed against
			// `reactivitySubscribers` rather than from a watch.
			//
			// Node-level sticky cohort-hint cache (keyed by collectionId), shared between the outbound transport's
			// sticky-primary lookup and a future manager's rotation-invalidation so both see ONE cache. It starts
			// empty ⇒ the transport falls through to the cohort-walk (any member holding the gossiped PushState
			// answers); populating the sticky primary is a one-RT optimization, not a correctness need.
			const reactivityCohortHintCache = createStickyCohortHintCache();
			// topicId → dialable cohort member peer-id strings: the SAME FRET coord_0 assembly the push-state-gossip
			// authenticity gate uses (`reactivityAddressing.coord0` → `fret.assembleCohort`), so a recover walk
			// reaches exactly the cohort that holds the topic's gossiped PushState. `assembleCohort` returns peer-id
			// strings (the recover dialer's `peerIdFromString` space), matching the notify dial-target space.
			const resolveReactivityCohort = (topicId: Uint8Array): string[] =>
				fret.assembleCohort(reactivityAddressing.coord0(topicId), cohortWantK);

			// Outbound transport: exposes the db-core BackfillTransport / ResumeTransport seams against this node.
			// maxBytes is omitted so the dialer + handler default to DEFAULT_STREAM_MAX_BYTES, matching the notify
			// transport's default (constructed above without an override) — one frame ceiling across the family.
			const recover = new Libp2pReactivityRecoverTransport({
				dialer: createLibp2pRecoverDialer(node, reactivityProtocols.recover),
				selfPeerId,
				cohortHintCache: reactivityCohortHintCache,
				resolveCohort: resolveReactivityCohort,
			});

			// Inbound serve handler: decode (bounded) → verify the dialing peer's signature → freshness/replay gate →
			// resolve the live PushState off the forwarder host → serveBackfill/serveResume → reply (no reply on any
			// failure; the stream aborts and the subscriber walks/chain-reads). One node-level replay guard is shared
			// across all recover requests — a plain pruned-on-access map, so no new timer to tear down.
			registerRecoverHandler(node, reactivityProtocols.recover, {
				pushStateFor: forwarderHost.pushStateFor.bind(forwarderHost),
				pushStateForCollection: forwarderHost.pushStateForCollection.bind(forwarderHost),
				replayGuard: createCorrelationReplayGuard(),
				rotationFor: (req, now) => {
					// Drain-window redirect: a recover reaching an OLD (rotated, still-draining) tail is bounced to
					// the new tree (reactivity-rotation-recover-redirect-drain). A resume carries the stale topic
					// (topicId = reactivityTopicId(latestKnownTailId)); a backfill carries no topic, so resolve the
					// collection's current served topic. rotationRedirectFor returns the gate's redirect while
					// draining and undefined once drained (then evicting the gate + the old tail's served PushState).
					const oldTopicId = req.topicId ?? resolveCurrentServedTopic(forwarderHost, req.collectionId);
					return oldTopicId === undefined ? undefined : forwarderHost.rotationRedirectFor(oldTopicId, now);
				},
			});

			// The subscriber's synchronous request signers over the node's Ed25519 key (resolves the recover wiring's
			// lone design point — see recover-transport.ts §createRecoverRequestSigners). Fed to a manager by the
			// subscribe factory alongside recover.backfillTransport(topicId, collectionId) /
			// recover.resumeTransport(topicId, collectionId).
			const recoverSigners = createRecoverRequestSigners(nodePrivateKey);

			// Expose the recover seams so the subscribe factory wires backfill/resume RPC + signers + the shared
			// sticky cache (mirrors `reactivitySubscribers` above).
			(node as any).reactivityRecover = recover;
			(node as any).reactivityRecoverSigners = recoverSigners;
			(node as any).reactivityCohortHintCache = reactivityCohortHintCache;

			// 6. Rotation re-registration scheduler — the host timer that moves a subscriber to the rotated tree
			// when its manager surfaces a `RotationNotice` (`reactivity-rotation-rereg-scheduler`). Constructed with
			// the default unref'd `setTimeout` timer so an idle re-registration never pins the process. The
			// `reRegister(plan)` MOVE belongs to the subscribe factory that CONSTRUCTS managers (the deferred Quereus
			// `Database.watch` bridge — backlog optimystic-network-reactive-watch-integration-test): on fire it builds
			// a fresh `ReactivitySubscriptionManager` under `plan.newTopicId` carrying `plan.lastRevision`, registers
			// it, and swaps the `ReactivitySubscriberRegistry` entry — registering the NEW-topic handler BEFORE
			// unregistering the old, so a notification mid-swap is never dropped. Until that factory lands no
			// node-internal manager drives `schedule()`, so this seam is a logged no-op — exactly as 12.33 exposed
			// `reactivitySubscribers` / `reactivityRecover` without a live manager constructor.
			reactivityRotation = new RotationReRegistrationScheduler({
				reRegister: (plan): Promise<void> => {
					reactivityWiringLog("reactivity rotation re-registration fired for successor topic=%s (lastRevision=%d) but no subscribe factory is wired yet — deferred to optimystic-network-reactive-watch-integration-test", bytesToB64url(plan.newTopicId), plan.lastRevision);
					return Promise.resolve();
				},
			});
			(node as any).reactivityRotation = reactivityRotation;

			// --- Matchmaking QueryV1 RPC — cohort serve side (docs/matchmaking.md §Seeker query) ---
			// The server half of the seeker query transport: a remote seeker dials `/optimystic/matchmaking/1.0.0/query`
			// and this node answers with its cohort's locally-held provider/seeker registrations, signed by the node
			// peer key. Matchmaking is layered ABOVE the cohort-topic substrate, so it owns its own protocol family
			// and is wired here (the composition root) over the host's PUBLIC surface only — mirroring the reactivity
			// registration above; nothing reaches into host.ts internals. The OUTBOUND seeker walk client is the
			// prereq follow-on `matchmaking-query-rpc-seeker-walk`; only the serve side is live here.
			registerMatchmakingQueryHandler(node, matchmakingProtocols.query, {
				registry: host.registry,
				// Reuse the reactivity addressing: createTierAddressing(createRingHash()) is byte-identical to the
				// host's internal addressing for the tier-0 coord (peer- and fanout-independent), and the handler
				// only ever derives coord_0(topicId).
				addressing: reactivityAddressing,
				// Single-member reply signature over the node peer key (same pattern reactivity uses for its signers).
				sign: async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(nodePrivateKey, payload)),
				// Anti-DoS rate-limit seam (backlog matchmaking-query-rate-limit) intentionally left unwired here:
				// default-allow. When that ticket lands it passes a `gate: (from, topicId) => boolean` that limits on
				// the connection's verified `from` peer (NOT the self-asserted query.requesterId).
			});
		}

		return node as unknown as OptimysticNode;
	} catch (err) {
		// Post-start rollback. node.stop() runs whatever teardown wrappers were installed BEFORE the throw
		// (each wrapper is registered next to the resource it releases, precisely so this unwinds as much as
		// exists) and closes the transports. A rollback failure must never mask the real startup error, so it
		// is logged and swallowed; `err` is what the caller sees.
		try {
			await node.stop();
		} catch (stopErr) {
			wiringLog('rollback stop failed after startup error: %o', stopErr);
		}
		throw err;
	}
}
