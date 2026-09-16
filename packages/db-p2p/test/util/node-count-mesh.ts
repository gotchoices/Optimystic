/**
 * The in-process mesh a spec builds when it runs a transaction scenario at a real deployment's machine
 * count (`transaction-node-count-sweep.spec.ts`, `member-leaves-and-returns.spec.ts`), plus the per-node
 * plumbing such a spec needs and the harness does not provide: a transactor that is genuinely driven BY a
 * given node, a way to make one node unreachable from everybody at once, and a record of every pend and
 * commit a scenario issued, checkable against each node's own storage.
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
import { expect } from 'chai';
import {
	NetworkTransactor, SyncRetryExhaustedError, routingKeyForBlock,
	type ActionId, type BlockId, type CommitRequest, type CommitResult, type IKeyNetwork, type IRepo, type ITransactor,
	type PendRequest, type PendResult, type PeerId as DbPeerId
} from '@optimystic/db-core';
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

// ── What a scenario issued, and what storage holds ───────────────────────────────────────────────────

/** One pend or commit the Tree layer issued through a transactor, and what came back. */
export interface Attempt {
	readonly kind: 'pend' | 'commit';
	readonly actionId: ActionId;
	readonly rev: number | undefined;
	readonly blockIds: readonly BlockId[];
	readonly result?: PendResult | CommitResult;
	readonly thrown?: unknown;
}

/** Forwards every call to `inner`, recording each pend and commit with its outcome (a thrown call is
 *  recorded and re-thrown untouched). Explicit delegation: `NetworkTransactor` is a class, so a spread
 *  would copy none of its methods. */
export function recording(inner: ITransactor, attempts: Attempt[]): ITransactor {
	const record = async <TReq, TRes extends PendResult | CommitResult>(
		kind: Attempt['kind'], request: TReq & { actionId: ActionId }, rev: number | undefined, blockIds: readonly BlockId[], run: () => Promise<TRes>
	): Promise<TRes> => {
		try {
			const result = await run();
			attempts.push({ kind, actionId: request.actionId, rev, blockIds, result });
			return result;
		} catch (thrown) {
			attempts.push({ kind, actionId: request.actionId, rev, blockIds, thrown });
			throw thrown;
		}
	};
	const wrapper: ITransactor = {
		get: gets => inner.get(gets),
		getStatus: refs => inner.getStatus(refs),
		cancel: ref => inner.cancel(ref),
		pend: (request: PendRequest) => record('pend', request, request.rev, [], () => inner.pend(request)),
		commit: (request: CommitRequest) => record('commit', request, request.rev, request.blockIds, () => inner.commit(request))
	};
	if (inner.queryClusterNominees) {
		wrapper.queryClusterNominees = blockId => inner.queryClusterNominees!(blockId);
	}
	return wrapper;
}

export const committed = (attempts: readonly Attempt[]): Attempt[] =>
	attempts.filter(a => a.kind === 'commit' && a.result?.success === true);

/** The nodes whose OWN storage holds every block of `commit` at (at least) its revision — read from each
 *  node's `StorageRepo` directly, so no cluster consult or read repair can manufacture the answer. */
export async function durableHolders(nodes: readonly MeshNode[], commit: Attempt): Promise<MeshNode[]> {
	const holders: MeshNode[] = [];
	for (const node of nodes) {
		let holdsAll = true;
		for (const blockId of commit.blockIds) {
			const entry = (await node.storageRepo.get({ blockIds: [blockId] }))[blockId];
			const rev = entry?.state?.latest?.rev;
			if (!entry?.block || rev === undefined || rev < commit.rev!) { holdsAll = false; break; }
		}
		if (holdsAll) holders.push(node);
	}
	return holders;
}

// ── The promise-phase refusal ────────────────────────────────────────────────────────────────────────

/**
 * The promise-phase shortfall, verbatim. This text is load-bearing wire text a downstream consumer matches
 * byte-for-byte (see the NOTE at the throw in `ClusterCoordinator.executeTransaction`), and is what
 * `cluster-coordinator-supermajority.spec.ts` (three peers) and `mesh-sanity.spec.ts` Suite 2 (three nodes)
 * already pin, so the numbers an application would branch on are parsed out of it here too.
 */
const SUPER_MAJORITY_SHORTFALL = /^Failed to get super-majority: (\d+)\/(\d+) approvals \(needed (\d+), (\d+) rejections\)$/;

export interface PromiseShortfall {
	approvals: number;
	peers: number;
	needed: number;
	rejections: number;
}

/**
 * Assert that `refusal` — what a `Tree` write threw — is the promise-phase shortfall in the shape an
 * application sees, and return its numbers.
 *
 * NOT the retry loop's `SyncRetryExhaustedError`: a promise-phase shortfall is thrown by the transactor, not
 * returned as a conflict, so `Collection.sync` does not retry it and it surfaces from the first attempt. The
 * transactor's aggregate carries the coordinator's own error as its `cause`.
 */
export function expectPromiseShortfall(refusal: unknown): PromiseShortfall {
	expect(refusal).to.be.instanceOf(Error);
	expect(refusal, `a promise shortfall is not retried: ${String((refusal as Error)?.message ?? refusal)}`).to.not.be.instanceOf(SyncRetryExhaustedError);
	const error = refusal as Error & { cause?: unknown };
	// This sentence is also a downstream consumer's retry discriminator — see backlog
	// `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text` before rewording it.
	expect(error.message, 'the transactor aggregate').to.match(/^Some peers did not complete: /);
	expect(error.cause, `the aggregate carries the coordinator's error as its cause: ${error.message}`).to.be.instanceOf(Error);
	const shortfall = SUPER_MAJORITY_SHORTFALL.exec((error.cause as Error).message);
	expect(shortfall, `the cause is the promise-phase shortfall: ${(error.cause as Error).message}`).to.not.equal(null);
	const [, approvals, peers, needed, rejections] = shortfall!.map(Number) as [number, number, number, number, number];
	return { approvals, peers, needed, rejections };
}
