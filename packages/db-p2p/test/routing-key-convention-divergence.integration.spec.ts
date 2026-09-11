/**
 * Ticket: bug-writer-and-cohort-disagree-on-where-a-block-lives — the real-socket half.
 *
 * `routing-key-convention-divergence.spec.ts` shows the writer's coordinate (`H(H(id))`) and the
 * servers' coordinate (`H(id)`) pick different cohorts on FRET's ring, and that on the mesh harness
 * a misrouted write silently succeeds with the wrong coordinator as an extra, out-of-cohort holder.
 * The harness has no `RepoService` in front of the coordinator, so it cannot show what production
 * adds: `RepoService.checkRedirect` on every REMOTE hop (keyed on `H(id)`), and the writer's own
 * node short-circuiting to its local `coordinatedRepo` with NO redirect check when it picks itself.
 *
 * This spec stands up SIX real nodes with `clusterSize: 2` — three times more peers than the
 * cohort holds — drives a production-shaped `NetworkTransactor` (self → local coordinated repo,
 * remote → `RepoClient`) from one node, and records for every block: where the writer sent the
 * pend, whether that hop was redirected, who ended up holding the block, and whether the holders
 * match the `H(id)` cohort the servers believe is responsible.
 *
 * Gated on OPTIMYSTIC_INTEGRATION=1 like the other integration specs:
 *   OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test:integration -- --grep "routing-key convention"
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo, BlockContentDigests, PeerId as DbPeerId } from '@optimystic/db-core';
import { canonicalBlockHash, blockIdToBytes, NetworkTransactor } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { multiaddr } from '@multiformats/multiaddr';
import { hashKey } from 'p2p-fret';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';
import { RepoClient } from '../src/repo/client.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

const NETWORK_NAME = 'routing-convention-it';
const NODE_COUNT = 6;
const CLUSTER_SIZE = 2;
const BLOCKS = 24;

const utf8 = new TextEncoder();

const makeHeader = (id: string): BlockHeader => ({ id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId });
const makeBlock = (id: string): IBlock => ({ header: makeHeader(id) });
const makeTransforms = (blockId: string): Transforms => ({ inserts: { [blockId]: makeBlock(blockId) }, updates: {}, deletes: [] });
const makeBlockDigests = async (blockId: string): Promise<BlockContentDigests> => ({
	[blockId]: { digest: await canonicalBlockHash(makeBlock(blockId)) }
});

async function fullMeshDial(meshNodes: Libp2p[]): Promise<void> {
	const addrs = meshNodes.map(pickLocalTcpMultiaddr);
	for (let i = 0; i < meshNodes.length; i++) {
		for (let j = 0; j < meshNodes.length; j++) {
			if (i === j) continue;
			try { await meshNodes[i]!.dial(multiaddr(addrs[j]!)); } catch { /* a reciprocal dial covers this edge */ }
		}
	}
}

interface RedirectDecision { node: string; op: string; blockKey: string; redirected: boolean }

