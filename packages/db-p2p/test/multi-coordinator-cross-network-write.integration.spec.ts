import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';

// Reproducer / acceptance test for
// `multi-coordinator-cross-network-coordinator-selection`.
//
// TWO distinct control networks run on the SAME physical nodes / shared bootstrap:
//   - control-A: coordinators A1, A2 (clusterSize:2 → both are in every block's cohort)
//   - control-B: a single node B1
// Because noise + yamux are network-agnostic, B1 opens a real libp2p connection to
// A1/A2 and lands in their peerStore. But identify is network-NAMESPACED
// (`/optimystic/<network>/id/1.0.0`), so B1's identify never completes on the A
// nodes and its peerStore protocol list stays EMPTY forever — it can never serve
// `/optimystic/control-A/{cluster,repo}/1.0.0`.
//
// On the buggy build, an A-network write could select B1 as the second coordinator /
// cohort member, then fail to negotiate the control-A protocol on it, collecting only
// 1/2 promises ("Failed to get super-majority: 1/2 ... could not negotiate
// /optimystic/control-B/repo/1.0.0"). On the fixed build the db-p2p selection layer
// scopes the cohort to peers that serve control-A, so B1 is never chosen and the
// write reaches 2-of-2 with A2.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 (like the other integration specs). Run via:
//   $env:OPTIMYSTIC_INTEGRATION=1; npm run test:integration --workspace @optimystic/db-p2p

const NETWORK_A = 'control-A';
const NETWORK_B = 'control-B';

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({ header: makeHeader(id) });

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

function pickLocalTcpMultiaddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await delay(intervalMs);
	}
}

async function dialBoth(x: Libp2p, y: Libp2p): Promise<void> {
	const xa = pickLocalTcpMultiaddr(x);
	const ya = pickLocalTcpMultiaddr(y);
	try { await x.dial(multiaddr(ya)); } catch { /* reciprocal dial covers this edge */ }
	try { await y.dial(multiaddr(xa)); } catch { /* reciprocal dial covers this edge */ }
}

describe('Multi-coordinator cross-network selection (two control networks, shared nodes)', function () {
	this.timeout(90_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];

	// clusterSize:2 on control-A → every block's cohort is BOTH A nodes, so a write
	// requires a promise from each. superMajorityThreshold 0.67 → ceil(2*0.67)=2 (2-of-2).
	const clusterPolicy = { allowDownsize: true, sizeTolerance: 1.0, superMajorityThreshold: 0.67 };

	async function spawnNode(networkName: string, overrides: Partial<NodeOptions> = {}): Promise<Libp2p> {
		const node = await createLibp2pNode({
			port: 0,
			networkName,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 2,
			clusterPolicy,
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

	it('an A-network write selects A2 (never the B-network node) and reaches 2-of-2', async function () {
		const a1 = await spawnNode(NETWORK_A);
		const bootstrapAddr = pickLocalTcpMultiaddr(a1);
		const a2 = await spawnNode(NETWORK_A, { bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });
		// B1 shares the SAME bootstrap as A2, so it dials into the same physical mesh.
		const b1 = await spawnNode(NETWORK_B, { bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });

		// Mesh every pair so B1 genuinely lands in A1/A2's peerStore (cross-network
		// contaminant) and the two A nodes connect to each other.
		await dialBoth(a1, a2);
		await dialBoth(a1, b1);
		await dialBoth(a2, b1);

		const everyoneConnected = await waitFor(
			() => a1.getPeers().length >= 2 && a2.getPeers().length >= 2 && b1.getPeers().length >= 2,
			30_000, 250
		);
		expect(everyoneConnected, 'all three nodes connected to both peers').to.equal(true);

		const b1Id = b1.peerId.toString();

		// Confirm the contamination precondition: B1 really is in A1's peerStore but
		// has NOT registered any control-A protocol (its namespaced identify can't
		// complete across networks). This is exactly the signal the selection filter
		// keys on.
		const b1Contaminates = await waitFor(async () => {
			try {
				const peer = await (a1 as any).peerStore.get(b1.peerId);
				const protos: string[] = peer?.protocols ?? [];
				return !protos.includes(`/optimystic/${NETWORK_A}/cluster/1.0.0`)
					&& !protos.includes(`/optimystic/${NETWORK_A}/repo/1.0.0`);
			} catch {
				return false;
			}
		}, 30_000, 250);
		expect(b1Contaminates, 'B1 is in A1 peerStore without any control-A protocol').to.equal(true);

		// Let A1/A2 settle so A2 has completed identify and is a positively-'serves'
		// candidate before the write (the filter prefers serving peers over unknowns).
		const aServes = await waitFor(async () => {
			try {
				const peer = await (a1 as any).peerStore.get(a2.peerId);
				const protos: string[] = peer?.protocols ?? [];
				return protos.includes(`/optimystic/${NETWORK_A}/cluster/1.0.0`)
					|| protos.includes(`/optimystic/${NETWORK_A}/repo/1.0.0`);
			} catch {
				return false;
			}
		}, 40_000, 500);
		expect(aServes, 'A2 has completed identify and serves control-A on A1').to.equal(true);

		// Drive several A-network writes; for each, A1's cohort must be exactly {A1, A2}
		// (never B1) and the 2-of-2 write must succeed without a control-B negotiation error.
		const aRepo = (a1 as any).coordinatedRepo as IRepo;
		const failures: string[] = [];
		for (let i = 0; i < 4; i++) {
			const blockId = `xnet-block-${i}`;
			try {
				const cohort = Object.keys(await (a1 as any).keyNetwork.findCluster(new TextEncoder().encode(blockId)));
				if (cohort.includes(b1Id)) {
					failures.push(`cohort[${i}] wrongly includes B-network node ${b1Id.substring(0, 12)}`);
					continue;
				}
				const pend = await aRepo.pend({ actionId: `xnet-${i}`, transforms: makeTransforms(blockId), policy: 'c' });
				if (!pend.success) { failures.push(`pend[${i}] success=false`); continue; }
				const commit = await aRepo.commit({ actionId: `xnet-${i}`, tailId: blockId as BlockId, rev: 1, blockIds: [blockId as BlockId] } as any);
				if (!commit.success) failures.push(`commit[${i}] success=false`);
			} catch (err) {
				failures.push(`write[${i}] threw: ${(err as Error).message}`);
			}
		}
		expect(failures, `all A-network writes select A2 and reach 2-of-2; failures: ${failures.join(' | ')}`).to.deep.equal([]);
	});
});
