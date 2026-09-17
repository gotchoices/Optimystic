/**
 * Tickets: bug-writer-and-cohort-disagree-on-where-a-block-lives (the measurement) and
 * routing-key-single-encoding (the fix) — the real-socket half.
 *
 * `routing-key-convention-divergence.spec.ts` pins that the writer and the servers route a block on one
 * coordinate, `H(utf8(id))`, on FRET's ring and on the mesh harness. The harness has no `RepoService` in
 * front of the coordinator, so it cannot show what production adds: `RepoService.checkRedirect` on every
 * REMOTE hop, and the writer's own node short-circuiting to its local `coordinatedRepo` with NO redirect
 * check when it picks itself.
 *
 * This spec stands up SIX real nodes with `clusterSize: 2` — three times more peers than the cohort holds —
 * drives a production-shaped `NetworkTransactor` (self → local coordinated repo, remote → `RepoClient`) from
 * one node, and records for every block: where the writer sent the pend, whether that hop was redirected, who
 * ended up holding the block, and whether the holders match the cohort the servers believe is responsible.
 * A second node then reads every block back, and the spec counts redirects and the replicas those reads left
 * behind — split by whether each landed inside the responsible cohort (read repair filling a responsible
 * peer's gap) or outside it (a soft-served read acquiring a block its node is not responsible for).
 *
 * Pinned since `cohort-assembly-self-only-when-nearest`: the writer's node is in a block's cohort only when it
 * is among the nearest `clusterSize` serving peers, and its coordinator pick comes from that same ordered
 * cohort. So every block lands on exactly its responsible peers — no copy on the writer's node when it is not
 * responsible, no responsible peer left without one — and the pick is never a neighbour just outside the cohort.
 *
 * Pinned since `writer-and-harness-route-to-the-cohort`: the writer coordinates a pend locally exactly when it is
 * responsible (the transactor breaks a coverage tie toward `localPeerId`), and a multi-block write whose blocks
 * have disjoint cohorts goes out as one batch per cohort and lands on exactly each block's cohort — the shape
 * that became reachable in production once the writer stopped being in every cohort.
 *
 * Pinned since `coordinator-refuses-blocks-it-is-not-responsible-for`: every server's redirect check asks its own
 * key network, the rule the writer routes by, so no write is redirected — the writer already picked inside the
 * cohort, and a second rule no longer second-guesses it.
 *
 * Gated on OPTIMYSTIC_INTEGRATION=1 like the other integration specs:
 *   OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test:integration -- --grep "routing-key convention"
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo, BlockContentDigests, PeerId as DbPeerId } from '@optimystic/db-core';
import { canonicalBlockHash, routingKeyForBlock, NetworkTransactor } from '@optimystic/db-core';
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

const mergeTransforms = (blockIds: string[]): Transforms => ({
	inserts: Object.fromEntries(blockIds.map(id => [id, makeBlock(id)])),
	updates: {},
	deletes: []
});

/** Two block ids whose cohorts, as `keyNetwork` assembles them, share no member — each with its cohort. */
async function disjointCohortPair(keyNetwork: { findCluster(key: Uint8Array): Promise<Record<string, unknown>> }): Promise<Array<{ id: string; cohort: string[] }>> {
	const cohortOf = async (id: string): Promise<string[]> => Object.keys(await keyNetwork.findCluster(routingKeyForBlock(id)));
	const first = { id: 'conv-it-multi-a', cohort: await cohortOf('conv-it-multi-a') };
	for (let i = 0; i < 200; i++) {
		const id = `conv-it-multi-b-${i}`;
		const cohort = await cohortOf(id);
		if (cohort.length > 0 && !cohort.some(p => first.cohort.includes(p))) return [first, { id, cohort }];
	}
	throw new Error(`no block id among 200 has a cohort disjoint from ${first.cohort.join(',')}`);
}

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

	it('a production-shaped transactor: where writes go, where they land, and what reads cost', async () => {
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
				: RepoClient.create(peerId as any, keyNetwork, protocolPrefix),
			localPeerId: driver.peerId
		});

		const rows: Array<Record<string, unknown>> = [];
		/** The servers' responsible cohort for each block, kept for the read-side split below. */
		const serverCohorts = new Map<string, Set<string>>();
		let failures = 0;
		for (let i = 0; i < BLOCKS; i++) {
			const id = `conv-it-block-${i}`;
			const routingKey = routingKeyForBlock(id);
			const before = decisions.length;
			const handledBefore = handled.length;
			// What the writer will route on, exactly as NetworkTransactor asks for it, BEFORE the write so
			// no redirect-learned coordinator hint has been recorded for this key yet.
			const writerPick = (await keyNetwork.findCoordinator(routingKey, { excludedPeers: [] })).toString();
			// The writer-side cohort `consolidateCoordinators` chooses the pend coordinator from, in the
			// order it iterates (proximity order; self present only when it is among the nearest).
			const writerCohortOrder = Object.keys(await keyNetwork.findCluster(routingKey));
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

			// The responsible cohort: `findCluster` on the routing key, the one question the writer, every server's
			// redirect check and every coordinator's responsibility check ask. Asked after the write, so it is the
			// cohort the write had to land on.
			const coordinatorView = Object.keys(await keyNetwork.findCluster(routingKey));
			const cohort = new Set(coordinatorView);
			serverCohorts.set(id, cohort);
			const holders = await holdersOf(mesh, id);
			const mine = decisions.slice(before).filter(d => d.blockKey === id);
			const ops = handled.slice(handledBefore).filter(h => h.blockIds.includes(id));
			const pendBy = ops.filter(h => h.op === 'pend').map(h => `${h.node.substring(8, 14)}${h.local ? '*' : ''}`);
			rows.push({
				block: i,
				outcome,
				findCoordinator: writerPick.substring(8, 14),
				pickInCohort: cohort.has(writerPick),
				writerCohort: writerCohortOrder.map(p => p.substring(8, 14)).join(','),
				pendHandledBy: pendBy.join(','),
				pendLocal: ops.some(h => h.op === 'pend' && h.local),
				remoteChecks: mine.length,
				redirects: mine.filter(d => d.redirected).length,
				serverCohort: coordinatorView.map(p => p.substring(8, 14)).join(','),
				driverInCohort: cohort.has(driverId),
				holders: holders.length,
				holdersOutside: holders.filter(h => !cohort.has(h)).length,
				cohortMissing: [...cohort].filter(c => !holders.includes(c)).length
			});
		}
		console.log(`[convention-it] ${NODE_COUNT} nodes, clusterSize ${CLUSTER_SIZE}, driver=${driverId.substring(8, 14)} (* = handled locally, no RepoService)`);
		console.table(rows);
		const summary = {
			blocks: BLOCKS,
			failures,
			writerPickOutsideCohort: rows.filter(r => !r.pickInCohort).length,
			pendHandledLocally: rows.filter(r => r.pendLocal).length,
			driverInCohort: rows.filter(r => r.driverInCohort).length,
			blocksRedirected: rows.filter(r => (r.redirects as number) > 0).length,
			totalRedirects: rows.reduce((s, r) => s + (r.redirects as number), 0),
			blocksWithPhantomHolder: rows.filter(r => (r.holdersOutside as number) > 0).length,
			blocksWithCohortGap: rows.filter(r => (r.cohortMissing as number) > 0).length
		};
		console.log('[convention-it] write summary', summary);

		// One pend carrying two blocks whose cohorts share no member: no single coordinator covers both, so the
		// write must go out as two batches, each to its own block's cohort, and commit onto exactly those cohorts.
		const multi = await disjointCohortPair(keyNetwork);
		const multiHandledBefore = handled.length;
		const multiPend = await transactor.pend({ actionId: 'act-multi', transforms: mergeTransforms(multi.map(b => b.id)), policy: 'c' });
		expect(multiPend.success, `multi-block pend: ${JSON.stringify(multiPend)}`).to.equal(true);
		const multiCommit = await transactor.commit({
			actionId: 'act-multi', tailId: multi[0]!.id as BlockId, rev: 1,
			blockIds: multi.map(b => b.id as BlockId),
			blockDigests: Object.assign({}, ...await Promise.all(multi.map(b => makeBlockDigests(b.id))))
		});
		expect(multiCommit.success, `multi-block commit: ${JSON.stringify(multiCommit)}`).to.equal(true);
		const multiPends = handled.slice(multiHandledBefore).filter(h => h.op === 'pend');
		const multiRows = await Promise.all(multi.map(async b => ({
			block: b.id,
			cohort: b.cohort.map(p => p.substring(8, 14)).join(','),
			pendHandledBy: multiPends.filter(h => h.blockIds.includes(b.id)).map(h => `${h.node.substring(8, 14)}${h.local ? '*' : ''}`).join(','),
			holders: (await holdersOf(mesh, b.id)).map(p => p.substring(8, 14)).join(',')
		})));
		console.log('[convention-it] multi-block write across disjoint cohorts:');
		console.table(multiRows);
		expect(new Set(multiPends.map(h => h.node)).size, 'the pend went out as one batch per disjoint cohort').to.equal(multi.length);
		for (const b of multi) {
			const coordinators = multiPends.filter(h => h.blockIds.includes(b.id)).map(h => h.node);
			expect(coordinators, `${b.id}: pended by exactly one coordinator`).to.have.length(1);
			expect(b.cohort, `${b.id}: its coordinator is a member of its cohort`).to.include(coordinators[0]);
			expect((await holdersOf(mesh, b.id)).sort(), `${b.id}: held by exactly its cohort`).to.deep.equal([...b.cohort].sort());
		}

		const holdersBeforeReads = new Map<string, Set<string>>();
		for (let i = 0; i < BLOCKS; i++) holdersBeforeReads.set(`conv-it-block-${i}`, new Set(await holdersOf(mesh, `conv-it-block-${i}`)));

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
				: RepoClient.create(peerId as any, readerKeyNetwork, protocolPrefix),
			localPeerId: reader.peerId
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
		// `CoordinatorRepo.get`). Split the replicas reads left behind by where they landed.
		let blocksGrownByReads = 0, replicasAddedInsideCohort = 0, replicasAddedOutsideCohort = 0;
		for (let i = 0; i < BLOCKS; i++) {
			const id = `conv-it-block-${i}`;
			const before = holdersBeforeReads.get(id)!;
			const added = (await holdersOf(mesh, id)).filter(h => !before.has(h));
			if (added.length > 0) blocksGrownByReads++;
			const cohort = serverCohorts.get(id)!;
			for (const h of added) {
				if (cohort.has(h)) replicasAddedInsideCohort++;
				else replicasAddedOutsideCohort++;
			}
		}
		const readSummary = {
			readOk, readMiss, readThrew,
			getsHandledRemotely: handled.filter(h => h.op === 'get' && !h.local).length,
			getChecks: decisions.filter(d => d.op === 'get').length,
			getRedirects: decisions.filter(d => d.op === 'get' && d.redirected).length,
			blocksGrownByReads,
			replicasAddedInsideCohort,
			replicasAddedOutsideCohort
		};
		console.log('[convention-it] read summary', readSummary);

		// Pinned by routing-key-single-encoding: no read is redirected, and no read leaves a replica on a node
		// outside the responsible cohort.
		expect(readSummary.getRedirects, 'reads reach a responsible peer, so none is redirected').to.equal(0);
		expect(readSummary.replicasAddedOutsideCohort, 'no read acquires a replica outside the responsible cohort').to.equal(0);

		// Pinned by cohort-assembly-self-only-when-nearest: the writer's key network puts self in a block's cohort
		// only when self is among the nearest clusterSize serving peers, and picks the coordinator from that same
		// ordered cohort. So no pick lands outside the cohort, every responsible peer receives every block, and no
		// block is left on a node that is not responsible for it.
		expect(summary.writerPickOutsideCohort, 'the writer\'s pick is inside the responsible cohort for every block').to.equal(0);
		expect(summary.blocksWithCohortGap, 'every responsible peer holds every block').to.equal(0);
		expect(summary.blocksWithPhantomHolder, 'no block is held by a node outside its cohort').to.equal(0);
		// Pinned by writer-and-harness-route-to-the-cohort: the transactor breaks a coverage tie toward its own
		// node, so a pend is coordinated locally exactly when the writer is responsible — no hop when it need not.
		expect(summary.pendHandledLocally, 'a pend is coordinated by the writer\'s own node exactly when it is responsible')
			.to.equal(summary.driverInCohort);
		// Pinned by coordinator-refuses-blocks-it-is-not-responsible-for: the servers' redirect check applies the writer's
		// rule, so a write the writer routed inside the cohort is never sent elsewhere.
		expect(summary.blocksRedirected, 'no write is redirected').to.equal(0);
		expect(failures, 'writes complete').to.equal(0);
		expect(readOk, 'reads complete').to.equal(BLOCKS);
	});
});