describe('routing-key convention over real libp2p (6 nodes, clusterSize 2)', function () {
	this.timeout(300_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];
	const decisions: RedirectDecision[] = [];

	async function spawnNode(overrides: Partial<NodeOptions> = {}): Promise<Libp2p> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: CLUSTER_SIZE,
			// Same posture as real-libp2p.integration.spec.ts: a forming ring must be allowed to
			// transact while views settle. Tolerance 1.0 keeps admission out of the picture so what
			// is measured here is ROUTING, not the gate's reaction to it (the unit spec covers that:
			// under the production default 0.5 a single phantom member is admitted anyway).
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: true },
			...overrides
		});
		nodes.push(node);
		return node;
	}

	afterEach(async () => {
		const toStop = nodes;
		nodes = [];
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	/** Every repo op that reached a node's coordinated repo — remotely (via RepoService) or locally. */
	const handled: Array<{ node: string; op: string; blockIds: string[]; local: boolean }> = [];

	const recordingRepo = (repo: IRepo, node: string, local: boolean): IRepo => ({
		get: (req, opts) => { handled.push({ node, op: 'get', blockIds: [...req.blockIds], local }); return repo.get(req, opts); },
		pend: (req, opts) => {
			const ids = [...Object.keys(req.transforms.inserts ?? {}), ...Object.keys(req.transforms.updates ?? {}), ...(req.transforms.deletes ?? [])];
			handled.push({ node, op: 'pend', blockIds: ids, local });
			return repo.pend(req, opts);
		},
		cancel: (ref, opts) => repo.cancel(ref, opts),
		commit: (req, opts) => { handled.push({ node, op: 'commit', blockIds: [...req.blockIds], local }); return repo.commit(req, opts); }
	});

	/**
	 * Every node's RepoService, instrumented: `checkRedirect` records its decision, and the repo the
	 * service dispatches into records which ops arrived over the wire. (The service's `repo` is the
	 * served-repo proxy; replacing the field keeps the proxy's own closure over `coordinatedRepo`.)
	 */
	function instrumentServices(meshNodes: Libp2p[]): void {
		for (const n of meshNodes) {
			const svc = (n as any).services.repo;
			const original = svc.checkRedirect.bind(svc);
			svc.checkRedirect = async (blockKey: string, opName: string, message: unknown) => {
				const r = await original(blockKey, opName, message);
				decisions.push({ node: n.peerId.toString(), op: opName, blockKey, redirected: r != null });
				return r;
			};
			const proxy = svc.repo as IRepo;
			svc.repo = { ...proxy, ...recordingRepo(proxy, n.peerId.toString(), false) };
		}
	}

	const holdersOf = async (meshNodes: Libp2p[], id: string): Promise<string[]> => {
		const out: string[] = [];
		for (const n of meshNodes) {
			const r = await (n as any).storageRepo.get({ blockIds: [id] }, { skipClusterFetch: true });
			if (r[id]?.state?.latest) out.push(n.peerId.toString());
		}
		return out;
	};

	it('a production-shaped transactor: where writes go, where they land, and what it costs', async () => {
		const a = await spawnNode();
		const bootstrapAddr = pickLocalTcpMultiaddr(a);
		for (let i = 1; i < NODE_COUNT; i++) await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });
		const mesh = nodes.slice();

		await fullMeshDial(mesh);
		await waitFor(() => mesh.every(n => n.getPeers().length >= NODE_COUNT - 1), { timeoutMs: 30_000, intervalMs: 250, description: `the ${NODE_COUNT}-node mesh fully connected` });

		const fretOf = (n: Libp2p): { assembleCohort(coord: Uint8Array, wants: number): string[] } => (n as any).services.fret;
		const probeCoord = await hashKey(utf8.encode('routing-convention-fret-probe'));
		await waitFor(() => {
			const ref = new Set(fretOf(a).assembleCohort(probeCoord, mesh.length));
			if (ref.size !== mesh.length) return false;
			for (const n of mesh) {
				const seen = new Set(fretOf(n).assembleCohort(probeCoord, mesh.length));
				if (seen.size !== mesh.length) return false;
				for (const id of ref) if (!seen.has(id)) return false;
			}
			return true;
		}, { timeoutMs: 90_000, intervalMs: 500, description: `FRET stabilized the ${NODE_COUNT}-node ring` });

		instrumentServices(mesh);

		// The writer: exactly how reference-peer/cli.ts and the Quereus plugin wire it — self goes
		// straight to the local coordinated repo (no RepoService, no redirect check in the way).
		const driver = mesh[NODE_COUNT - 1]!;
		const driverId = driver.peerId.toString();
		const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
		const keyNetwork = (driver as any).keyNetwork;
		const localRepo = recordingRepo((driver as any).coordinatedRepo as IRepo, driverId, true);
		const transactor = new NetworkTransactor({
			timeoutMs: 30_000,
			abortOrCancelTimeoutMs: 5_000,
			dialTimeoutMs: 3_000,
			keyNetwork,
			getRepo: (peerId: DbPeerId) => peerId.toString() === driverId
				? localRepo
				: RepoClient.create(peerId as any, keyNetwork, protocolPrefix)
		});

		const nm: { getCluster(key: Uint8Array): Promise<Array<{ toString(): string }>> } = (driver as any).services.networkManager;

		const rows: Array<Record<string, unknown>> = [];
		let failures = 0;
		for (let i = 0; i < BLOCKS; i++) {
			const id = `conv-it-block-${i}`;
			const before = decisions.length;
			const handledBefore = handled.length;
			// What the writer will route on, computed the way NetworkTransactor does, BEFORE the write
			// so no redirect-learned coordinator hint has been recorded for this key yet.
			const writerPick = (await keyNetwork.findCoordinator(await blockIdToBytes(id as BlockId), { excludedPeers: [] })).toString();
			// The writer-side cohort `consolidateCoordinators` chooses the pend coordinator from, in the
			// order it iterates (self-first on the membership-scoped path).
			const writerCohortOrder = Object.keys(await keyNetwork.findCluster(await blockIdToBytes(id as BlockId)));
			let outcome = 'ok';
			try {
				const pend = await transactor.pend({ actionId: `act-${i}`, transforms: makeTransforms(id), policy: 'c' });
				if (!pend.success) outcome = `pend-failed:${JSON.stringify(pend)}`;
				else {
					const commit = await transactor.commit({ actionId: `act-${i}`, tailId: id as BlockId, rev: 1, blockIds: [id as BlockId], blockDigests: await makeBlockDigests(id) });
					if (!commit.success) outcome = `commit-failed:${JSON.stringify(commit)}`;
				}
			} catch (e) {
				outcome = `threw:${(e as Error).message.substring(0, 80)}`;
			}
			if (outcome !== 'ok') failures++;

			// The servers' answer, two ways: the redirect check's `getCluster` (FRET cohort at H(id), no
			// self) and the coordinator's own `findCluster` (same coordinate, self always included).
			const cohort = new Set((await nm.getCluster(utf8.encode(id))).map(p => p.toString()));
			const coordinatorView = Object.keys(await keyNetwork.findCluster(utf8.encode(id)));
			const holders = await holdersOf(mesh, id);
			const mine = decisions.slice(before).filter(d => d.blockKey === id);
			const ops = handled.slice(handledBefore).filter(h => h.blockIds.includes(id));
			const pendBy = ops.filter(h => h.op === 'pend').map(h => `${h.node.substring(8, 14)}${h.local ? '*' : ''}`);
			rows.push({
				block: i,
				outcome,
				findCoordinator: writerPick.substring(8, 14),
				writerCohort: writerCohortOrder.map(p => p.substring(8, 14)).join(','),
				pendHandledBy: pendBy.join(','),
				pendLocal: ops.some(h => h.op === 'pend' && h.local),
				remoteChecks: mine.length,
				redirects: mine.filter(d => d.redirected).length,
				serverCohort: [...cohort].map(p => p.substring(8, 14)).join(','),
				coordinatorView: coordinatorView.map(p => p.substring(8, 14)).join(','),
				driverInCohort: cohort.has(driverId),
				holders: holders.length,
				holdersOutside: holders.filter(h => !cohort.has(h)).length,
				cohortMissing: [...cohort].filter(c => !holders.includes(c)).length
			});
		}
		console.log(`[divergence-it] ${NODE_COUNT} nodes, clusterSize ${CLUSTER_SIZE}, driver=${driverId.substring(8, 14)} (* = handled locally, no RepoService)`);
		console.table(rows);
		const summary = {
			blocks: BLOCKS,
			failures,
			pendHandledLocally: rows.filter(r => r.pendLocal).length,
			driverInCohort: rows.filter(r => r.driverInCohort).length,
			blocksRedirected: rows.filter(r => (r.redirects as number) > 0).length,
			totalRedirects: rows.reduce((s, r) => s + (r.redirects as number), 0),
			blocksWithPhantomHolder: rows.filter(r => (r.holdersOutside as number) > 0).length,
			blocksWithCohortGap: rows.filter(r => (r.cohortMissing as number) > 0).length
		};
		console.log('[divergence-it] write summary', summary);
		const holdersBeforeReads = new Map<string, number>();
		for (let i = 0; i < BLOCKS; i++) holdersBeforeReads.set(`conv-it-block-${i}`, (await holdersOf(mesh, `conv-it-block-${i}`)).length);

		// Reads, from a DIFFERENT client node, through its own production-shaped transactor.
		decisions.length = 0;
		const reader = mesh[0]!;
		const readerId = reader.peerId.toString();
		const readerKeyNetwork = (reader as any).keyNetwork;
		const readTransactor = new NetworkTransactor({
			timeoutMs: 30_000, abortOrCancelTimeoutMs: 5_000, dialTimeoutMs: 3_000,
			keyNetwork: readerKeyNetwork,
			getRepo: (peerId: DbPeerId) => peerId.toString() === readerId
				? (reader as any).coordinatedRepo as IRepo
				: RepoClient.create(peerId as any, readerKeyNetwork, protocolPrefix)
		});
		handled.length = 0;
		let readOk = 0, readMiss = 0, readThrew = 0;
		for (let i = 0; i < BLOCKS; i++) {
			const id = `conv-it-block-${i}`;
			try {
				const r = await readTransactor.get({ blockIds: [id as BlockId] });
				if (r[id as BlockId]?.block?.header.id === id) readOk++; else readMiss++;
			} catch { readThrew++; }
		}
		// A read served by a node that did not hold the block acquires it (see the NOTE on
		// `CoordinatorRepo.get`): count the replicas reads left behind.
		let grownByReads = 0, blocksGrown = 0;
		for (let i = 0; i < BLOCKS; i++) {
			const id = `conv-it-block-${i}`;
			const delta = (await holdersOf(mesh, id)).length - holdersBeforeReads.get(id)!;
			if (delta > 0) { blocksGrown++; grownByReads += delta; }
		}
		const readSummary = {
			readOk, readMiss, readThrew,
			getsHandledRemotely: handled.filter(h => h.op === 'get' && !h.local).length,
			getChecks: decisions.filter(d => d.op === 'get').length,
			getRedirects: decisions.filter(d => d.op === 'get' && d.redirected).length,
			blocksGrownByReads: blocksGrown,
			replicasAddedByReads: grownByReads
		};
		console.log('[divergence-it] read summary', readSummary);

		// Pinned: the writer's own node coordinates its own pends (no RepoService, no redirect
		// check ever sees a write), and the write is placed on the writer's node plus only
		// (clusterSize - 1) genuinely responsible peers — so whenever the writer is not itself
		// responsible, one responsible peer never receives the block. Writes and reads still
		// complete. Everything else is reported above for the ticket.
		expect(summary.pendHandledLocally, 'every pend is coordinated by the writer\'s own node').to.equal(BLOCKS);
		expect(summary.blocksWithCohortGap, 'each block whose writer is not responsible leaves one responsible peer without it')
			.to.equal(BLOCKS - summary.driverInCohort);
		expect(failures, 'writes complete despite the misroute').to.equal(0);
		expect(readOk, 'reads complete despite the misroute').to.equal(BLOCKS);
	});
});
