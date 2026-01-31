import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { peerIdFromString } from '@libp2p/peer-id';
import { clusterService } from './cluster/service.js';
import { repoService } from './repo/service.js';
import { StorageRepo } from './storage/storage-repo.js';
import { BlockStorage } from './storage/block-storage.js';
import { MemoryRawStorage } from './storage/memory-storage.js';
import type { IRawStorage } from './storage/i-raw-storage.js';
import { clusterMember } from './cluster/cluster-repo.js';
import { coordinatorRepo } from './repo/coordinator-repo.js';
import { Libp2pKeyPeerNetwork } from './libp2p-key-network.js';
import { ClusterClient } from './cluster/client.js';
import type { IRepo, ICluster, ITransactionValidator } from '@optimystic/db-core';
import { networkManagerService } from './network/network-manager-service.js';
import { fretService, Libp2pFretService } from 'p2p-fret';
import { syncService } from './sync/service.js';
import { SyncClient } from './sync/client.js';
import type { ClusterLatestCallback } from './repo/coordinator-repo.js';
import { RestorationCoordinator } from './storage/restoration-coordinator-v2.js';
import { RingSelector } from './storage/ring-selector.js';
import { StorageMonitor } from './storage/storage-monitor.js';
import type { StorageMonitorConfig } from './storage/storage-monitor.js';
import { ArachnodeFretAdapter } from './storage/arachnode-fret-adapter.js';
import type { RestoreCallback } from './storage/struct.js';
import type { FretService } from 'p2p-fret';
import { PartitionDetector } from './cluster/partition-detector.js';

/** Factory function or instance for creating raw storage */
export type RawStorageProvider = IRawStorage | (() => IRawStorage);

export type NodeOptions = {
	port: number;
	bootstrapNodes: string[];
	networkName: string;
	fretProfile?: 'edge' | 'core';
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
	/** Storage provider - either an IRawStorage instance or a factory function. Defaults to MemoryRawStorage if not provided. */
	storage?: RawStorageProvider;
	clusterSize?: number; // desired cluster size per key
	clusterPolicy?: {
		allowDownsize?: boolean;
		sizeTolerance?: number; // acceptable relative difference (e.g. 0.5 = +/-50%)
		superMajorityThreshold?: number; // fraction of peers needed for super-majority (default: 0.67)
	};

	/**
	 * Responsibility K - the replica set size for determining cluster membership.
	 * This is distinct from kBucketSize (DHT routing) and clusterSize (consensus quorum).
	 * When a node receives a request, it checks if it's in the top responsibilityK
	 * peers (by XOR distance) for the key. If not, it redirects to closer peers.
	 * Default: 1 (only the closest peer is responsible)
	 */
	responsibilityK?: number;

	/** Arachnode storage configuration */
	arachnode?: {
		enableRingZulu?: boolean; // default: true
		storage?: StorageMonitorConfig;
	};

	/** Transaction validator for cluster consensus */
	validator?: ITransactionValidator;
};

function resolveStorage(provider: RawStorageProvider | undefined): IRawStorage {
	if (!provider) {
		return new MemoryRawStorage();
	}
	return typeof provider === 'function' ? provider() : provider;
}

