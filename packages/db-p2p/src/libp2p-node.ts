import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { peerIdFromString } from '@libp2p/peer-id';
import { clusterService } from './cluster/service.js';
import { repoService } from './repo/service.js';
import { StorageRepo } from './storage/storage-repo.js';
import { BlockStorage } from './storage/block-storage.js';
import { MemoryRawStorage } from './storage/memory-storage.js';
import { FileRawStorage } from './storage/file-storage.js';
import type { IRawStorage } from './storage/i-raw-storage.js';
import { multiaddr } from '@multiformats/multiaddr';
import { networkManagerService } from './network/network-manager-service.js';
import { fretService } from '@optimystic/fret';
import { syncService } from './sync/service.js';
import { RestorationCoordinator } from './storage/restoration-coordinator-v2.js';
import { RingSelector } from './storage/ring-selector.js';
import { StorageMonitor } from './storage/storage-monitor.js';
import type { StorageMonitorConfig } from './storage/storage-monitor.js';
import { ArachnodeFretAdapter } from './storage/arachnode-fret-adapter.js';
import type { RestoreCallback } from './storage/struct.js';
import type { FretService } from '@optimystic/fret';

export type NodeOptions = {
	port: number;
	bootstrapNodes: string[];
	networkName: string;
	fretProfile?: 'edge' | 'core';
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
	storageType?: 'memory' | 'file'; // storage backend type
	storagePath?: string; // path for file storage (required if storageType is 'file')
	clusterSize?: number; // desired cluster size per key

	/** Arachnode storage configuration */
	arachnode?: {
		enableRingZulu?: boolean; // default: true
		storage?: StorageMonitorConfig;
	};
};

export async function createLibp2pNode(options: NodeOptions): Promise<Libp2p> {
	// Create storage based on type
	const storageType = options.storageType ?? 'memory';
	let rawStorage: IRawStorage;

	if (storageType === 'file') {
		if (!options.storagePath) {
			throw new Error('storagePath is required when storageType is "file"');
		}
		rawStorage = new FileRawStorage(options.storagePath);
	} else {
		rawStorage = new MemoryRawStorage();
	}

	// Create placeholder restore callback (will be replaced after node starts)
	let restoreCallback: RestoreCallback = async (_blockId, _rev?) => {
		return undefined;
	};

	// Create shared storage layers with restoration callback
	const storageRepo = new StorageRepo((blockId) =>
		new BlockStorage(blockId, rawStorage, restoreCallback)
	);

	// Create cluster member logic
	const clusterLogic = {
		async update(record: any) {
			// Simple implementation for single node - just return the record
			// In a real multi-node setup, this would implement consensus logic
			return record;
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
			autoDial: false,
			minConnections: 1,
			maxConnections: 16,
			inboundConnectionUpgradeTimeout: 10_000,
			dialQueue: { concurrency: 2, attempts: 2 }
		},
		transports: [tcp()],
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

			// Custom services - create wrapper factories that inject dependencies
			cluster: (components: any) => {
				const serviceFactory = clusterService({
					protocolPrefix: `/optimystic/${options.networkName}`
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					cluster: clusterLogic
				});
			},

			repo: (components: any) => {
				const serviceFactory = repoService({
					protocolPrefix: `/optimystic/${options.networkName}`
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					repo: storageRepo
				});
			},

			sync: (components: any) => {
				const serviceFactory = syncService({
					protocolPrefix: `/optimystic/${options.networkName}`
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					repo: storageRepo
				});
			},

			networkManager: (components: any) => {
				const svcFactory = networkManagerService({
					clusterSize: options.clusterSize ?? 10,
					expectedRemotes: (options.bootstrapNodes?.length ?? 0) > 0
				});
				return svcFactory(components);
			},
			fret: fretService({
				k: 15,
				m: 8,
				capacity: 2048,
				profile: options.fretProfile ?? 'edge',
				networkName: options.networkName,
				bootstraps: options.bootstrapNodes ?? []
			})
		},
		// Add bootstrap nodes as needed
		peerDiscovery: [
			...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
		],
	};

	const node = await createLibp2p(libp2pOptions);

	const fretServiceInstance = (node as any).services?.fret;
	if (fretServiceInstance?.setLibp2p) {
		fretServiceInstance.setLibp2p(node);
	}

	const networkManager = (node as any).services?.networkManager;
	if (networkManager?.setLibp2p) {
		networkManager.setLibp2p(node);
	}

	await node.start();

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

	return node;
}
