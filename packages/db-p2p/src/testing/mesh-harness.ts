import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { IKeyNetwork, ClusterPeers, ICluster, ClusterRecord, IRepo, BlockId, ActionRev, ITransactor, PeerId as DbPeerId } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { NetworkTransactor } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { ClusterMember, clusterMember, type ReconcileBlockCallback } from '../cluster/cluster-repo.js';
import { createReconcileBlock } from '../cluster/reconcile-block.js';
import { resolveClusterPolicy, type ClusterPolicyOptions } from '../cluster/cluster-policy.js';
import { StorageRepo } from '../storage/storage-repo.js';
import { MemoryRawStorage } from '../storage/memory-storage.js';
import { BlockStorage } from '../storage/block-storage.js';
import type { IRawStorage } from '../storage/i-raw-storage.js';
import type { BlockArchive } from '../storage/struct.js';
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
	/**
	 * Replication factor. OMITTED now means what it means in production: the operator declared
	 * nothing, so it resolves to `DEFAULT_CLUSTER_SIZE` (10) — NOT to `nodeCount`. An undeclared
	 * two-node mesh therefore measures its repair corroboration floor against 10 and can never
	 * repair (see `resolveClusterPolicy` in `cluster/cluster-policy.ts`); a mesh that genuinely is
	 * its node count must say so, exactly as a real deployment must.
	 */
	clusterSize?: number;
	/**
	 * Passed through to `resolveClusterPolicy` verbatim; this is how a mesh declares its real
	 * cohort size (`assumedClusterSize`), downsize policy, or small-cluster opt-in. When both a
	 * legacy top-level field and the matching entry here are given, the entry here wins — it is
	 * the production-shaped one.
	 */
	clusterPolicy?: ClusterPolicyOptions['clusterPolicy'];
	/** Legacy shorthand for `clusterPolicy.superMajorityThreshold`. */
	superMajorityThreshold?: number;
	/** Legacy shorthand for `clusterPolicy.allowDownsize`. */
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
	/**
	 * Peers that are unreachable on the READ path: their latest-revision consult
	 * (`ClusterLatestCallback`) REJECTS — silence the coordinator must count as "did not
	 * answer", never as the peer claiming absence — and the reconcile/acquire transfer skips
	 * them as a source. Distinct from `failingPeers`, which fails cluster (write) updates.
	 */
	silentPeers?: Set<string>;
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
 * One cohort peer's archive for a block, read straight from the sibling's `StorageRepo` — the mesh
 * analogue of `libp2p-node-base`'s `fetchArchiveFromPeer` (a SyncClient round trip). The archive
 * shape mirrors `SyncService.buildArchive` (`src/sync/service.ts`) — the thing the production fetch
 * actually receives over the wire — so the two cannot drift: `createReconcileBlock` reads only
 * `revisions[rev].action.actionId` and `revisions[rev].block`, but the `transform` filler is
 * produced the way the sync service produces it rather than invented here.
 *
 * A silent peer serves no bytes either. `undefined` is the right answer: reconcile's `no-archive`
 * outcome deliberately conflates unreachable with holds-nothing, and the production
 * `fetchArchiveFromPeer` swallows every dial failure into the same `undefined`. (Contrast the read
 * path's latest-revision consult, where silence REJECTS — the coordinator counts "did not answer"
 * separately from "holds nothing".)
 *
 * `nodes` is captured by reference and is fully populated by the time this is invoked.
 */
const makeFetchArchive = (nodes: MeshNode[], selfPeerId: string, failures: MeshFailureConfig) =>
	async (peerIdStr: string, blockId: BlockId): Promise<BlockArchive | undefined> => {
		if (peerIdStr === selfPeerId) return undefined;
		if (failures.silentPeers?.has(peerIdStr)) return undefined;
		const target = nodes.find(n => n.peerId.toString() === peerIdStr);
		if (!target) return undefined;
		const result = await target.storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as any);
		const entry = result[blockId];
		const latest = entry?.state?.latest;
		if (!latest || !entry?.block) return undefined;
		return {
			blockId,
			revisions: {
				[latest.rev]: {
					action: { actionId: latest.actionId, transform: { insert: entry.block } },
					block: entry.block
				}
			},
			range: [latest.rev, latest.rev + 1]
		};
	};

/**
 * Creates N interconnected mesh nodes with real components and mock transport.
 * ClusterClient calls route directly to target ClusterMember instances.
 */
