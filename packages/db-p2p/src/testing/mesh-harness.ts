import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { IKeyNetwork, ClusterPeers, ICluster, ClusterRecord, IRepo, BlockId, ActionRev, ClusterConsensusConfig, ITransactor, PeerId as DbPeerId } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { NetworkTransactor, DEFAULT_SUPER_MAJORITY_THRESHOLD } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { ClusterMember, clusterMember, type ReconcileBlockCallback } from '../cluster/cluster-repo.js';
import { StorageRepo } from '../storage/storage-repo.js';
import { MemoryRawStorage } from '../storage/memory-storage.js';
import { BlockStorage } from '../storage/block-storage.js';
import type { IRawStorage } from '../storage/i-raw-storage.js';
import { coordinatorRepo, type ClusterLatestCallback } from '../repo/coordinator-repo.js';
import type { CoordinatorRepo } from '../repo/coordinator-repo.js';
import { sortPeersByDistance, type KnownPeer } from '../routing/responsibility.js';
import { toString as u8ToString } from 'uint8arrays';

export interface MeshNode {
	peerId: PeerId;
	privateKey: PrivateKey;
	storageRepo: StorageRepo;
	clusterMember: ClusterMember;
	coordinatorRepo: CoordinatorRepo;
}

export interface MeshOptions {
	responsibilityK: number;
	clusterSize?: number;
	superMajorityThreshold?: number;
	allowClusterDownsize?: boolean;
	/**
	 * Optional per-node raw-storage factory. Invoked once per node (indexed from 0)
	 * to supply the IRawStorage that backs StorageRepo. If omitted, each node gets
	 * a fresh `MemoryRawStorage`. Used by fault-injection tests to wrap the store
	 * with a crashing proxy, or by restart tests to rebuild over preserved state.
	 */
	rawStorageFactory?: (index: number) => IRawStorage;
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

