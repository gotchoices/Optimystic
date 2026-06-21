import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
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
import type { IRawStorage } from './storage/i-raw-storage.js';
import { clusterMember, type ReconcileBlockCallback, type CommitCertificateSink } from './cluster/cluster-repo.js';
import { createCommitCertStore, makeClusterCommitCertExtractor, type CommitCertStore } from './cluster/commit-cert.js';
import { coordinatorRepo } from './repo/coordinator-repo.js';
import { Libp2pKeyPeerNetwork, type NetworkMode, type NetworkStatePersistence } from './libp2p-key-network.js';
import { ClusterClient } from './cluster/client.js';
import type { IRepo, ICluster, ITransactionValidator, BlockId, ActionRev, IBlock, IBlockChangeNotifier } from '@optimystic/db-core';
import type { ITransactionStateStore } from './cluster/i-transaction-state-store.js';
import { networkManagerService } from './network/network-manager-service.js';
import { fretService, Libp2pFretService } from 'p2p-fret';
import { syncService } from './sync/service.js';
import { SyncClient } from './sync/client.js';
import type { SyncResponse } from './sync/protocol.js';
import type { ClusterLatestCallback } from './repo/coordinator-repo.js';
import { RestorationCoordinator } from './storage/restoration-coordinator-v2.js';
import { RingSelector } from './storage/ring-selector.js';
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
import { createLogger } from './logger.js';
import { PeerReputationService } from './reputation/peer-reputation.js';
import { DisputeService } from './dispute/dispute-service.js';
import { DisputeClient } from './dispute/client.js';
import type { DisputeConfig } from './dispute/types.js';

type Libp2pInit = NonNullable<Parameters<typeof createLibp2p>[0]>;
export type Libp2pTransports = NonNullable<Libp2pInit['transports']>;

/** Logger for the reactivity node-wiring (origination/forwarder/recover/rotation composition). */
const reactivityWiringLog = createLogger('reactivity-node-wiring');

/** Factory function or instance for creating raw storage */
export type RawStorageProvider = IRawStorage | (() => IRawStorage);

export type NodeOptions = {
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
	/** Storage provider - either an IRawStorage instance or a factory function. Defaults to MemoryRawStorage if not provided. */
	storage?: RawStorageProvider;
	clusterSize?: number; // desired cluster size per key
	clusterPolicy?: {
		allowDownsize?: boolean;
		sizeTolerance?: number; // acceptable relative difference (e.g. 0.5 = +/-50%)
		superMajorityThreshold?: number; // fraction of peers needed for super-majority (default: 0.67)
	};

	/** Override libp2p listen multiaddrs. */
	listenAddrs?: string[];
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

	/** Transaction validator for cluster consensus */
	validator?: ITransactionValidator;

	/** Optional persistence for network state (HWM, FRET table) across restarts */
	persistence?: NetworkStatePersistence;

	/** Dispute protocol configuration */
	dispute?: Partial<DisputeConfig>;

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
	 * Optional libp2p connection gater. The libp2p browser default denies
	 * dialing insecure WebSockets and private/loopback addresses; callers
	 * that need to dial local or unsecured bootstraps (web reference dev,
	 * Playwright e2e, RN simulators) supply a permissive gater here.
	 */
	connectionGater?: ConnectionGater;
};

