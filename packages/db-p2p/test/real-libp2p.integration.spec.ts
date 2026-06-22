import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { hashKey } from 'p2p-fret';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { RepoClient } from '../src/repo/client.js';

// Real-libp2p integration smoke tests. Exercises the production transport wiring
// (createLibp2pNode + RestorationCoordinator + Libp2pKeyPeerNetwork) end-to-end
// over actual TCP so transport-level regressions that mocks cannot catch (ticket-4
// "solo node / no listen addrs / dial-self hang" class) fail loudly here.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 so default `npm test` stays fast. Run via:
//   OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p
// Windows (PowerShell):
//   $env:OPTIMYSTIC_INTEGRATION=1; npm run test:integration --workspace @optimystic/db-p2p

const NETWORK_NAME = 'real-libp2p-it';

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({
	header: makeHeader(id)
});

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

async function pendCommitGet(
	repo: IRepo,
	blockId: string,
	actionId: string,
	rev: number
) {
	const pendResult = await repo.pend({
		actionId,
		transforms: makeTransforms(blockId),
		policy: 'c'
	});
	expect(pendResult.success, `pend(${blockId})`).to.equal(true);

	const commitResult = await repo.commit({
		actionId,
		tailId: blockId as BlockId,
		rev,
		blockIds: [blockId as BlockId]
	} as any);
	expect(commitResult.success, `commit(${blockId})`).to.equal(true);

	const getResult = await repo.get({ blockIds: [blockId as BlockId] });
	expect(getResult[blockId]?.block?.header.id, `get(${blockId})`).to.equal(blockId);
	return getResult;
}

function pickLocalTcpMultiaddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

async function waitForPeers(node: Libp2p, minPeers: number, timeoutMs: number): Promise<void> {
	if (node.getPeers().length >= minPeers) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			node.removeEventListener('peer:connect', check);
			reject(new Error(`Timeout waiting for ${minPeers} peers after ${timeoutMs}ms`));
		}, timeoutMs);
		const check = () => {
			if (node.getPeers().length >= minPeers) {
				clearTimeout(timer);
				node.removeEventListener('peer:connect', check);
				resolve();
			}
		};
		node.addEventListener('peer:connect', check);
	});
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Poll `predicate` until truthy or `timeoutMs` elapses (bounded async settle, no fixed sleeps). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await delay(intervalMs);
	}
}

/** Establish a full mesh of warm connections: every node dials every other node's TCP addr. */
async function fullMeshDial(meshNodes: Libp2p[]): Promise<void> {
	const addrs = meshNodes.map(pickLocalTcpMultiaddr);
	for (let i = 0; i < meshNodes.length; i++) {
		for (let j = 0; j < meshNodes.length; j++) {
			if (i === j) continue;
			try { await meshNodes[i]!.dial(multiaddr(addrs[j]!)); } catch { /* a reciprocal dial covers this edge */ }
		}
	}
}

