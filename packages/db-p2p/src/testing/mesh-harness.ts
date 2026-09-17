import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { IKeyNetwork, ClusterPeers, ICluster, ClusterRecord, IRepo, BlockId, ITransactor, ITransactionValidator, PeerId as DbPeerId, RoutingKey } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { NetworkTransactor, routingKeyForBlock } from '@optimystic/db-core';
import { DigitreeStore, assembleCohort, hashKey, hashPeerId } from 'p2p-fret';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair, generateKeyPairFromSeed } from '@libp2p/crypto/keys';
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
import { toString as u8ToString } from 'uint8arrays';

export interface MeshNode {
	peerId: PeerId;
	privateKey: PrivateKey;
	/**
	 * This node's own view of the key network — the harness analogue of a real node's `keyNetwork`
	 * attachment, and the instance its coordinator and its member's admission derivation both read. It
	 * differs from `Mesh.keyNetwork` only under a simulated partition (`MeshFailureConfig.partitionSides`).
	 */
	keyNetwork: IKeyNetwork;
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
	 * Omitted → each member gets the production-shaped derivation over its own key-network view
	 * (partition-aware, see `MeshFailureConfig.partitionSides`) with confidence from `meshConfidence`
	 * (default 1).
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
	 *
	 * A mesh that arms validators can also set `clusterPolicy.unvalidatablePendPolicy: 'reject'` to
	 * refuse pends that carry no `validation` payload (the single-collection `Collection.sync`
	 * shape, which a validator cannot re-check); the default 'accept' admits them unchecked.
	 */
	validatorFactory?: (index: number, peerId: PeerId) => ITransactionValidator;
	/**
	 * Per-node network-size confidence (0..1) fed to the default derivation — the FRET stand-in.
	 * Default 1 (confident). Evaluated per vote, so a spec may flip it mid-test (e.g. collapse a
	 * partition side's confidence after the mesh is built). The gate's check is STRICTLY greater
	 * than its threshold (0.5), so returning the threshold itself lands on the fail-closed side.
	 */
	meshConfidence?: (node: MeshNode) => number;
	/**
	 * Wraps the mesh's shared key network before any node, member derivation or transactor captures it —
	 * so a wrapper here observes EVERY cohort lookup in the mesh (each node's coordinator, cluster
	 * coordinator and admission derivation, plus `mesh.keyNetwork`), not only the transactor's.
	 * Reassigning `mesh.keyNetwork` after `createMesh` reaches the transactor alone.
	 * Omitted → identity.
	 */
	wrapKeyNetwork?: (shared: IKeyNetwork) => IKeyNetwork;
	/**
	 * Derive every node's Ed25519 key from a fixed seed `(keySeed, index)` instead of fresh
	 * randomness, so the mesh's ring geometry is identical on every run. For specs that assert on
	 * statistics of cohort placement: with random keys such a bound is a sample whose tail
	 * eventually crosses it. Omitted → random keys.
	 */
	keySeed?: number;
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
	/**
	 * Observes every REMOTE cluster delivery — promise round, commit round, commit broadcast and
	 * scheduled commit retry alike — with the target's peer-id string and the record as sent, BEFORE
	 * `failingPeers` is consulted for that delivery. It exists so a spec can change reachability at an
	 * exact protocol step rather than between whole transactions: a member that promised and then
	 * dropped before voting to commit is set unreachable here, on the delivery that would have carried
	 * its commit vote, and that very delivery fails.
	 *
	 * A coordinator's OWN member is invoked in process, never through this path — as in production,
	 * where `ClusterCoordinator.updateMember` calls it directly — so the hook never sees it.
	 */
	onClusterDelivery?: (targetPeerId: string, record: ClusterRecord) => void;
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> {
		return {};
	}
}

/**
 * Mock IKeyNetwork that places a block where production does, by construction: it ranks the mesh's nodes
 * with FRET's own `assembleCohort` over a ring (`DigitreeStore`) holding every node at its real ring
 * coordinate (`hashPeerId`), the walk `Libp2pKeyPeerNetwork` asks FRET for. Like production it hashes the
 * routing key exactly once. Every mesh node serves, so the network-membership scoping production layers on
 * top never removes anyone, and a cohort is simply the nearest `responsibilityK` in walk order.
 * `test/mesh-harness-cohort-parity.spec.ts` pins the two answers equal.
 *
 * - `findCluster`: the nearest `responsibilityK` nodes, nearest first. Nothing is added: a node is in a
 *   block's cohort only when it is among the nearest, as in production.
 * - `findCoordinator`: the first non-excluded node of the whole ring's walk, which is the cohort's first
 *   member unless excluded, else the next nearest node, cohort member or not. That mirrors production's
 *   connected-peer fallback: a pick outside the cohort is a routing hop, not a placement.
 */
