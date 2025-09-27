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

export type NodeOptions = {
	port: number;
	bootstrapNodes: string[];
	networkName: string;
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
	storageType?: 'memory' | 'file'; // storage backend type
	storagePath?: string; // path for file storage (required if storageType is 'file')
	clusterSize?: number; // desired cluster size per key
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

	// Create shared storage layers
	const storageRepo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));

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
		...(peerId ? { peerId } : {}),
		addresses: {
			listen: [`/ip4/0.0.0.0/tcp/${options.port}`]
		},
		connectionManager: { autoDial: true },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			identify: identify({
				protocolPrefix: `/p2p/${options.networkName}`
			}),
			ping: ping(),
			pubsub: gossipsub(),

			// Custom services - create wrapper factories that inject dependencies
			cluster: (components: any) => {
				const serviceFactory = clusterService({
					protocolPrefix: `/db-p2p`
				});
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					cluster: clusterLogic
				});
			},

			repo: (components: any) => {
				const serviceFactory = repoService({
					protocolPrefix: `/db-p2p`
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
				})
				return svcFactory(components)
			},
			fret: fretService({ k: 15, m: 8, capacity: 2048, profile: (options.bootstrapNodes?.length ?? 0) > 0 ? 'core' : 'edge' })
		},
		// Add bootstrap nodes as needed
		peerDiscovery: [
			...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
		],
	};

	const node = await createLibp2p(libp2pOptions);

	await node.start();

	// Proactively dial bootstrap nodes to speed up connectivity
	if (options.bootstrapNodes?.length) {
		const log = (node as any).logger?.forComponent?.('db-p2p:bootstrap-dial');
		for (const addr of options.bootstrapNodes) {
			try {
				await node.dial(multiaddr(addr));
			} catch (e) {
				log?.warn?.('dial to bootstrap %s failed: %o', addr, e);
			}
		}
	}

	return node;
}
