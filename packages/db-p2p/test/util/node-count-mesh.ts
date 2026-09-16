/**
 * The in-process mesh a spec builds when it runs ONE transaction scenario at several machine counts
 * (`transaction-node-count-sweep.spec.ts`), plus the two pieces of per-node plumbing such a spec needs
 * and the harness does not provide: a transactor that is genuinely driven BY a given node, and a way to
 * make one node unreachable from everybody at once.
 *
 * ## The configuration is the production-shaped one, deliberately
 *
 * {@link productionShapedMeshOptions} is what `docs/optimystic.md` § Deployment Sizes recommends and what
 * a host application deriving the machine count from its own membership records passes: the replication
 * factor left at its default (`DEFAULT_CLUSTER_SIZE`), and the real machine count declared ONLY as
 * `clusterPolicy.repairCorroborationClusterSize`. It is NOT the `clusterSize: N` shortcut most mesh specs
 * take — that shortcut lowers the replication factor, which no real deployment of N machines does, so a
 * behaviour that depends on the two differing would never be seen in the fast lane. The two-machine
 * lifecycle specs (`util/two-machine-lifecycle.ts`) run the same shape over real sockets.
 *
 * `responsibilityK` stands in for what production's `findCluster` asks for — the nearest `clusterSize`
 * peers — so it is the default replication factor too, and at every size the sweep covers the whole mesh
 * is in every cohort. That is asserted by the sweep rather than assumed here.
 */
import { NetworkTransactor, routingKeyForBlock, type IKeyNetwork, type IRepo, type ITransactor, type PeerId as DbPeerId } from '@optimystic/db-core';
import { createMesh, type Mesh, type MeshNode, type MeshOptions } from '../../src/testing/mesh-harness.js';
import { DEFAULT_CLUSTER_SIZE } from '../../src/cluster/cluster-policy.js';

/** Mesh options for `machines` machines, configured the way a real deployment of that size is. See the module header. */
export function productionShapedMeshOptions(machines: number): MeshOptions {
	return {
		responsibilityK: DEFAULT_CLUSTER_SIZE,
		clusterPolicy: { repairCorroborationClusterSize: machines }
	};
}

export async function createProductionShapedMesh(machines: number): Promise<Mesh> {
	return await createMesh(machines, productionShapedMeshOptions(machines));
}

/** Every mesh node the key network places in `blockId`'s cohort, by peer-id string. */
export async function cohortOf(mesh: Mesh, blockId: string): Promise<string[]> {
	return Object.keys(await mesh.keyNetwork.findCluster(routingKeyForBlock(blockId)));
}

/**
 * Make exactly `nodes` unreachable — an empty list makes everyone reachable again. Unreachable means from
 * every direction the mesh has: cluster traffic to the node fails (`failingPeers`), its read-path answers
 * and archive fetches go silent (`silentPeers`), and every {@link transactorDrivenBy} transactor's repo
 * call to it rejects the way a failed dial does.
 *
 * The cohort VIEW is left alone: the key network still names the node as a member. That is the shape of
 * a machine that stopped answering while its peers still route to it, as opposed to one the routing layer
 * has already dropped.
 *
 * The failure sets are read at call time, so this can be flipped mid-test. What the harness does NOT model
 * is anything the returning node would do on its own (it has no background processes here); a spec about a
 * member that leaves and returns has to drive the healing it expects.
 */
export function setUnreachable(mesh: Mesh, nodes: readonly MeshNode[]): void {
	const ids = nodes.map(node => node.peerId.toString());
	mesh.failures.failingPeers = ids.length === 0 ? undefined : new Set(ids);
	mesh.failures.silentPeers = ids.length === 0 ? undefined : new Set(ids);
}

function isUnreachable(mesh: Mesh, peerIdStr: string): boolean {
	return mesh.failures.failingPeers?.has(peerIdStr) === true;
}

/** A repo whose every call rejects asynchronously — what a failed dial looks like to `NetworkTransactor`. (A
 *  SYNCHRONOUS throw from `getRepo` would escape `processBatches` before it can re-home the batch onto
 *  another coordinator, which no real transport does.) */
function unreachableRepo(peerIdStr: string): IRepo {
	const refuse = async (): Promise<never> => { throw new Error(`peer ${peerIdStr} is unreachable`); };
	return { get: refuse, pend: refuse, cancel: refuse, commit: refuse };
}

export interface DrivenTransactorOptions {
	timeoutMs?: number;
	abortOrCancelTimeoutMs?: number;
	/** Called with the peer-id string of every repo the transactor reaches for, reachable or not — so a spec
	 *  can assert that the driver, and only the driver, coordinated what it claims to. */
	onRoute?: (peerIdStr: string) => void;
}

/**
 * A transactor driven BY `driver`: it asks `driver` to coordinate every read and write, and falls back to
 * the mesh's own proximity routing only when `driver` has been excluded (it failed, or is not in the
 * block's cohort).
 *
 * Why not `buildNetworkTransactors`: its per-node transactors are identical — each routes by proximity,
 * so "node B writes" and "node A writes" reach the same coordinator and exercise the same code. A
 * size-dependent defect in the coordinating path of one particular node would never be seen. Self-first
 * routing is also a shape production takes: a node in the block's cohort may coordinate its own writes.
 *
 * Reordering `findCluster` is how a PEND is steered: `NetworkTransactor.consolidateCoordinators` covers a
 * pend's blocks greedily over the cohort members in the order `findCluster` lists them, so listing the
 * driver first makes it the coordinator whenever it is a member. The cohort's MEMBERSHIP is untouched.
 */
export function transactorDrivenBy(mesh: Mesh, driver: MeshNode, options: DrivenTransactorOptions = {}): ITransactor {
	const driverId = driver.peerId.toString();
	const shared = mesh.keyNetwork;
	const keyNetwork: IKeyNetwork = {
		async findCoordinator(key, opts) {
			const excluded = (opts?.excludedPeers ?? []).some(peer => peer.toString() === driverId);
			if (!excluded && driverId in await shared.findCluster(key)) return driver.peerId;
			return await shared.findCoordinator(key, opts);
		},
		async findCluster(key) {
			const peers = await shared.findCluster(key);
			if (!(driverId in peers)) return peers;
			const { [driverId]: self, ...rest } = peers;
			return { [driverId]: self!, ...rest };
		}
	};
	return new NetworkTransactor({
		timeoutMs: options.timeoutMs ?? 5_000,
		abortOrCancelTimeoutMs: options.abortOrCancelTimeoutMs ?? 5_000,
		keyNetwork,
		getRepo: (peerId: DbPeerId) => {
			const peerIdStr = peerId.toString();
			options.onRoute?.(peerIdStr);
			if (isUnreachable(mesh, peerIdStr)) return unreachableRepo(peerIdStr);
			const node = mesh.nodes.find(n => n.peerId.toString() === peerIdStr);
			if (!node) throw new Error(`Unknown peer ${peerIdStr}`);
			return node.coordinatorRepo as unknown as IRepo;
		}
	});
}