export async function createMesh(nodeCount: number, options: MeshOptions): Promise<Mesh> {
	const failures: MeshFailureConfig = {};

	// Resolve the operator-facing knobs through the SAME function a real node's composition root
	// uses (`libp2p-node-base.ts`), then hand the one resolved object to both consumers per node —
	// the cluster member and the coordinator — exactly as production does. Resolved once per mesh
	// rather than per node: same input, same numbers, and the resolver's one-line
	// `repair-fault-tolerance` advisory fires once instead of N times.
	//
	// Precedence: an explicit `clusterPolicy` entry wins over the matching legacy top-level field —
	// the entry is the production-shaped one.
	const policy = resolveClusterPolicy({
		clusterSize: options.clusterSize,
		clusterPolicy: {
			...options.clusterPolicy,
			superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? options.superMajorityThreshold,
			allowDownsize: options.clusterPolicy?.allowDownsize ?? options.allowClusterDownsize,
			// Gate the harness DISARMS: production fails closed (default false) when an undersized
			// cluster has no confident network-size estimate, but harness meshes run below the safe
			// floor on purpose. Passed explicitly and visibly so the disarming is a statement, not an
			// inheritance. Ticket `mesh-harness-admission-gate` flips this default to false.
			allowUnvalidatedSmallCluster: options.clusterPolicy?.allowUnvalidatedSmallCluster ?? true
		}
	});

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
	// One real reconcile callback per node, shared between the member's commit-path `reconcileBlock`
	// and the coordinator's read-path `acquireBlockFromCohort` — production shares one instance
	// (`libp2p-node-base.ts`), and a spec must not be able to tell the two paths apart. Built in
	// phase 1 (with the member), consumed again in phase 2 (by the coordinator), so it is stashed
	// here keyed by peer id rather than widened onto the public `MeshNode` type.
	const reconcileByPeer = new Map<string, ReconcileBlockCallback>();

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

		// Active reconciliation: when a member commits a block it never pended (cohort drift), or a
		// reader holds a corroborated revision it cannot promote locally, pull the committed revision
		// from the cohort — through the PRODUCTION quorum rules (`createReconcileBlock`): a quorum of
		// distinct peers must agree on the target `(rev, actionId)` AND on the block content, or the
		// pass declines, persisting nothing. `reputation` is omitted — no reputation subsystem in the
		// harness.
		const reconcileBlock = createReconcileBlock({
			selfPeerId: peerId.toString(),
			fetchArchive: makeFetchArchive(nodes, peerId.toString(), failures),
			saveReplicatedBlock: (blockId, block, source) => storageRepo.saveReplicatedBlock(blockId, block, source),
			simpleMajorityThreshold: policy.simpleMajorityThreshold,
			repairCorroborationClusterSize: policy.repairCorroborationClusterSize
		});
		reconcileByPeer.set(peerId.toString(), reconcileBlock);

		const member = clusterMember({
			storageRepo,
			peerNetwork,
			peerId,
			privateKey,
			consensusConfig: policy,
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
			// Silence: the peer never answers. REJECTS, mirroring what a dial failure does to the
			// production callback — the coordinator must count this as "did not answer", never as
			// an absent claim (a resolved `undefined` remains the peer answering "I hold nothing").
			if (failures.silentPeers?.has(peerId.toString())) {
				throw new Error(`Peer ${peerId.toString()} is silent`);
			}
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
			// The SAME resolved policy the member above was built from, spread the way
			// `libp2p-node-base` spreads it into its coordinator factory — carrying
			// `repairCorroborationClusterSize` (the repair floor's yardstick, DEFAULT_CLUSTER_SIZE
			// when the mesh declared nothing), the production `minAbsoluteClusterSize` (2, not the
			// coordinator's own fallback of 3), and the explicitly-disarmed
			// `allowUnvalidatedSmallCluster` gate resolved above.
			{ ...policy }
		);
		node.coordinatorRepo = factory({
			storageRepo: node.storageRepo,
			localCluster: node.clusterMember,
			localPeerId: node.peerId,
			clusterLatestCallback,
			// The read path's transfer mechanism — the SAME instance the member uses on the commit
			// path, mirroring how `libp2p-node-base` shares one `reconcileBlock` between both.
			acquireBlockFromCohort: reconcileByPeer.get(node.peerId.toString())!
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
