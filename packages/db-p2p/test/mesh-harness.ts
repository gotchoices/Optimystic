import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { IKeyNetwork, ClusterPeers, ICluster, ClusterRecord, IRepo, BlockId, ActionRev } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { coordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { sortPeersByDistance, type KnownPeer } from '../src/routing/responsibility.js';

export interface MeshNode {
	peerId: PeerId;
	privateKey: PrivateKey;
	storageRepo: IRepo;
	clusterMember: ClusterMember;
	coordinatorRepo: CoordinatorRepo;
}

export interface MeshOptions {
	responsibilityK: number;
	clusterSize?: number;
	superMajorityThreshold?: number;
	allowClusterDownsize?: boolean;
}

export interface MeshFailureConfig {
	/** Peers that should fail on cluster update (simulate unreachable) */
	failingPeers?: Set<string>;
	/** Make findCluster return empty (simulate DHT failure) */
	findClusterFails?: boolean;
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> {
		return {};
	}
}

/**
 * Mock IKeyNetwork that returns peers based on XOR distance.
 * With responsibilityK >= nodeCount, all nodes are returned.
 * Otherwise, K-nearest by XOR distance are returned.
 */
class MockMeshKeyNetwork implements IKeyNetwork {
	constructor(
		private readonly nodes: MeshNode[],
		private readonly responsibilityK: number,
		private readonly failures: MeshFailureConfig = {}
	) {}

	async findCoordinator<T>(key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const sorted = this.sortedByDistance(key);
		return sorted[0]!.peerId;
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		if (this.failures.findClusterFails) {
			return {} as ClusterPeers;
		}

		const sorted = this.sortedByDistance(key);
		const k = Math.min(this.responsibilityK, sorted.length);
		const selected = sorted.slice(0, k);

		const peers: ClusterPeers = {};
		for (const node of selected) {
			peers[node.peerId.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: node.peerId.publicKey!.raw
			};
		}
		return peers;
	}

	private sortedByDistance(key: Uint8Array): MeshNode[] {
		const knownPeers: KnownPeer[] = this.nodes.map(n => ({
			id: n.peerId,
			addrs: ['/ip4/127.0.0.1/tcp/8000']
		}));
		const sorted = sortPeersByDistance(knownPeers, key);
		return sorted.map(kp => this.nodes.find(n => n.peerId.equals(kp.id))!);
	}
}

export interface Mesh {
	nodes: MeshNode[];
	failures: MeshFailureConfig;
}

/**
 * Creates N interconnected mesh nodes with real components and mock transport.
 * ClusterClient calls route directly to target ClusterMember instances.
 */
export async function createMesh(nodeCount: number, options: MeshOptions): Promise<Mesh> {
	const failures: MeshFailureConfig = {};

	// Generate key pairs for all nodes
	const keyPairs = await Promise.all(
		Array.from({ length: nodeCount }, async () => {
			const privateKey = await generateKeyPair('Ed25519');
			return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
		})
	);

	// Build nodes array (partially — coordinatorRepo added after keyNetwork is ready)
	const nodes: MeshNode[] = [];
	const peerNetwork = new MockPeerNetwork();

	// Phase 1: create storage + cluster members
	for (const { peerId, privateKey } of keyPairs) {
		const rawStorage = new MemoryRawStorage();
		const storageRepo = new StorageRepo(
			(blockId: BlockId) => new BlockStorage(blockId, rawStorage)
		);

		const member = clusterMember({
			storageRepo,
			peerNetwork,
			peerId,
			privateKey
		});

		nodes.push({
			peerId,
			privateKey,
			storageRepo,
			clusterMember: member,
			coordinatorRepo: undefined as any // filled in phase 2
		});
	}

	// Phase 2: create key network and coordinator repos (needs all nodes for routing)
	const keyNetwork = new MockMeshKeyNetwork(nodes, options.responsibilityK, failures);

	const createClusterClient = (targetPeerId: PeerId): ICluster => {
		const target = nodes.find(n => n.peerId.equals(targetPeerId));
		if (!target) {
			throw new Error(`Unknown peer: ${targetPeerId.toString()}`);
		}
		return {
			async update(record: ClusterRecord): Promise<ClusterRecord> {
				if (failures.failingPeers?.has(targetPeerId.toString())) {
					throw new Error(`Peer ${targetPeerId.toString()} is unreachable`);
				}
				return target.clusterMember.update(record);
			}
		};
	};

	const clusterLatestCallback: ClusterLatestCallback = async (peerId: PeerId, blockId: BlockId): Promise<ActionRev | undefined> => {
		const target = nodes.find(n => n.peerId.equals(peerId));
		if (!target) return undefined;
		const result = await target.storageRepo.get(
			{ blockIds: [blockId] },
			{ skipClusterFetch: true } as any
		);
		return result[blockId]?.state?.latest;
	};

	for (const node of nodes) {
		const factory = coordinatorRepo(
			keyNetwork,
			(peerId: PeerId) => createClusterClient(peerId) as any,
			{
				clusterSize: options.clusterSize ?? nodeCount,
				superMajorityThreshold: options.superMajorityThreshold ?? 0.75,
				allowClusterDownsize: options.allowClusterDownsize ?? true
			}
		);
		node.coordinatorRepo = factory({
			storageRepo: node.storageRepo,
			localCluster: node.clusterMember,
			localPeerId: node.peerId,
			clusterLatestCallback
		});
	}

	return { nodes, failures };
}