class MockMeshKeyNetwork implements IKeyNetwork {
	/** The ring, built on first lookup (node ids hash asynchronously, and `nodes` fills after construction)
	 *  and rebuilt only if the node count changes; a restarted node keeps its identity and so its position. */
	private ring: { size: number; ready: Promise<{ store: DigitreeStore; byId: Map<string, MeshNode> }> } | undefined;

	constructor(
		private readonly nodes: MeshNode[],
		private readonly responsibilityK: number,
		private readonly failures: MeshFailureConfig = {}
	) {}

	async findCoordinator(key: RoutingKey, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const excluded = new Set((options?.excludedPeers ?? []).map(p => p.toString()));
		const pick = (await this.nearest(key, this.nodes.length)).find(n => !excluded.has(n.peerId.toString()));
		if (!pick) {
			throw new Error('No coordinator available for key (all candidates excluded)');
		}
		return pick.peerId;
	}

	async findCluster(key: RoutingKey): Promise<ClusterPeers> {
		if (this.failures.findClusterFails) {
			return {} as ClusterPeers;
		}

		const peers: ClusterPeers = {};
		for (const node of await this.nearest(key, this.responsibilityK)) {
			peers[node.peerId.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(node.peerId.publicKey!.raw, 'base64url')
			};
		}
		return peers;
	}

	/** The `wants` nodes nearest `key`'s ring coordinate, nearest first. */
	private async nearest(key: RoutingKey, wants: number): Promise<MeshNode[]> {
		const { store, byId } = await this.ringStore();
		const ids = assembleCohort(store, await hashKey(key), Math.min(wants, byId.size));
		return ids.map(id => byId.get(id)!);
	}

	private ringStore(): Promise<{ store: DigitreeStore; byId: Map<string, MeshNode> }> {
		if (this.ring?.size !== this.nodes.length) {
			const members = [...this.nodes];
			this.ring = {
				size: members.length,
				ready: (async () => {
					const store = new DigitreeStore();
					const byId = new Map<string, MeshNode>();
					for (const node of members) {
						store.upsert(node.peerId.toString(), await hashPeerId(node.peerId));
						byId.set(node.peerId.toString(), node);
					}
					return { store, byId };
				})()
			};
		}
		return this.ring.ready;
	}
}

export interface Mesh {
	nodes: MeshNode[];
	failures: MeshFailureConfig;
	keyNetwork: IKeyNetwork;
	/**
	 * Restart one node the way a stopped and relaunched process comes back: same identity, same raw
	 * storage, and nothing else. `node`'s storage repo, cluster member and coordinator are rebuilt IN
	 * PLACE on the same `MeshNode` object (so a spec's reference to it stays valid), over the
	 * `IRawStorage` instance it was built with — for the default `MemoryRawStorage` that is exactly
	 * "over its own storage"; a `rawStorageFactory` store is reused as-is, never re-requested.
	 *
	 * Everything held only in memory goes with the old instance: the member's reservations and
	 * executed-transaction memory, the coordinator's in-flight transactions and scheduled commit
	 * retries, every read-repair stamp. The harness wires no `ITransactionStateStore`, so nothing is
	 * recovered either — a production node built with `transactionStateStore` would resume its
	 * persisted commit retries on restart (`ClusterCoordinator.recoverTransactions`). The old instance is made inert rather than merely forgotten —
	 * its member is disposed, and every outbound call it would still make (a commit retry whose timer
	 * fires later, a cohort consult, an archive fetch) fails the way a stopped process's dial does — so
	 * a retry the old process owed cannot quietly deliver after the restart and pass for healing.
	 *
	 * Reachability (`failures`) is untouched: a node that was unreachable stays unreachable.
	 */
	restart(node: MeshNode): void;
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

/** Whether one node INSTANCE is still running. Every outbound call the instance makes checks it, so an
 *  instance {@link Mesh.restart} replaced goes quiet instead of acting alongside the new one. */
interface NodeLifetime {
	stopped: boolean;
}

/** The 32-byte Ed25519 seed for node `index` of a `keySeed` mesh. */
function meshKeySeed(keySeed: number, index: number): Uint8Array {
	const seed = new Uint8Array(32);
	const view = new DataView(seed.buffer);
	view.setUint32(0, keySeed);
	view.setUint32(4, index);
	return seed;
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
		Array.from({ length: nodeCount }, async (_, i) => {
			const privateKey = options.keySeed === undefined
				? await generateKeyPair('Ed25519')
				: await generateKeyPairFromSeed('Ed25519', meshKeySeed(options.keySeed, i));
			return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
		})
	);

