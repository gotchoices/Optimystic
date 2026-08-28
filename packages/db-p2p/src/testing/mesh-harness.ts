import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { IKeyNetwork, ClusterPeers, ICluster, ClusterRecord, IRepo, BlockId, ActionRev, ITransactor, ITransactionValidator, PeerId as DbPeerId } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { NetworkTransactor } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { ClusterMember, clusterMember, type ReconcileBlockCallback, type DeriveExpectedClusterCallback, type ExpectedClusterView } from '../cluster/cluster-repo.js';
import { createReconcileBlock } from '../cluster/reconcile-block.js';
import { resolveClusterPolicy, type ClusterPolicyOptions, type ResolvedClusterPolicy } from '../cluster/cluster-policy.js';
import { StorageRepo } from '../storage/storage-repo.js';
import { MemoryRawStorage } from '../storage/memory-storage.js';
import { BlockStorage } from '../storage/block-storage.js';
import type { IRawStorage } from '../storage/i-raw-storage.js';
import type { BlockArchive } from '../storage/struct.js';
import { serveBlockArchive, servableProof } from '../storage/block-archive.js';
import { coordinatorRepo, type ClusterLatestCallback, type CertifiedActionRev } from '../repo/coordinator-repo.js';
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
	/**
	 * Per-node member-side cluster derivation for the membership admission gate — the harness
	 * analogue of `libp2p-node-base`'s `deriveExpectedCluster` (findCluster + FRET confidence).
	 * Omitted → each member gets the production-shaped derivation over its own self-including
	 * key-network view (partition-aware, see `MeshFailureConfig.partitionSides`) with confidence
	 * from `meshConfidence` (default 1).
	 */
	deriveExpectedCluster?: (node: MeshNode, blockId: BlockId) => Promise<ExpectedClusterView>;
	/**
	 * Per-node transaction validator — the harness analogue of `NodeOptions.validator`, which
	 * `libp2p-node-base` forwards straight into `clusterMember({ … validator })`. Invoked once per
	 * node (indexed from 0, in the order `Mesh.nodes` ends up in) during assembly.
	 *
	 * Omitted → no validator, and `ClusterMember.validatePendOperations` skips the whole validation
	 * step (signatures, schema hash, operations hash) — today's harness behaviour, preserved as the
	 * default so existing meshes do not suddenly re-validate transactions they were never built to
	 * satisfy. That is also production's current posture: no composition root supplies
	 * `NodeOptions.validator` yet (backlog `feat-no-deployment-validates-transactions-at-pend`).
	 *
	 * A FACTORY rather than one shared instance because enforcement is a per-node decision, and a
	 * mixed mesh — some members enforcing, some not — is exactly the case worth testing.
	 */
	validatorFactory?: (index: number, peerId: PeerId) => ITransactionValidator;
	/**
	 * Per-node network-size confidence (0..1) fed to the default derivation — the FRET stand-in.
	 * Default 1 (confident). Evaluated per vote, so a spec may flip it mid-test (e.g. collapse a
	 * partition side's confidence after the mesh is built). The gate's check is STRICTLY greater
	 * than its threshold (0.5), so returning the threshold itself lands on the fail-closed side.
	 */
	meshConfidence?: (node: MeshNode) => number;
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
	/**
	 * Simulated network partition: each entry is one side of the split, as a set of peer-id
	 * strings. While set, a node's own key-network view (`findCluster`) answers a caller on side S
	 * with only the members of S that would otherwise be in the cohort — an UNAUTHENTICATED
	 * shrunken view, exactly what the membership admission gate exists to refuse. Callers not in
	 * any listed side see the unpartitioned cohort.
	 *
	 * This shapes cluster VIEWS (what a coordinator declares and what a member derives), not
	 * transport reachability — combine with `failingPeers`/`silentPeers` to also sever traffic.
	 * On the write path that rarely matters: a partitioned coordinator only contacts the cohort
	 * it declared, which is already its own side.
	 */
	partitionSides?: Set<string>[];
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
 * itself comes from `serveBlockArchive`, the same function `SyncService` answers a real fetch with,
 * so the harness cannot serve a shape production would not — including the case that used to
 * differ: a peer holding a revision whose content it cannot materialize still votes on
 * `(rev, actionId)` here, exactly as it does over the wire.
 *
 * A silent peer serves no bytes either. `undefined` is the right answer: reconcile's `no-archive`
 * outcome deliberately conflates unreachable with holds-nothing, and the production
 * `fetchArchiveFromPeer` swallows every dial failure into the same `undefined`. (Contrast the read
 * path's latest-revision consult, where silence REJECTS — the coordinator counts "did not answer"
 * separately from "holds nothing".)
 *
 * `nodes` is captured by reference and is fully populated by the time this is invoked.
 *
 * NOTE: the archive served here always carries exactly ONE revision — the peer's current latest —
 * because that is all a repo read surfaces. Enough for repair, which only ever targets one
 * `(rev, actionId)`. If a spec ever needs a gap-fill across a revision RANGE, `serveBlockArchive`
 * has to grow a real range and both callers get it at once.
 */