describe('Real libp2p integration', function () {
	// Individual ops should finish in seconds; boot + arachnode init dominates.
	this.timeout(30_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];

	async function spawnNode(overrides: Partial<NodeOptions> = {}): Promise<Libp2p> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: {
				allowDownsize: true,
				sizeTolerance: 1.0
			},
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

	it('solo node, empty bootstrap, no listen addrs (ticket-4 reproducer)', async function () {
		this.timeout(15_000);
		const node = await spawnNode({ listenAddrs: [] });
		const repo = (node as any).coordinatedRepo as IRepo;
		expect(repo, 'coordinatedRepo').to.exist;

		await pendCommitGet(repo, 'optimystic/schema', 'schema-a1', 1);
	});

	it('solo node, default TCP listen addr (port: 0)', async function () {
		this.timeout(15_000);
		const node = await spawnNode();
		const repo = (node as any).coordinatedRepo as IRepo;

		await pendCommitGet(repo, 'optimystic/schema', 'schema-default-a1', 1);
	});

	it('two-node mesh over TCP', async function () {
		this.timeout(20_000);
		const a = await spawnNode();
		const bootstrapAddr = pickLocalTcpMultiaddr(a);

		const b = await spawnNode({
			bootstrapNodes: [bootstrapAddr],
			fretProfile: 'core'
		});

		await waitForPeers(b, 1, 5_000);

		const aRepo = (a as any).coordinatedRepo as IRepo;
		const bRepo = (b as any).coordinatedRepo as IRepo;

		const blockId = 'two-node-block';
		const pendResult = await aRepo.pend({
			actionId: 'two-a1',
			transforms: makeTransforms(blockId),
			policy: 'c'
		});
		expect(pendResult.success, 'A.pend').to.equal(true);

		const commitResult = await aRepo.commit({
			actionId: 'two-a1',
			tailId: blockId as BlockId,
			rev: 1,
			blockIds: [blockId as BlockId]
		} as any);
		expect(commitResult.success, 'A.commit').to.equal(true);

		const bResult = await bRepo.get({ blockIds: [blockId as BlockId] });
		// B either has the block via replication/restore OR a defined empty-state entry —
		// the smoke test here is "no hang and no transport error", which a successful return satisfies.
		expect(bResult[blockId], 'B.get returns an entry for the block').to.exist;
	});

	it('three-node mesh with one peer dropped at boot', async function () {
		this.timeout(25_000);
		const a = await spawnNode({
			clusterSize: 2,
			clusterPolicy: {
				allowDownsize: true,
				sizeTolerance: 1.0,
				superMajorityThreshold: 0.51
			}
		});
		const bootstrapAddr = pickLocalTcpMultiaddr(a);

		const b = await spawnNode({
			bootstrapNodes: [bootstrapAddr],
			clusterSize: 2,
			clusterPolicy: {
				allowDownsize: true,
				sizeTolerance: 1.0,
				superMajorityThreshold: 0.51
			},
			fretProfile: 'core'
		});

		const c = await spawnNode({
			bootstrapNodes: [bootstrapAddr],
			clusterSize: 2,
			clusterPolicy: {
				allowDownsize: true,
				sizeTolerance: 1.0,
				superMajorityThreshold: 0.51
			},
			fretProfile: 'core'
		});

		// Drop C immediately to simulate peer that vanishes during join.
		await c.stop();
		// Remove from nodes[] so afterEach does not double-stop.
		nodes = nodes.filter(n => n !== c);

		await waitForPeers(b, 1, 5_000);

		const aRepo = (a as any).coordinatedRepo as IRepo;
		const bRepo = (b as any).coordinatedRepo as IRepo;

		const blockId = 'three-node-dropped';
		const pendResult = await aRepo.pend({
			actionId: 'drop-a1',
			transforms: makeTransforms(blockId),
			policy: 'c'
		});
		expect(pendResult.success, 'A.pend with C dropped').to.equal(true);

		const commitResult = await aRepo.commit({
			actionId: 'drop-a1',
			tailId: blockId as BlockId,
			rev: 1,
			blockIds: [blockId as BlockId]
		} as any);
		expect(commitResult.success, 'A.commit with C dropped').to.equal(true);

		const bResult = await bRepo.get({ blockIds: [blockId as BlockId] });
		expect(bResult[blockId], 'B.get after C dropped').to.exist;
	});

	it('cold-restart over real transport with shared storage', async function () {
		this.timeout(20_000);
		const storage = new MemoryRawStorage();
		const privateKey = await generateKeyPair('Ed25519');

		const node1 = await spawnNode({
			listenAddrs: [],
			storage,
			privateKey
		});
		const repo1 = (node1 as any).coordinatedRepo as IRepo;

		const blockId = 'cold-restart-block';
		const pend = await repo1.pend({
			actionId: 'cold-a1',
			transforms: makeTransforms(blockId),
			policy: 'c'
		});
		expect(pend.success, 'pre-restart pend').to.equal(true);
		const commit = await repo1.commit({
			actionId: 'cold-a1',
			tailId: blockId as BlockId,
			rev: 1,
			blockIds: [blockId as BlockId]
		} as any);
		expect(commit.success, 'pre-restart commit').to.equal(true);

		await node1.stop();
		nodes = nodes.filter(n => n !== node1);

		const node2 = await spawnNode({
			listenAddrs: [],
			storage,
			privateKey
		});
		const repo2 = (node2 as any).coordinatedRepo as IRepo;

		const result = await repo2.get({ blockIds: [blockId as BlockId] });
		expect(result[blockId]?.block?.header.id, 'post-restart get').to.equal(blockId);
	});

	// Running-mesh repo-redirect round trip (optimystic-repo-redirect-key-derivation).
	// Proves the un-inerted RepoService.checkRedirect path end-to-end over real TCP:
	//   1. A repo `get` is dialed to a node E that is NOT in the block's responsible set.
	//   2. E's RepoService.checkRedirect — keyed on the RAW encoded block id, the same
	//      coordinate the cluster coordinator's findCluster(encode(blockId)) derives —
	//      computes the cohort, finds itself absent, and returns a RedirectPayload.
	//   3. The RepoClient follows the redirect (client.ts max-2-hop) to the responsible
	//      peer R, which IS a member and serves the committed block.
	// The driver node D (≠ E, ≠ R) issues the client so neither hop is a self-dial.
	//
	// Block selection is FRET-derived, not hard-coded: after the 3-node ring stabilizes
	// we probe E's NetworkManagerService.getCluster (the exact call checkRedirect makes)
	// for a block id whose size-1 cohort excludes E — guaranteeing a real redirect fires.
	it('redirect round-trip: a repo op to a non-responsible node redirects and completes on the responsible peer', async function () {
		this.timeout(90_000);

		// clusterSize 1 → getCluster's cohort is the single FRET-nearest peer, so for any
		// block exactly one node is responsible and the other two are non-members.
		const a = await spawnNode({ clusterSize: 1 });
		const bootstrapAddr = pickLocalTcpMultiaddr(a);
		const b = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core', clusterSize: 1 });
		const c = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core', clusterSize: 1 });
		const mesh = [a, b, c];

		await fullMeshDial(mesh);
		const connected = await waitFor(() => mesh.every(n => n.getPeers().length >= 2), 30_000, 250);
		expect(connected, 'the 3-node mesh fully connected').to.equal(true);

		// Wait for real FRET two-sided stabilization: every node must rank the same whole
		// ring (assembleCohort is not cached, so this is a clean readiness probe).
		const fretOf = (n: Libp2p): { assembleCohort(coord: Uint8Array, wants: number): string[] } =>
			(n as any).services.fret;
		const probeCoord = await hashKey(new TextEncoder().encode('redirect-rt-fret-probe'));
		const stabilized = await waitFor(() => {
			const ref = new Set(fretOf(a).assembleCohort(probeCoord, mesh.length));
			if (ref.size !== mesh.length) return false;
			for (const n of mesh) {
				const seen = new Set(fretOf(n).assembleCohort(probeCoord, mesh.length));
				if (seen.size !== mesh.length) return false;
				for (const id of ref) if (!seen.has(id)) return false;
			}
			return true;
		}, 60_000, 500);
		expect(stabilized, 'FRET stabilized the 3-node ring (every node knows every peer)').to.equal(true);

		// Probe for a block whose responsible peer is a REMOTE node (entry E = a is excluded).
		// Fresh ids each iteration so getCluster's per-key cache never serves a pre-stable result.
		const entry = a;
		const entryNM: { getCluster(key: Uint8Array): Promise<Array<{ toString(): string }>> } =
			(entry as any).services.networkManager;
		let chosen: { blockId: string; responsible: Libp2p; driver: Libp2p } | undefined;
		for (let i = 0; i < 200; i++) {
			const blockId = `redirect-rt-block-${i}`;
			const cohort = await entryNM.getCluster(new TextEncoder().encode(blockId));
			const ids = cohort.map(p => p.toString());
			if (ids.length >= 1 && !ids.includes(entry.peerId.toString())) {
				const responsible = mesh.find(n => n !== entry && n.peerId.toString() === ids[0]);
				if (responsible) {
					const driver = mesh.find(n => n !== entry && n !== responsible)!;
					chosen = { blockId, responsible, driver };
					break;
				}
			}
		}
		expect(chosen, 'found a block whose responsible peer is a remote node (a redirect will fire)').to.exist;
		const { blockId, responsible, driver } = chosen!;

		// Commit the block on the responsible node so it holds it locally (K=1 self-bypass fast path).
		const rRepo = (responsible as any).coordinatedRepo as IRepo;
		const pend = await rRepo.pend({ actionId: 'rt-a1', transforms: makeTransforms(blockId), policy: 'c' });
		expect(pend.success, 'responsible-node pend').to.equal(true);
		const commit = await rRepo.commit({ actionId: 'rt-a1', tailId: blockId as BlockId, rev: 1, blockIds: [blockId as BlockId] } as any);
		expect(commit.success, 'responsible-node commit').to.equal(true);

		// Precondition: the entry node does NOT hold the block locally, so a successful client
		// read can only have come from following the redirect to the responsible peer.
		const entryLocal = await (entry as any).storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true });
		expect(entryLocal[blockId]?.block, 'entry node has no local copy of the block').to.be.undefined;

		// White-box: the entry node's RepoService decides to redirect this op to the responsible
		// peer (and not to itself) — the un-inerted checkRedirect, keyed on the same coordinate
		// the cluster coordinator uses.
		const entryRepoSvc = (entry as any).services.repo;
		const probeMsg = { operations: [{ get: { blockIds: [blockId], context: { committed: [], rev: 0 } } }] };
		const decision = await entryRepoSvc.checkRedirect(blockId, 'get', probeMsg);
		expect(decision, 'entry RepoService returns a redirect for a block it is not responsible for').to.not.be.null;
		const redirectIds = decision.redirect.peers.map((p: any) => p.id);
		expect(redirectIds, 'redirect targets the responsible peer').to.include(responsible.peerId.toString());
		expect(redirectIds, 'redirect excludes the entry node itself').to.not.include(entry.peerId.toString());

		// Black-box end-to-end: drive a RepoClient from D, dialing the non-responsible entry E.
		// E redirects → the client follows the redirect (client.ts max-2-hop) to R, which serves
		// the committed block. D ≠ E and D ≠ R, so neither hop is a self-dial.
		const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
		const driverKeyNetwork = (driver as any).keyNetwork;
		const client = RepoClient.create(entry.peerId as any, driverKeyNetwork, protocolPrefix);
		const res = await client.get({ blockIds: [blockId as BlockId] }, { expiration: Date.now() + 20_000 } as any);

		expect(res[blockId]?.block?.header.id, 'redirected get reached the responsible peer and returned the committed block').to.equal(blockId);
	});

	// Multi-member cohort coverage for the repo-redirect path
	// (optimystic-repo-redirect-multimember-coverage). The size-1 redirect test above
	// only ever exercises a single-peer responsible group. This test proves the hand-off
	// still works when the responsible group has TWO members, and that the two
	// responsibility code paths (the coordinator's findCluster vs the redirect check's
	// getCluster) diverge benignly in a real ring:
	//
	//   - A repo `get` dialed to a non-member entry E redirects to the 2-peer cohort, and
	//     the RepoClient follows the redirect to a genuine cohort member that serves the
	//     committed block (the commit reached BOTH members via cluster consensus).
	//   - Each cohort member, asked the same redirect question, handles locally (no
	//     spurious redirect) — including the live prefix-subset guard that getCluster's
	//     cohort ⊆ findCluster's cohort, so a redirect can never point at a non-member.
	//
	// N=4, clusterSize 2: the FRET cohort for a probed block is a proper subset of
	// membership (2 members + 2 non-members). Entry E and driver D are the two
	// non-members, so neither redirect hop self-dials (mirroring the size-1 test's
	// "distinct driver node" invariant). responsibilityK defaults to 1, so a non-empty
	// cohort drives the exact same redirect / no-redirect branches as the size-1 test.
	it('redirect round-trip with a multi-member cohort: hand-off lands on a genuine cohort member and members never self-redirect', async function () {
		this.timeout(90_000);

		// clusterSize 2 commits require consensus across the cohort (no size-1 self-bypass
		// fast path), so use the same downsize-tolerant policy the `three-node mesh with one
		// peer dropped` test uses for its clusterSize-2 commit.
		const clusterPolicy = { allowDownsize: true, sizeTolerance: 1.0, superMajorityThreshold: 0.51 };
		const a = await spawnNode({ clusterSize: 2, clusterPolicy });
		const bootstrapAddr = pickLocalTcpMultiaddr(a);
		const b = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core', clusterSize: 2, clusterPolicy });
		const c = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core', clusterSize: 2, clusterPolicy });
		const d = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core', clusterSize: 2, clusterPolicy });
		const mesh = [a, b, c, d];

		await fullMeshDial(mesh);
		const connected = await waitFor(() => mesh.every(n => n.getPeers().length >= 3), 30_000, 250);
		expect(connected, 'the 4-node mesh fully connected').to.equal(true);

		// Wait for real FRET two-sided stabilization: every node must rank the same whole
		// ring (assembleCohort is not cached, so this is a clean readiness probe). With the
		// ring stabilized the estimate is >= 2, so getCluster returns the full clusterSize-2
		// cohort with no boundary clamping — the benign-divergence assertion holds trivially.
		const fretOf = (n: Libp2p): { assembleCohort(coord: Uint8Array, wants: number): string[] } =>
			(n as any).services.fret;
		const probeCoord = await hashKey(new TextEncoder().encode('mm-redirect-fret-probe'));
		const stabilized = await waitFor(() => {
			const ref = new Set(fretOf(a).assembleCohort(probeCoord, mesh.length));
			if (ref.size !== mesh.length) return false;
			for (const n of mesh) {
				const seen = new Set(fretOf(n).assembleCohort(probeCoord, mesh.length));
				if (seen.size !== mesh.length) return false;
				for (const id of ref) if (!seen.has(id)) return false;
			}
			return true;
		}, 60_000, 500);
		expect(stabilized, 'FRET stabilized the 4-node ring (every node knows every peer)').to.equal(true);

		// Probe for a block whose 2-peer responsible cohort EXCLUDES entry E = a. Fresh ids
		// each iteration so getCluster's per-key cache never serves a pre-stable cohort.
		// On a hit: the two cohort nodes are the responsible members; entry a and the one
		// remaining non-member are the two non-members. The driver D is that remaining
		// non-member — guaranteed D !== E and D not in the cohort, so neither hop self-dials.
		const entry = a;
		const entryNM: { getCluster(key: Uint8Array): Promise<Array<{ toString(): string }>> } =
			(entry as any).services.networkManager;
		let chosen: { blockId: string; members: Libp2p[]; responsible: Libp2p; driver: Libp2p; cohortIds: string[] } | undefined;
		for (let i = 0; i < 200; i++) {
			const blockId = `mm-redirect-block-${i}`;
			const cohort = await entryNM.getCluster(new TextEncoder().encode(blockId));
			const ids = cohort.map(p => p.toString());
			// Require the full 2-member cohort (no estimate-driven clamp) excluding the entry.
			if (ids.length !== 2) continue;
			if (ids.includes(entry.peerId.toString())) continue;
			const members = mesh.filter(n => ids.includes(n.peerId.toString()));
			if (members.length !== 2) continue;
			const driver = mesh.find(n => n !== entry && !ids.includes(n.peerId.toString()));
			if (!driver) continue;
			chosen = { blockId, members, responsible: members[0]!, driver, cohortIds: ids };
			break;
		}
		expect(chosen, 'found a block whose 2-peer responsible cohort excludes the entry node').to.exist;
		const { blockId, members, responsible, driver, cohortIds } = chosen!;

		// Explicit self-dial-hazard guards (so a future refactor can't silently reintroduce it).
		expect(driver, 'driver is not the entry node').to.not.equal(entry);
		expect(cohortIds, 'driver is NOT a cohort member').to.not.include(driver.peerId.toString());
		expect(members.length, 'the responsible cohort has two members').to.equal(2);

		// Commit the block on a responsible member. clusterSize 2 → real 2-member consensus;
		// the commit broadcasts the merged record to BOTH members, so each ends up holding
		// the block in its own storage. The redirected get (skipClusterFetch: true) then
		// serves it locally on whichever member the client lands on.
		const rRepo = (responsible as any).coordinatedRepo as IRepo;
		const pend = await rRepo.pend({ actionId: 'mm-a1', transforms: makeTransforms(blockId), policy: 'c' });
		expect(pend.success, 'responsible-member pend').to.equal(true);
		const commit = await rRepo.commit({ actionId: 'mm-a1', tailId: blockId as BlockId, rev: 1, blockIds: [blockId as BlockId] } as any);
		expect(commit.success, 'responsible-member commit (2-member consensus)').to.equal(true);

		// Precondition: neither the entry nor the driver holds the block locally (both are
		// non-members), so a successful client read can only have come from following the
		// redirect to a real cohort member.
		const entryLocal = await (entry as any).storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true });
		expect(entryLocal[blockId]?.block, 'entry node has no local copy of the block').to.be.undefined;
		const driverLocal = await (driver as any).storageRepo.get({ blockIds: [blockId] }, { skipClusterFetch: true });
		expect(driverLocal[blockId]?.block, 'driver node has no local copy of the block').to.be.undefined;

		// --- Assertion 1: a non-member redirects, and the hand-off completes on a cohort member ---
		// White-box: entry E's RepoService redirects this op to the 2-peer cohort (both members,
		// excluding itself). It is not a member, so checkRedirect returns the cohort.
		const entryRepoSvc = (entry as any).services.repo;
		const decision = await entryRepoSvc.checkRedirect(blockId, 'get', { operations: [{ get: { blockIds: [blockId], context: { committed: [], rev: 0 } } }] });
		expect(decision, 'entry RepoService returns a redirect for a block it is not responsible for').to.not.be.null;
		const redirectIds: string[] = decision.redirect.peers.map((p: any) => p.id);
		expect(redirectIds, 'redirect targets the responsible cohort member').to.include(responsible.peerId.toString());
		for (const m of members) {
			expect(redirectIds, 'redirect includes every cohort member').to.include(m.peerId.toString());
		}
		expect(redirectIds, 'redirect excludes the entry node itself').to.not.include(entry.peerId.toString());
		expect(redirectIds.length, 'redirect points at the full multi-member cohort').to.equal(2);

		// Black-box end-to-end: drive a RepoClient from D, dialing the non-member entry E.
		// E redirects → the client follows the redirect (client.ts max-2-hop) to a cohort
		// member, which serves the committed block. D != E and D not in cohort, so neither
		// hop self-dials.
		const protocolPrefix = `/optimystic/${NETWORK_NAME}`;
		const driverKeyNetwork = (driver as any).keyNetwork;
		const client = RepoClient.create(entry.peerId as any, driverKeyNetwork, protocolPrefix);
		const res = await client.get({ blockIds: [blockId as BlockId] }, { expiration: Date.now() + 20_000 } as any);
		expect(res[blockId]?.block?.header.id, 'redirected get resolved to a multi-peer cohort member and returned the committed block').to.equal(blockId);

		// --- Assertion 2: every cohort member handles locally (no spurious redirect) ---
		// Confirm the benign-divergence property live: each member's own getCluster cohort
		// includes itself and is a subset of the coordinator's findCluster cohort, so a
		// redirect can never point at a non-responsible peer.
		const keyBytes = new TextEncoder().encode(blockId);
		for (const m of members) {
			const mLabel = m.peerId.toString().substring(0, 12);
			const mRepoSvc = (m as any).services.repo;
			const mDecision = await mRepoSvc.checkRedirect(blockId, 'get', { operations: [{ get: { blockIds: [blockId], context: { committed: [], rev: 0 } } }] });
			expect(mDecision, `cohort member ${mLabel} handles locally (no redirect)`).to.be.null;

			const mGetCluster = await (m as any).services.networkManager.getCluster(keyBytes) as Array<{ toString(): string }>;
			const getClusterIds = mGetCluster.map(p => p.toString());
			expect(getClusterIds, `member ${mLabel} getCluster includes itself`).to.include(m.peerId.toString());

			const mFindCluster = await (m as any).keyNetwork.findCluster(keyBytes) as Record<string, unknown>;
			const findClusterIds = new Set(Object.keys(mFindCluster));
			for (const id of getClusterIds) {
				expect(findClusterIds.has(id), `member ${mLabel}: getCluster cohort member ${id.substring(0, 12)} is in findCluster cohort (benign divergence)`).to.equal(true);
			}
		}
	});
});