	const nodes: MeshNode[] = [];
	const peerNetwork = new MockPeerNetwork();
	// One real reconcile callback per node, shared between the member's commit-path `reconcileBlock`
	// and the coordinator's read-path `acquireBlockFromCohort` — production shares one instance
	// (`libp2p-node-base.ts`), and a spec must not be able to tell the two paths apart. Built with the
	// member, consumed again by the coordinator, so it is stashed here keyed by peer id rather than
	// widened onto the public `MeshNode` type.
	const reconcileByPeer = new Map<string, ReconcileBlockCallback>();
	/** What outlives a node instance, by peer id: the raw storage it was built over, and its index
	 *  (`validatorFactory` is invoked with it again on restart). */
	const durableByPeer = new Map<string, { rawStorage: IRawStorage; index: number }>();
	/** The CURRENT instance's lifetime, by peer id — flipped to stopped by {@link Mesh.restart}. */
	const lifetimeByPeer = new Map<string, NodeLifetime>();

	// The mesh key network is built BEFORE the members: each member's `deriveExpectedCluster` (the
	// admission gate's view) needs a per-node key network, and constructing it here beats a late-bound
	// slot a closure could fire on before it is filled. Safe because `nodes` is captured by reference
	// and only consulted at call time, after the array is fully populated.
	//
	// `wrapKeyNetwork` is applied HERE, before `makeNodeKeyNetwork` closes over `keyNetwork` below and
	// before any `deriveExpectedCluster` closure is built — every one of them reads the `keyNetwork`
	// binding, so a wrapper assigned to it here is what every node's coordinator, cluster member and the
	// returned `Mesh.keyNetwork` all observe. Reassigning `mesh.keyNetwork` after this function returns
	// only reaches whoever reads that property later (the transactor); it is too late for the rest.
	const sharedKeyNetwork = new MockMeshKeyNetwork(nodes, options.responsibilityK, failures);
	const keyNetwork = options.wrapKeyNetwork ? options.wrapKeyNetwork(sharedKeyNetwork) : sharedKeyNetwork;