const makeFetchArchive = (nodes: MeshNode[], selfPeerId: string, failures: MeshFailureConfig) =>
	async (peerIdStr: string, blockId: BlockId): Promise<BlockArchive | undefined> => {
		if (peerIdStr === selfPeerId) return undefined;
		if (failures.silentPeers?.has(peerIdStr)) return undefined;
		const target = nodes.find(n => n.peerId.toString() === peerIdStr);
		if (!target) return undefined;
		return await serveBlockArchive(target.storageRepo, blockId);
	};

/**
 * Fold the mesh's operator-facing knobs into the numbers every node runs on, through the SAME
 * resolver a real node's composition root uses (`libp2p-node-base.ts`). Named and exported rather
 * than inlined in `createMesh` so the precedence rule below is assertable without building a mesh.
 *
 * Precedence: an explicit `clusterPolicy` entry wins over the matching legacy top-level field — the
 * entry is the production-shaped one.
 */
export function resolveMeshPolicy(options: MeshOptions): ResolvedClusterPolicy {
	return resolveClusterPolicy({
		clusterSize: options.clusterSize,
		clusterPolicy: {
			...options.clusterPolicy,
			superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? options.superMajorityThreshold,
			allowDownsize: options.clusterPolicy?.allowDownsize ?? options.allowClusterDownsize
			// `allowUnvalidatedSmallCluster` passes through UNTOUCHED and so defaults to `false`, same
			// as `resolveClusterPolicy` — the membership admission gate is ARMED in the harness. A mesh
			// that must transact below the safe floor says so at its own call site:
			//   createMesh(1, { responsibilityK: 1, clusterPolicy: { allowUnvalidatedSmallCluster: true } })
			// No harness-wide re-default: a disarmed gate has to be visible where the test is read.
			// (Solo cohorts never reach the gate anyway — CoordinatorRepo short-circuits peerCount <= 1
			// straight to local storage — so only a genuinely undersized MULTI-peer cohort needs the
			// opt-in.)
		}
	});
}

/**
 * Creates N interconnected mesh nodes with real components and mock transport.
 * ClusterClient calls route directly to target ClusterMember instances.
 */