function resolveStorage(provider: RawStorageProvider | undefined): IRawStorage {
	if (!provider) {
		return new MemoryRawStorage();
	}
	return typeof provider === 'function' ? provider() : provider;
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
): Promise<Libp2p> {
	const rawStorage = resolveStorage(options.storage);

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

	const clusterProxy: ICluster = {
		async update(record) {
			if (!clusterImpl) {
				throw new Error('ClusterMember not initialized');
			}
			return await clusterImpl.update(record);
		}
	};

	const repoProxy: IRepo = {
		async get(blockGets, options) {
			const target = coordinatedRepo ?? storageRepo;
			return await target.get(blockGets, options);
		},
		async pend(request, options) {
			const target = coordinatedRepo ?? storageRepo;
			return await target.pend(request, options);
		},
		async cancel(trxRef, options) {
			const target = coordinatedRepo ?? storageRepo;
			return await target.cancel(trxRef, options);
		},
		async commit(request, options) {
			const target = coordinatedRepo ?? storageRepo;
			return await target.commit(request, options);
		}
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

	const libp2pOptions: unknown = {
		start: false,
		privateKey: nodePrivateKey,
		addresses: {
			listen: listenAddrs
		},
		connectionManager: {
			autoDial: true,
			minConnections: 1,
			maxConnections: 16,
			inboundConnectionUpgradeTimeout: 10_000,
			dialQueue: { concurrency: 2, attempts: 2 }
		},
		...(options.connectionGater ? { connectionGater: options.connectionGater } : {}),
		transports,
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			identify: identify({
				protocolPrefix: `/optimystic/${options.networkName}`
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
				const serviceFactory = clusterService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					responsibilityK: options.responsibilityK ?? 1
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					cluster: clusterProxy,
					// Identity for membership scoping on the update path. peerId is a core
					// libp2p component, available at service-construction time.
					peerId: components.peerId,
					// Fallback addr resolver for redirect targets whose multiaddrs are not
					// already embedded in record.peers.
					getConnectionAddrs: (peerId: any) => {
						const conns = components.libp2p?.getConnections?.(peerId) ?? [];
						const addrs: string[] = [];
						for (const c of conns) {
							const addr = c.remoteAddr?.toString?.();
							if (addr) addrs.push(addr);
						}
						return addrs;
					}
				});
			},

			repo: (components: any) => {
				const serviceFactory = repoService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					responsibilityK: options.responsibilityK ?? 1
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
					protocolPrefix: `/optimystic/${options.networkName}`
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
					protocolPrefix: `/optimystic/${options.networkName}`
				});
				return serviceFactory({
					registrar: components.registrar,
					repo: storageRepo
				});
			},

			networkManager: (components: any) => {
				const svcFactory = networkManagerService({
					clusterSize: options.clusterSize ?? 10,
					expectedRemotes: (options.bootstrapNodes?.length ?? 0) > 0,
					allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
					clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5
				});
				const svc = svcFactory(components);
				try { (svc as any).setLibp2p?.(components.libp2p); } catch { }
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
				try { svc.setLibp2p(components.libp2p); } catch { }
				return svc;
			}
		},
		// Add bootstrap nodes as needed
		peerDiscovery: [
			...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
		],
	};

	const node = await createLibp2p(libp2pOptions as any);

	// Inject libp2p reference into services that need it before start
	try { ((node as any).services?.fret as any)?.setLibp2p?.(node); } catch { }
	try { ((node as any).services?.networkManager as any)?.setLibp2p?.(node); } catch { }
	// RepoService.checkRedirect resolves the network manager / self id / connection
	// addrs through this injected node (the components.libp2p proxy is unreliable
	// from inside a service at request time). Done before start() so the protocol
	// handler is live with a resolvable node from its first request.
	try { ((node as any).services?.repo as any)?.setLibp2p?.(node); } catch { }

	await node.start();

	// Initialize peer reputation service
	const reputation = new PeerReputationService();

	// Initialize cluster coordination components
	const networkMode: NetworkMode = (options.bootstrapNodes?.length ?? 0) > 0 ? 'joining' : 'forming';
	const keyNetwork = new Libp2pKeyPeerNetwork(node, options.clusterSize, undefined, networkMode, options.persistence, reputation);
	await keyNetwork.initFromPersistedState();
	const protocolPrefix = `/optimystic/${options.networkName}`;
	const createClusterClient = (peerId: any) => ClusterClient.create(peerId, keyNetwork, protocolPrefix);

	// Inject reputation into NetworkManagerService
	try { ((node as any).services?.networkManager as any)?.setReputation?.(reputation); } catch { }

	// Create partition detector and get FRET service
	const partitionDetector = new PartitionDetector();
	const fretSvc = (node as any).services?.fret as FretService | undefined;

	const consensusConfig = {
		superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? 0.67,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize: 2,
		allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
		clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
		partitionDetectionWindow: 60000
	};

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

	// Active reconciliation for a block this member committed without the matching pend
	// (cohort drift). Queries the commit cohort (self already excluded) for the block,
	// picks the highest revision that is at least the committed rev, and persists it via
	// the churn-replication funnel so the block is no longer under-replicated.
	const reconcileBlock: ReconcileBlockCallback = async (blockId, committed, cohortPeerIds) => {
		const targets = cohortPeerIds.filter(id => id !== node.peerId.toString());
		if (targets.length === 0) return;

		const archives = await Promise.all(targets.map(peerIdStr => fetchArchiveFromPeer(peerIdStr, blockId)));

		let best: { block: IBlock; source: ActionRev } | undefined;
		for (const archive of archives) {
			if (!archive) continue;
			const revs = Object.keys(archive.revisions).map(Number);
			if (revs.length === 0) continue;
			const maxRev = Math.max(...revs);
			if (maxRev < committed.rev) continue;
			const data = archive.revisions[maxRev];
			if (!data?.block) continue;
			if (!best || maxRev > best.source.rev) {
				best = { block: data.block, source: { actionId: data.action.actionId, rev: maxRev } };
			}
		}

		if (best) {
			await storageRepo.saveReplicatedBlock(blockId, best.block, best.source);
		}
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
		onCommitCertificate
		// `recomputeArbitratorSet` (invalidation layer-2) is intentionally NOT wired here yet: a live FRET
		// recompute needs a churn-tolerance window so it does not false-reject legitimate certificates from
		// late-joiners (a liveness regression). Until that is tuned against live topology — and the
		// cohort-topic membership-cert trust anchor (layer 3) lands — invalidation verification runs on the
		// challenger-bound set + membership + dedup (layer 1) and LOGS the residual anchoring gap. See
		// `verifyInvalidationCertificate` and `tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`.
	});

	const coordinatorRepoFactory = coordinatorRepo(
		keyNetwork,
		createClusterClient,
		{
			clusterSize: options.clusterSize ?? 10,
			...consensusConfig
		},
		fretSvc,
		reputation,
		options.transactionStateStore
	);

	// Create callback for querying cluster peers for their latest block revision
	const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context?) => {
		// Self-read short-circuit: dialling self via SyncClient is a round trip
		// with no remote on the other end, and on nodes without listen addresses
		// (solo WebSocket-only, bare-RN, etc.) the self-dial can hang the dial
		// queue. Read directly from the local storage repo instead.
		if (peerId.equals(node.peerId)) {
			try {
				const result = await storageRepo.get({ blockIds: [blockId], context });
				return result[blockId]?.state?.latest;
			} catch {
				return undefined;
			}
		}
		const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix);
		try {
			const response = await syncClient.requestBlock({ blockId, rev: undefined });
			if (response.success && response.archive) {
				const revisions = Object.keys(response.archive.revisions).map(Number);
				if (revisions.length > 0) {
					const maxRev = Math.max(...revisions);
					const revisionData = response.archive.revisions[maxRev];
					if (revisionData?.action) {
						return { actionId: revisionData.action.actionId, rev: maxRev };
					}
				}
			}
		} catch {
			// Peer may be unreachable - return undefined to skip this peer
		}
		return undefined;
	};

	coordinatedRepo = coordinatorRepoFactory({
		storageRepo,
		localCluster: clusterImpl,
		localPeerId: node.peerId,
		clusterLatestCallback
	});

	// Recover persisted transaction state before accepting new requests
	if (options.transactionStateStore) {
		await (clusterImpl as import('./cluster/cluster-repo.js').ClusterMember).recoverTransactions();
		await (coordinatedRepo as import('./repo/coordinator-repo.js').CoordinatorRepo).recoverTransactions();
	}

	// Initialize Arachnode ring membership and restoration
	const enableArachnode = options.arachnode?.enableRingZulu ?? true;
	if (enableArachnode) {
		const log = (node as any).logger?.forComponent?.('db-p2p:arachnode');
		const fret = (node as any).services?.fret as any;

		if (fret) {
			const fretAdapter = new ArachnodeFretAdapter(fret);

			const storageMonitor = new StorageMonitor(rawStorage, options.arachnode?.storage ?? {});
			const ringSelector = new RingSelector(fretAdapter, storageMonitor, {
				minCapacity: 100 * 1024 * 1024,
				thresholds: {
					moveOut: 0.85,
					moveIn: 0.40
				}
			});

			// Determine and announce ring membership
			const peerId = node.peerId.toString();
			const arachnodeInfo = await ringSelector.createArachnodeInfo(peerId);
			fretAdapter.setArachnodeInfo(arachnodeInfo);

			log?.('Announced Arachnode membership: Ring %d', arachnodeInfo.ringDepth);

			// Setup restoration coordinator with FRET adapter
			const restorationCoordinatorV2 = new RestorationCoordinator(
				fretAdapter,
				{ connect: (pid, protocol) => node.dialProtocol(pid as Parameters<typeof node.dialProtocol>[0], [protocol]) },
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

			// Monitor capacity and adjust ring periodically
			const monitorInterval = setInterval(async () => {
				const transition = await ringSelector.shouldTransition();
				if (transition.shouldMove) {
					log?.('Ring transition needed: moving %s to Ring %d', transition.direction, transition.newRingDepth);

					// Update Arachnode info with new ring
					const updatedInfo = await ringSelector.createArachnodeInfo(peerId);
					fretAdapter.setArachnodeInfo(updatedInfo);
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
			selectArbitrators: async (blockId: string, excludePeers: string[], count: number) => {
				const { hashKey: fretHashKey } = await import('p2p-fret');
				const blockIdBytes = new TextEncoder().encode(blockId);
				const fret = (node as any).services?.fret as FretService | undefined;
				if (!fret) return [];
				// Get a larger cohort and exclude the original cluster peers
				const cohortSize = count + excludePeers.length + 1;
				const hashedCoord = await fretHashKey(blockIdBytes);
				const allPeerIdStrs = fret.assembleCohort(hashedCoord, cohortSize) as string[];
				// Filter out original cluster peers and self, convert to PeerId
				const excludeSet = new Set(excludePeers);
				excludeSet.add(node.peerId.toString());
				const arbitratorPeerIds = allPeerIdStrs
					.filter(pid => !excludeSet.has(pid))
					.slice(0, count)
					.map(pid => peerIdFromString(pid));
				return arbitratorPeerIds;
			},
		});
	}

	// Cleanup cluster member intervals on node stop
	{
		const previousStop = node.stop.bind(node);
		node.stop = async () => {
			(clusterImpl as import('./cluster/cluster-repo.js').ClusterMember).dispose();
			await previousStop();
		};
	}

	// Expose coordinated repo and storage for external use
	(node as any).coordinatedRepo = coordinatedRepo;
	(node as any).storageRepo = storageRepo;
	// The StorageRepo is the single commit funnel for both the coordinated and
	// direct paths, so it is the node's per-collection change-notifier origin. This is the
	// default; the cohort-topic activation block below REPLACES it with the origination-decorating
	// bridge notifier when the substrate is enabled.
	(node as any).blockChangeNotifier = storageRepo;
	(node as any).keyNetwork = keyNetwork;
	(node as any).reputation = reputation;
	(node as any).disputeService = disputeServiceInstance;

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
			// The node has already started (transports open, FRET running), so tear it down before the
			// hard-fail rather than leaking a started node + open transports on the rejection.
			await node.stop();
			throw new Error('cohortTopic enabled but the FRET service is unavailable on the node');
		}

		// A host-construction failure also hard-fails (operator opted in); stop the started node first so
		// the rejection does not leak open transports / a running FRET service. node.stop() runs the
		// already-installed arachnode + clusterMember teardown wrappers and closes the node's connections.
		let host: Awaited<ReturnType<typeof createCohortTopicHost>>;
		try {
			host = await createCohortTopicHost(node, fret, {
				...(options.cohortTopic!.host ?? {}),
				// Wire the node's reputation service in as the production backing for the bootstrap-evidence
				// referee verifier (the `{ isBanned, getScore }` view `PeerReputationService` satisfies), so a
				// configured cohort genuinely gates cold-root `bootstrap: true` (PoW always; reputation when a
				// referee endorsement is offered). The node service is the *default* backing — a caller that
				// supplies its own `antiDos.reputation` (or any other `antiDos` override) still wins, since the
				// caller spread comes last.
				antiDos: { reputation, ...(options.cohortTopic!.host?.antiDos) },
				privateKey: nodePrivateKey, // real k − x threshold signing
				wantK: cohortWantK,
			});
		} catch (err) {
			await node.stop();
			throw err;
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

		const { unsubscribe } = attachCohortChangeBridge(
			node as unknown as { blockChangeNotifier?: IBlockChangeNotifier },
			{
				source: storageRepo,
				service: host.service,
				selfIsCohortMember,
				extractCommitCert: makeClusterCommitCertExtractor(certStore!),
			},
		);

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
		const reactivityProtocols = DEFAULT_REACTIVITY_PROTOCOLS;
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
		registerNotifyHandler(node, reactivityProtocols.notify, notify);
		const offInboundNotify = notify.onNotification((from, n): void => { void forwarderHost.onInbound(from, n); });

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
		const pushStateGossip = new ReactivityPushStateGossipDriver({
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
		const reactivityRotation = new RotationReRegistrationScheduler({
			reRegister: (plan): Promise<void> => {
				reactivityWiringLog("reactivity rotation re-registration fired for successor topic=%s (lastRevision=%d) but no subscribe factory is wired yet — deferred to optimystic-network-reactive-watch-integration-test", bytesToB64url(plan.newTopicId), plan.lastRevision);
				return Promise.resolve();
			},
		});
		(node as any).reactivityRotation = reactivityRotation;

		// Teardown: release reactivity timers + protocol handlers BEFORE host.stop() (which clears the cohort
		// gossip timer + unhandles the cohort-topic protocols) BEFORE the node's transports close (previousStop).
		// Composes with the existing arachnode + clusterMember stop wrappers (each calls its captured previousStop last).
		const previousStop = node.stop.bind(node);
		node.stop = async (): Promise<void> => {
			try {
				reactivityRotation.stop();
				pushStateGossip.stop();
				offInboundNotify();
				await node.unhandle(reactivityProtocolList(reactivityProtocols));
				unsubscribe();
				await host.stop();
			} finally {
				await previousStop();
			}
		};
	}

	return node;
}