	/**
	 * One node's own view of the key network — what `Libp2pKeyPeerNetwork` gives a real node:
	 *  - `findCluster` is the shared cohort, which holds this node only when it is among the block's
	 *    nearest `responsibilityK`, so the node's coordinator judges its own responsibility as a real
	 *    node's does;
	 *  - under a simulated partition (`failures.partitionSides`), a caller inside a side sees only
	 *    its side's members of the cohort — the caller-aware filtering lives here, in the per-node
	 *    wrapper, precisely so `IKeyNetwork` itself needs no "who is asking" parameter. A side holding
	 *    none of the cohort sees an empty view, so a node there is not responsible for the block (and
	 *    the empty-view guard in `cluster-repo.admitMembership` treats such a view as unconfident rather
	 *    than as a reference set).
	 * The SAME instance serves both the member's admission derivation and the node's coordinator, so
	 * the two sides of a node can never see different topologies. It holds no state, so a restarted
	 * node keeps it.
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
				return peers;
			}
		};
	};

	/**
	 * Build `meshNode`'s storage repo and cluster member over its durable raw storage, assigning both
	 * onto the node. Run once per node at assembly, and again by {@link Mesh.restart}.
	 */
	const buildMember = (meshNode: MeshNode, lifetime: NodeLifetime): void => {
		const { peerId, privateKey } = meshNode;
		const { rawStorage, index } = durableByPeer.get(peerId.toString())!;
		const storageRepo = new StorageRepo(
			(blockId: BlockId) => new BlockStorage(blockId, rawStorage)
		);

		// Active reconciliation: when a member commits a block it never pended (cohort drift), or a
		// reader holds a corroborated revision it cannot promote locally, pull the committed revision
		// from the cohort — through the PRODUCTION quorum rules (`createReconcileBlock`): a quorum of
		// distinct peers must agree on the target `(rev, actionId)` AND on the block content, or the
		// pass declines, persisting nothing. `reputation` is omitted — no reputation subsystem in the
		// harness.
		const fetchArchive = makeFetchArchive(nodes, peerId.toString(), failures);
		const reconcileBlock = createReconcileBlock({
			selfPeerId: peerId.toString(),
			// A stopped instance fetches nothing — the production fetch swallows a failed dial into
			// the same `undefined`.
			fetchArchive: async (peerIdStr, blockId) => lifetime.stopped ? undefined : await fetchArchive(peerIdStr, blockId),
			// Production shape: a proof reconcile verified against the agreed bytes is persisted so
			// the repaired replica serves it onward.
			saveReplicatedBlock: (blockId, block, source, verifiedProof) =>
				storageRepo.saveReplicatedBlock(blockId, block, source, verifiedProof),
			simpleMajorityThreshold: policy.simpleMajorityThreshold,
			superMajorityThreshold: policy.superMajorityThreshold,
			repairCorroborationClusterSize: policy.repairCorroborationClusterSize
		});
		reconcileByPeer.set(peerId.toString(), reconcileBlock);

		const nodeKeyNetwork = meshNode.keyNetwork;

		// Member-side cluster derivation for the membership admission gate — the production shape
		// (`libp2p-node-base.deriveExpectedCluster`): the SAME per-node key network the coordinator
		// selects its cohort from, plus a network-size confidence. A responsible member is in its own
		// cohort, so its view is never empty; `meshConfidence` is the FRET stand-in (default 1, i.e.
		// confident — a partition spec collapses it per side).
		const deriveExpectedCluster: DeriveExpectedClusterCallback = options.deriveExpectedCluster
			? (blockId) => options.deriveExpectedCluster!(meshNode, blockId)
			: async (blockId) => ({
				peers: await nodeKeyNetwork.findCluster(routingKeyForBlock(blockId)) ?? {},
				confidence: options.meshConfidence?.(meshNode) ?? 1
			});

		meshNode.storageRepo = storageRepo;
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
	};

	// Cluster traffic to a node, resolved per call: a delivery always reaches the target's CURRENT
	// member, so a restarted node answers with its new instance.
	const createClusterClient = (targetPeerId: PeerId): ICluster => {
		const target = nodes.find(n => n.peerId.equals(targetPeerId));
		if (!target) {
			throw new Error(`Unknown peer: ${targetPeerId.toString()}`);
		}
		return {
			async update(record: ClusterRecord): Promise<ClusterRecord> {
				failures.onClusterDelivery?.(targetPeerId.toString(), record);
				if (failures.failingPeers?.has(targetPeerId.toString())) {
					throw new Error(`Peer ${targetPeerId.toString()} is unreachable`);
				}
				return target.clusterMember.update(record);
			}
		};
	};