export async function createLibp2pNode(options: NodeOptions): Promise<Libp2p> {
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

	// Parse peer ID if provided
	const peerId = options.id ? await peerIdFromString(options.id) : undefined;

	const libp2pOptions: any = {
		start: false,
		...(peerId ? { peerId } : {}),
		addresses: {
			listen: [`/ip4/0.0.0.0/tcp/${options.port}`]
		},
		connectionManager: {
			autoDial: true,
			minConnections: 1,
			maxConnections: 16,
			inboundConnectionUpgradeTimeout: 10_000,
			dialQueue: { concurrency: 2, attempts: 2 }
		},
		// Add circuitRelayTransport so this node can dial through relays
		transports: [tcp(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			identify: identify({
				protocolPrefix: `/optimystic/${options.networkName}`
			}),
			ping: ping(),
			pubsub: gossipsub({
				allowPublishToZeroTopicPeers: true,
				heartbeatInterval: 7000
			}),
			// Circuit relay server - enables this node to relay connections for other peers
			...(options.relay ? { relay: circuitRelayServer() } : {}),

			// Custom services - create wrapper factories that inject dependencies
			cluster: (components: any) => {
				const serviceFactory = clusterService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					configuredClusterSize: options.clusterSize ?? 10,
					allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
					clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
					responsibilityK: options.responsibilityK ?? 1
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					cluster: clusterProxy
				});
			},

			repo: (components: any) => {
				const serviceFactory = repoService({
					protocolPrefix: `/optimystic/${options.networkName}`,
					responsibilityK: options.responsibilityK ?? 1
				});
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

			networkManager: (components: any) => {
				const svcFactory = networkManagerService({
					clusterSize: options.clusterSize ?? 10,
					expectedRemotes: (options.bootstrapNodes?.length ?? 0) > 0,
					allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
					clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5
				})
				const svc = svcFactory(components)
				try { (svc as any).setLibp2p?.(components.libp2p) } catch { }
				return svc
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

	const node = await createLibp2p(libp2pOptions);

	// Inject libp2p reference into services that need it before start
	try { ((node as any).services?.fret as any)?.setLibp2p?.(node) } catch { }
	try { ((node as any).services?.networkManager as any)?.setLibp2p?.(node) } catch { }

	await node.start();

	// Initialize cluster coordination components
	const keyNetwork = new Libp2pKeyPeerNetwork(node);
	const protocolPrefix = `/optimystic/${options.networkName}`;
	const createClusterClient = (peerId: any) => ClusterClient.create(peerId, keyNetwork, protocolPrefix);

	// Create partition detector and get FRET service
	const partitionDetector = new PartitionDetector();
	const fretSvc = (node as any).services?.fret as FretService | undefined;

	clusterImpl = clusterMember({
		storageRepo,
		peerNetwork: keyNetwork,
		peerId: node.peerId,
		protocolPrefix,
		partitionDetector,
		fretService: fretSvc,
		validator: options.validator
	});

	const coordinatorRepoFactory = coordinatorRepo(
		keyNetwork,
		createClusterClient,
		{
			clusterSize: options.clusterSize ?? 10,
			superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? 0.67,
			simpleMajorityThreshold: 0.51,
			minAbsoluteClusterSize: 2,     // Allow 2-node clusters for development/small networks
			allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
			clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
			partitionDetectionWindow: 60000
		},
		fretSvc
	);

	// Create callback for querying cluster peers for their latest block revision
	const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId) => {
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

	// Initialize Arachnode ring membership and restoration
	const enableArachnode = options.arachnode?.enableRingZulu ?? true;
	if (enableArachnode) {
		const log = (node as any).logger?.forComponent?.('db-p2p:arachnode');
		const fret = (node as any).services?.fret as any;

		if (fret) {
			const fretAdapter = new ArachnodeFretAdapter(fret);

			const storageMonitor = new StorageMonitor(rawStorage, options.arachnode?.storage ?? {});
			const ringSelector = new RingSelector(fretAdapter, storageMonitor, {
				minCapacity: 100 * 1024 * 1024, // 100MB minimum
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
				{ connect: (pid, protocol) => node.dialProtocol(pid, [protocol]) },
				`/optimystic/${options.networkName}`
			);

			// Update restore callback to use new coordinator
			const newRestoreCallback: RestoreCallback = async (blockId, rev?) => {
				return await restorationCoordinatorV2.restore(blockId, rev);
			};

			// Replace the restore callback (this is a bit hacky, but works for now)
			// In production, we'd want to properly manage this
			(storageRepo as any).createBlockStorage = (blockId: string) =>
				new BlockStorage(blockId, rawStorage, newRestoreCallback);

			// Monitor capacity and adjust ring periodically
			const monitorInterval = setInterval(async () => {
				const transition = await ringSelector.shouldTransition();
				if (transition.shouldMove) {
					log?.('Ring transition needed: moving %s to Ring %d',
						transition.direction, transition.newRingDepth);

					// Update Arachnode info with new ring
					const updatedInfo = await ringSelector.createArachnodeInfo(peerId);
					fretAdapter.setArachnodeInfo(updatedInfo);
				}
			}, 60_000); // Check every minute

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

	// Skip proactive bootstrap dials; rely on discovery and minimal churn

	// Expose coordinated repo and storage for external use
	(node as any).coordinatedRepo = coordinatedRepo;
	(node as any).storageRepo = storageRepo;
	(node as any).keyNetwork = keyNetwork;

	return node;
}
