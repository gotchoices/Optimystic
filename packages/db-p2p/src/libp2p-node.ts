import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
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
import { getPeerNetwork } from './network/get-network-manager.js';
import { fretService } from './fret/service.js';

export type NodeOptions = {
	port: number;
	bootstrapNodes: string[];
	networkName: string;
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
	storageType?: 'memory' | 'file'; // storage backend type
	storagePath?: string; // path for file storage (required if storageType is 'file')
	dhtClientMode?: boolean; // run DHT in client mode (no provider/hosting)
	dhtKBucketSize?: number; // DHT k-bucket size
  clusterSize?: number; // desired cluster size per key
};

export async function createLibp2pNode(options: NodeOptions): Promise<Libp2p> {
	// TODO: continue to build this out per: https://github.com/ipfs/helia/blob/main/packages/helia/src/utils/libp2p-defaults.ts
	// TODO: if no id is provided, try to load from keychain?: https://github.com/ipfs/helia/blob/main/packages/helia/src/utils/libp2p.ts

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
      dht: kadDHT({
        protocol: `/p2p/${options.networkName}/kad/1.0.0`,
        clientMode: options.dhtClientMode ?? false,
        kBucketSize: options.dhtKBucketSize ?? 10,
        // In small meshes, allow queries before the table is populated
        allowQueryWithZeroPeers: true,
        // Prime self-queries quickly to seed the table
        initialQuerySelfInterval: 500,
        querySelfInterval: 10_000
      }),
			pubsub: gossipsub(),

			// Custom services - create wrapper factories that inject dependencies
      cluster: (components: any) => {
        const serviceFactory = clusterService({
          protocolPrefix: `/db-p2p`,
          kBucketSize: options.dhtKBucketSize ?? 10
        });
				return serviceFactory({
					logger: components.logger,
					registrar: components.registrar,
					cluster: clusterLogic
				});
			},

      repo: (components: any) => {
        const serviceFactory = repoService({
          protocolPrefix: `/db-p2p`,
          kBucketSize: options.dhtKBucketSize ?? 10
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
      }
			,
			fret: (components: any) => {
				const factory = fretService({ clusterSize: options.clusterSize ?? 10 })
				return factory(components)
			}
		},
		// Add bootstrap nodes as needed
		peerDiscovery: [
			...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
		],
	};

	const node = await createLibp2p(libp2pOptions);

	await node.start();

	// Proactively dial bootstrap nodes to speed up connectivity and seed DHT
	if (options.bootstrapNodes?.length) {
		const log = (node as any).logger?.forComponent?.('db-p2p:bootstrap-dial');
		for (const addr of options.bootstrapNodes) {
			try {
				await node.dial(multiaddr(addr));
			} catch (e) {
				log?.warn?.('dial to bootstrap %s failed: %o', addr, e);
			}
		}
		// Retry a few times if peer store has no remotes yet
		try {
			for (let i = 0; i < 5; i++) {
				const peers: Array<{ id: any }> = (node as any).peerStore.getPeers() ?? [];
				const remotes = peers.filter(p => p.id.toString() !== (node as any).peerId.toString());
				if (remotes.length > 0) break;
				await new Promise(r => setTimeout(r, 400));
				for (const addr of options.bootstrapNodes) {
					try { await node.dial(multiaddr(addr)); } catch {}
				}
			}
		} catch {}
	}

	// Best-effort: ask DHT to refresh routing table if supported
	try { (node as any).services?.dht?.refreshRoutingTable?.(); } catch {}

	// Provide peer network adapter for protocol clients
	try { (node as any).peerNetwork = getPeerNetwork(node) } catch {}
	// Provide libp2p to custom services that accept it
	try { (node as any).services?.networkManager?.setLibp2p?.(node) } catch {}
	try { (node as any).services?.fret?.setLibp2p?.(node) } catch {}
	return node;
}