	/**
	 * Build `node`'s coordinator over its (already built) storage repo and member. It reaches the other
	 * nodes only at call time, never at construction. Run once per node at assembly, and again by
	 * {@link Mesh.restart}.
	 */
	const buildCoordinator = (node: MeshNode, lifetime: NodeLifetime): void => {
		const stoppedError = (): Error => new Error(`${node.peerId.toString()} was restarted; this instance is stopped`);
		// Per-node callback: reports the queried peer's latest revision, and NOTHING else. It used to
		// also write the peer's block into local storage ("simulate data sync"), which made every
		// read-repair assertion on this harness observe a convergence the production callback does not
		// provide — masking exactly the defect that ticket `read-repair-cannot-transfer-block-content`
		// existed to expose. Transfer now happens where it does in production: through
		// `acquireBlockFromCohort` below, gated on a corroborated revision.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId: PeerId, blockId: BlockId, context?): Promise<CertifiedActionRev | undefined> => {
			if (lifetime.stopped) throw stoppedError();
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
		// The node's own (partition-aware) key-network view — the SAME instance the member's admission
		// derivation reads, matching real Libp2pKeyPeerNetwork behavior.
		const nodeKeyNetwork = node.keyNetwork;
		const factory = coordinatorRepo(
			nodeKeyNetwork,
			// A stopped instance's cluster traffic fails at send — checked per delivery rather than when
			// the client is made, because `ClusterCoordinator` also sends from a commit-retry timer that
			// can fire long after a restart.
			(targetPeerId: PeerId): ICluster => {
				const client = createClusterClient(targetPeerId);
				return {
					async update(record: ClusterRecord): Promise<ClusterRecord> {
						if (lifetime.stopped) throw stoppedError();
						return await client.update(record);
					}
				};
			},
			// The SAME resolved policy the member was built from, spread the way `libp2p-node-base`
			// spreads it into its coordinator factory — carrying `repairCorroborationClusterSize` (the
			// repair floor's yardstick, DEFAULT_CLUSTER_SIZE when the mesh declared nothing), the
			// production `minAbsoluteClusterSize` (2, not the coordinator's own fallback of 3), and the
			// `allowUnvalidatedSmallCluster` gate — ARMED (false) unless the mesh opted out at its call
			// site.
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
	};

	// Phase 1: storage + cluster members, in key-pair order (the order `validatorFactory` indexes by).
	for (const [index, { peerId, privateKey }] of keyPairs.entries()) {
		const peerIdStr = peerId.toString();
		durableByPeer.set(peerIdStr, {
			rawStorage: options.rawStorageFactory ? options.rawStorageFactory(index) : new MemoryRawStorage(),
			index
		});
		const lifetime: NodeLifetime = { stopped: false };
		lifetimeByPeer.set(peerIdStr, lifetime);

		// The node object exists before its member so the admission derivation can hand the finished
		// MeshNode to spec-supplied callbacks; `storageRepo`/`clusterMember` are assigned by
		// `buildMember` just below and `coordinatorRepo` in phase 2, and those closures only run at
		// vote time, long after all three are in place.
		const meshNode: MeshNode = {
			peerId,
			privateKey,
			keyNetwork: makeNodeKeyNetwork(peerId),
			storageRepo: undefined as any,
			clusterMember: undefined as any,
			coordinatorRepo: undefined as any
		};
		buildMember(meshNode, lifetime);
		nodes.push(meshNode);
	}

	// Phase 2: coordinator repos, once every member exists.
	for (const node of nodes) {
		buildCoordinator(node, lifetimeByPeer.get(node.peerId.toString())!);
	}

	const restart = (node: MeshNode): void => {
		const peerIdStr = node.peerId.toString();
		if (!nodes.includes(node)) {
			throw new Error(`restart: ${peerIdStr} is not a node of this mesh`);
		}
		// NOTE: this severs the old instance's traffic to OTHER nodes, not its in-process path to its own
		// member and storage repo, which still write the shared raw storage if called. After a restart
		// between transactions only one thing could reach it: a scheduled commit retry aimed at the
		// coordinator's OWN member, which exists only when that member threw while applying the broadcast —
		// a local fault no spec injects today. If a spec ever does, or restarts a node MID-transaction,
		// sever the old coordinator's local member too.
		lifetimeByPeer.get(peerIdStr)!.stopped = true;
		node.clusterMember.dispose();
		const lifetime: NodeLifetime = { stopped: false };
		lifetimeByPeer.set(peerIdStr, lifetime);
		buildMember(node, lifetime);
		buildCoordinator(node, lifetime);
	};

	return { nodes, failures, keyNetwork, restart };
}

/**
 * The nodes the key network keeps OUT of `blockId`'s cohort — peers that receive none of the
 * block's cluster traffic, and so hold none of its content until something repairs them.
 *
 * Unless the mesh is seeded (`keySeed`), peer ids are generated fresh per mesh, so which node is
 * responsible for a given block is random from run to run: in a 3-node `responsibilityK: 1` mesh,
 * `nodes[1]` is the block's sole responsible peer about a third of the time, and then it receives the
 * writer's commit directly. A test that needs a genuinely non-responsible node has to ask the routing
 * layer rather than assume an index.
 */
export async function nonResponsibleNodes(mesh: Mesh, blockId: string): Promise<MeshNode[]> {
	const cohort = await mesh.keyNetwork.findCluster(routingKeyForBlock(blockId));
	return mesh.nodes.filter(node => !(node.peerId.toString() in cohort));
}

/**
 * The nodes the key network places in `blockId`'s cohort, nearest first — the complement of
 * {@link nonResponsibleNodes}. A node outside this list refuses a write for the block through its own
 * coordinator (`CoordinatorRepo` checks responsibility), so a spec that writes through one node's
 * coordinator directly picks that node from here rather than by index.
 */
export async function responsibleNodes(mesh: Mesh, blockId: string): Promise<MeshNode[]> {
	const cohort = Object.keys(await mesh.keyNetwork.findCluster(routingKeyForBlock(blockId)));
	return cohort.map(id => mesh.nodes.find(node => node.peerId.toString() === id)!);
}

/**
 * The first `count` ids of the form `${prefix}-${i}` whose cohort includes `node` — for a spec that needs
 * several blocks one node is responsible for (a multi-block pend through that node's coordinator, or
 * sequential writes it coordinates alone). In a `responsibilityK: 1` mesh these are blocks the node is
 * the SOLE responsible peer for. Throws after `maxCandidates` ids rather than looping on a node whose ring
 * arc no id lands in.
 */
export async function blockIdsInCohortOf(mesh: Mesh, node: MeshNode, count: number, prefix: string, maxCandidates = 10_000): Promise<BlockId[]> {
	const nodeId = node.peerId.toString();
	const ids: BlockId[] = [];
	for (let i = 0; ids.length < count && i < maxCandidates; i++) {
		const id = `${prefix}-${i}` as BlockId;
		if (nodeId in await mesh.keyNetwork.findCluster(routingKeyForBlock(id))) ids.push(id);
	}
	if (ids.length < count) {
		throw new Error(`blockIdsInCohortOf: only ${ids.length} of ${count} ids with prefix ${prefix} place ${nodeId} in their cohort`);
	}
	return ids;
}

export interface BuildTransactorOptions {
	timeoutMs?: number;
	abortOrCancelTimeoutMs?: number;
	/**
	 * Wraps each node's repo before the transactor sees it, so a test can inject a transport-shaped
	 * failure into one RPC (a dropped sweep commit, a refused pend) and leave every other call — and
	 * therefore all of the production code after the injection — untouched.
	 */
	wrapRepo?: (repo: IRepo, node: MeshNode) => IRepo;
}

/**
 * Builds a NetworkTransactor over a mesh. All nodes share the same mock
 * infrastructure so a single transactor routes to every peer via `getRepo`.
 * It runs on no node (no `localPeerId`), so a coverage tie between cohort
 * members goes to the nearest — a client-only writer's shape.
 * Suitable for solo-mesh tests; for multi-node tests prefer
 * `buildNetworkTransactors` to label "which node is driving".
 */
export const buildNetworkTransactor = (mesh: Mesh, options: BuildTransactorOptions = {}): ITransactor =>
	meshTransactor(mesh, options, undefined);

/**
 * Builds one NetworkTransactor per mesh node, keyed by peer-id string. Each
 * transactor shares the mesh's key network and peer→repo map, and runs on its
 * node the way a production node's transactor does (`localPeerId`): when that
 * node is in a block's cohort and ties another member on coverage, it
 * coordinates the write itself. Reads and retries still route by proximity.
 */
export const buildNetworkTransactors = (mesh: Mesh, options: BuildTransactorOptions = {}): Map<string, ITransactor> => {
	const transactors = new Map<string, ITransactor>();
	for (const node of mesh.nodes) {
		transactors.set(node.peerId.toString(), meshTransactor(mesh, options, node));
	}
	return transactors;
};

function meshTransactor(mesh: Mesh, options: BuildTransactorOptions, localNode: MeshNode | undefined): ITransactor {
	const repoByPeer = new Map<string, IRepo>();
	for (const node of mesh.nodes) {
		const repo = node.coordinatorRepo as unknown as IRepo;
		repoByPeer.set(node.peerId.toString(), options.wrapRepo ? options.wrapRepo(repo, node) : repo);
	}
	return new NetworkTransactor({
		timeoutMs: options.timeoutMs ?? 5_000,
		abortOrCancelTimeoutMs: options.abortOrCancelTimeoutMs ?? 5_000,
		// NOTE: every transactor, `localNode`'s included, reads the unpartitioned shared view, not `localNode.keyNetwork`;
		// no spec drives `partitionSides` through a node's transactor today. If one does, pass the node's own view.
		keyNetwork: mesh.keyNetwork,
		getRepo: (peerId: DbPeerId) => {
			const repo = repoByPeer.get(peerId.toString());
			if (!repo) throw new Error(`Unknown peer ${peerId.toString()}`);
			return repo;
		},
		localPeerId: localNode?.peerId
	});
}