	async findCoordinator(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const excluded = new Set((options?.excludedPeers ?? []).map(p => p.toString()));
		const sorted = this.sortedByDistance(key);
		const pick = sorted.find(n => !excluded.has(n.peerId.toString()));
		if (!pick) {
			throw new Error('No coordinator available for key (all candidates excluded)');
		}
		return pick.peerId;
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
				publicKey: u8ToString(node.peerId.publicKey!.raw, 'base64url')
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
	keyNetwork: IKeyNetwork;
}

/**
 * Pull a block's committed content from a sibling cohort node into `storageRepo` — the mesh analogue
 * of `libp2p-node-base`'s `createReconcileBlock` (SyncClient archive fetch + `saveReplicatedBlock`).
 *
 * Deliberately shared by BOTH callers, exactly as the live node shares one callback between them: the
 * commit path (`clusterMember.reconcileBlock`, for a block committed without a materializable base)
 * and the read path (`CoordinatorRepo.acquireBlockFromCohort`, for a corroborated revision the reader
 * cannot promote locally). Stateless, so it is simply rebuilt per caller.
 *
 * `nodes` is captured by reference and is fully populated by the time either caller invokes it.
 */
const makeReconcileBlock = (nodes: MeshNode[], selfPeerId: string, storageRepo: StorageRepo): ReconcileBlockCallback =>
	async (blockId, committed, cohortPeerIds) => {
		for (const peerIdStr of cohortPeerIds) {
			if (peerIdStr === selfPeerId) continue;
			const target = nodes.find(n => n.peerId.toString() === peerIdStr);
			if (!target) continue;
			const result = await target.storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as any);
			const entry = result[blockId];
			const latest = entry?.state?.latest;
			if (!latest || !entry?.block || latest.rev < committed.rev) continue;
			await storageRepo.saveReplicatedBlock(blockId, entry.block, latest);
			return;
		}
	};

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
	let nodeIndex = 0;
	for (const { peerId, privateKey } of keyPairs) {
		const rawStorage = options.rawStorageFactory
			? options.rawStorageFactory(nodeIndex)
			: new MemoryRawStorage();
		nodeIndex++;
		const storageRepo = new StorageRepo(
			(blockId: BlockId) => new BlockStorage(blockId, rawStorage)
		);

		const consensusConfig: ClusterConsensusConfig = {
			superMajorityThreshold: options.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD,
			simpleMajorityThreshold: 0.51,
			minAbsoluteClusterSize: 2,
			allowClusterDownsize: options.allowClusterDownsize ?? true,
			clusterSizeTolerance: 0.5,
			partitionDetectionWindow: 60000,
			// Harness spins up small/single-node meshes on purpose; opt into running
			// below the safe floor without a confident network-size estimate.
			allowUnvalidatedSmallCluster: true
		};

		// Active reconciliation: when a member commits a block it never pended (cohort drift),
		// pull the committed revision from a sibling cohort node that holds it.
		const reconcileBlock = makeReconcileBlock(nodes, peerId.toString(), storageRepo);

		const member = clusterMember({
			storageRepo,
			peerNetwork,
			peerId,
			privateKey,
			consensusConfig,
			reconcileBlock
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

	for (const node of nodes) {
		// Per-node callback: reports the queried peer's latest revision, and NOTHING else. It used to
		// also write the peer's block into local storage ("simulate data sync"), which made every
		// read-repair assertion on this harness observe a convergence the production callback does not
		// provide — masking exactly the defect that ticket `read-repair-cannot-transfer-block-content`
		// existed to expose. Transfer now happens where it does in production: through
		// `acquireBlockFromCohort` below, gated on a corroborated revision.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId: PeerId, blockId: BlockId, context?): Promise<ActionRev | undefined> => {
			const target = nodes.find(n => n.peerId.equals(peerId));
			if (!target) return undefined;
			const result = await target.storageRepo.get(
				{ blockIds: [blockId], context },
				{ skipClusterFetch: true } as any
			);
			return result[blockId]?.state?.latest;
		};
		// Wrap key network to include self in findCluster (matches real Libp2pKeyPeerNetwork behavior)
		const nodeKeyNetwork: IKeyNetwork = {
			findCoordinator: (key, opts) => keyNetwork.findCoordinator(key, opts),
			async findCluster(key) {
				const peers = await keyNetwork.findCluster(key);
				const selfStr = node.peerId.toString();
				if (!(selfStr in peers)) {
					peers[selfStr] = {
						multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
						publicKey: u8ToString(node.peerId.publicKey!.raw, 'base64url')
					};
				}
				return peers;
			}
		};
		const factory = coordinatorRepo(
			nodeKeyNetwork,
			createClusterClient,
			{
				clusterSize: options.clusterSize ?? nodeCount,
				superMajorityThreshold: options.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD,
				allowClusterDownsize: options.allowClusterDownsize ?? true,
				// Harness meshes run below the safe floor on purpose; opt the coordinator
				// side into that so validateSmallCluster admits them (fails closed by default).
				allowUnvalidatedSmallCluster: true
			}
		);
		node.coordinatorRepo = factory({
			storageRepo: node.storageRepo,
			localCluster: node.clusterMember,
			localPeerId: node.peerId,
			clusterLatestCallback,
			// The read path's transfer mechanism — the same callback the member uses on the commit path,
			// mirroring how `libp2p-node-base` shares one `reconcileBlock` between both.
			acquireBlockFromCohort: makeReconcileBlock(nodes, node.peerId.toString(), node.storageRepo)
		});
	}

	return { nodes, failures, keyNetwork };
}

/**
 * The nodes the key network keeps OUT of `blockId`'s cohort — peers that receive none of the
 * block's cluster traffic, and so hold none of its content until something repairs them.
 *
 * Peer ids are generated fresh per mesh, so which node is responsible for a given block is random
 * from run to run: in a 3-node `responsibilityK: 1` mesh, `nodes[1]` is the block's sole responsible
 * peer about a third of the time, and then it receives the writer's commit directly. A test that
 * needs a genuinely non-responsible node has to ask the routing layer rather than assume an index.
 */
export async function nonResponsibleNodes(mesh: Mesh, blockId: string): Promise<MeshNode[]> {
	const cohort = await mesh.keyNetwork.findCluster(new TextEncoder().encode(blockId));
	return mesh.nodes.filter(node => !(node.peerId.toString() in cohort));
}

export interface BuildTransactorOptions {
	timeoutMs?: number;
	abortOrCancelTimeoutMs?: number;
}

/**
 * Builds a NetworkTransactor over a mesh. All nodes share the same mock
 * infrastructure so a single transactor routes to every peer via `getRepo`.
 * Suitable for solo-mesh tests; for multi-node tests prefer
 * `buildNetworkTransactors` to label "which node is driving".
 */
export const buildNetworkTransactor = (mesh: Mesh, options: BuildTransactorOptions = {}): ITransactor => {
	const repoByPeer = new Map<string, IRepo>();
	for (const node of mesh.nodes) {
		repoByPeer.set(node.peerId.toString(), node.coordinatorRepo as unknown as IRepo);
	}
	return new NetworkTransactor({
		timeoutMs: options.timeoutMs ?? 5_000,
		abortOrCancelTimeoutMs: options.abortOrCancelTimeoutMs ?? 5_000,
		keyNetwork: mesh.keyNetwork,
		getRepo: (peerId: DbPeerId) => {
			const repo = repoByPeer.get(peerId.toString());
			if (!repo) throw new Error(`Unknown peer ${peerId.toString()}`);
			return repo;
		}
	});
};

/**
 * Builds one NetworkTransactor per mesh node, keyed by peer-id string. Each
 * transactor shares the mesh's key network and peer→repo map — the separate
 * instances exist so tests can semantically say "driven by node A".
 */
export const buildNetworkTransactors = (mesh: Mesh, options: BuildTransactorOptions = {}): Map<string, ITransactor> => {
	const transactors = new Map<string, ITransactor>();
	for (const node of mesh.nodes) {
		transactors.set(node.peerId.toString(), buildNetworkTransactor(mesh, options));
	}
	return transactors;
};