export async function createMesh(nodeCount: number, options: MeshOptions): Promise<Mesh> {
	// NOTE: a mesh is never shut down — `Mesh` exposes no disposal seam, so each node's
	// `ClusterMember.dispose()` is never called and its two cleanup intervals tick for the rest of
	// the process. Harmless today: both handles are `.unref()`ed (the process still exits) and the
	// callbacks are no-ops on an idle member, at ~40 `createMesh` sites across db-p2p's suite. If a
	// mesh ever holds something a timer keeps alive — a real socket, a file handle, a fake clock a
	// spec advances — give `Mesh` a `dispose()` that walks the nodes, and make the specs use it.
	const failures: MeshFailureConfig = {};

	// NOTE: one policy for the whole mesh, so every node necessarily agrees on cluster size and
	// thresholds. That is right for repair tests, where disagreement is not the variable. A test
	// that needs nodes to DISAGREE about the cluster (a partition where each side derives its own
	// view — see ticket `mesh-harness-admission-gate`) has to resolve per node instead; it cannot
	// be expressed with a single shared object.
	//
	// Resolved once per mesh rather than per node for a second reason: the resolver's one-line
	// `repair-fault-tolerance` advisory then fires once instead of N times.
	const policy = resolveMeshPolicy(options);

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

	// The mesh key network is built BEFORE the members: each member's `deriveExpectedCluster` (the
	// admission gate's view) needs a per-node key network in phase 1, and constructing it here beats
	// a late-bound slot a closure could fire on before it is filled. Safe because `nodes` is captured
	// by reference and only consulted at call time, after the array is fully populated.
	const keyNetwork = new MockMeshKeyNetwork(nodes, options.responsibilityK, failures);

	/**
	 * One node's own view of the key network — what `Libp2pKeyPeerNetwork` gives a real node:
	 *  - `findCluster` always includes self, so a responsible member's derived view is never empty
	 *    (see the empty-view guard in `cluster-repo.admitMembership`);
	 *  - under a simulated partition (`failures.partitionSides`), a caller inside a side sees only
	 *    its side's members of the cohort — the caller-aware filtering lives here, in the per-node
	 *    wrapper, precisely so `IKeyNetwork` itself needs no "who is asking" parameter.
	 * The SAME instance serves both the member's admission derivation (phase 1) and the node's
	 * coordinator (phase 2), so the two sides of a node can never see different topologies.
	 */
	const makeNodeKeyNetwork = (selfPeerId: PeerId): IKeyNetwork => {
		const selfStr = selfPeerId.toString();
		return {
			findCoordinator: (key, opts) => keyNetwork.findCoordinator(key, opts),
			async findCluster(key) {
				const peers = await keyNetwork.findCluster(key);
				const side = failures.partitionSides?.find(s => s.has(selfStr));
				if (side) {
					for (const id of Object.keys(peers)) {
						if (!side.has(id)) delete peers[id];
					}
				}
				if (!(selfStr in peers)) {
					peers[selfStr] = {
						multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
						publicKey: u8ToString(selfPeerId.publicKey!.raw, 'base64url')
					};
				}
				return peers;
			}
		};
	};
	const nodeKeyNetworkByPeer = new Map<string, IKeyNetwork>();

	// Phase 1: create storage + cluster members
	let nodeIndex = 0;
	for (const { peerId, privateKey } of keyPairs) {
		const index = nodeIndex++;
		const rawStorage = options.rawStorageFactory
			? options.rawStorageFactory(index)
			: new MemoryRawStorage();
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

		const nodeKeyNetwork = makeNodeKeyNetwork(peerId);
		nodeKeyNetworkByPeer.set(peerId.toString(), nodeKeyNetwork);

		// The node object exists before its member so the admission derivation below can hand the
		// finished MeshNode to spec-supplied callbacks; `clusterMember`/`coordinatorRepo` are
		// assigned as they are built (member just below, coordinator in phase 2) and the closures
		// only run at vote time, long after both are in place.
		const meshNode: MeshNode = {
			peerId,
			privateKey,
			storageRepo,
			clusterMember: undefined as any,
			coordinatorRepo: undefined as any
		};

		// Member-side cluster derivation for the membership admission gate — the production shape
		// (`libp2p-node-base.deriveExpectedCluster`): the SAME per-node key network the coordinator
		// selects its cohort from, plus a network-size confidence. The self-including wrapper keeps a
		// responsible member's view non-empty; `meshConfidence` is the FRET stand-in (default 1, i.e.
		// confident — a partition spec collapses it per side).
		const deriveExpectedCluster: DeriveExpectedClusterCallback = options.deriveExpectedCluster
			? (blockId) => options.deriveExpectedCluster!(meshNode, blockId)
			: async (blockId) => ({
				peers: await nodeKeyNetwork.findCluster(new TextEncoder().encode(blockId)) ?? {},
				confidence: options.meshConfidence?.(meshNode) ?? 1
			});

		meshNode.clusterMember = clusterMember({
			storageRepo,
			peerNetwork,
			peerId,
			privateKey,
			consensusConfig: policy,
			reconcileBlock,
			deriveExpectedCluster,
			// Absent by default: `undefined` here is identical to omitting the field, and
			// `validatePendOperations` then skips the validation step entirely.
			validator: options.validatorFactory?.(index, peerId)
		});

		nodes.push(meshNode);
	}

	// Phase 2: coordinator repos (needs all nodes for routing; key network built in phase 1)
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
		const clusterLatestCallback: ClusterLatestCallback = async (peerId: PeerId, blockId: BlockId, context?): Promise<CertifiedActionRev | undefined> => {
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
			const latest = result[blockId]?.state?.latest;
			if (!latest) return undefined;
			// The commit proof rides along exactly as it does in production, and through the SAME
			// lookup `serveBlockArchive` uses (`servableProof`) rather than a hand-rolled one — a
			// harness that attached proofs by its own rule would let every mesh-tier test exercise a
			// certification path real peers do not have, or miss one they do. Production reads the
			// proof out of the served archive; the harness reads the sibling's repo directly, so
			// sharing the lookup is what keeps the two answers identical.
			const proof = await servableProof(target.storageRepo, blockId, latest);
			return proof ? { ...latest, proof } : latest;
		};
		// The node's own self-including (and partition-aware) key-network view, built in phase 1 —
		// the SAME instance the member's admission derivation reads, matching real
		// Libp2pKeyPeerNetwork behavior.
		const nodeKeyNetwork = nodeKeyNetworkByPeer.get(node.peerId.toString())!;
		const factory = coordinatorRepo(
			nodeKeyNetwork,
			createClusterClient,
			// The SAME resolved policy the member above was built from, spread the way
			// `libp2p-node-base` spreads it into its coordinator factory — carrying
			// `repairCorroborationClusterSize` (the repair floor's yardstick, DEFAULT_CLUSTER_SIZE
			// when the mesh declared nothing), the production `minAbsoluteClusterSize` (2, not the
			// coordinator's own fallback of 3), and the `allowUnvalidatedSmallCluster` gate —
			// ARMED (false) unless the mesh opted out at its call site.
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
