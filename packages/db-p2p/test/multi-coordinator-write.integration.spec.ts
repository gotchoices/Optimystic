import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { multiaddr } from '@multiformats/multiaddr';
import { hashKey } from 'p2p-fret';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';

// Reproducer for `multi-coordinator-write-stream-reset-supermajority`.
//
// A control/data write that needs a super-majority across TWO same-keyspace
// coordinator nodes never reaches quorum: the coordinator opens the
// inter-coordinator cluster-protocol stream to collect the second promise, the
// stream is reset, and `executeTransaction` fails the super-majority check
// ("Failed to get super-majority: N/2 approvals (needed 2, ...)").
//
// Why this is the FIRST optimystic-local test of a genuine 2-coordinator write:
//  - The mesh-harness (`createMesh`) routes ClusterClient.update() as an
//    in-process function call, so it can never exercise a real libp2p stream
//    and therefore cannot reproduce the reset.
//  - `cluster-coordinator-supermajority.spec.ts` mocks the client too.
//  - `fresh-node-ddl-multi.spec.ts` is 3+ peers over the mock transport.
//  - The existing `real-libp2p.integration.spec.ts` "two-node mesh" test uses
//    clusterSize:1, so the write takes the K=1 self-bypass fast path and never
//    opens an inter-coordinator stream.
//
// This test stands up exactly TWO storage coordinators on the SAME keyspace
// (clusterSize:2, so for every block both nodes are in the cohort) and commits
// one write driven by node A. On a healthy build A.pend + A.commit succeed and
// B can read the block back. On the buggy build A.pend fails at the
// super-majority check with a StreamResetError cause.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 (like real-libp2p.integration.spec.ts) so
// the default fast `npm test` is unaffected. Run via:
//   OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p
// Windows (PowerShell):
//   $env:OPTIMYSTIC_INTEGRATION=1; npm run test:integration --workspace @optimystic/db-p2p

const NETWORK_NAME = 'multi-coord-write-it';

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

async function fullMeshDial(meshNodes: Libp2p[]): Promise<void> {
	const addrs = meshNodes.map(pickLocalTcpMultiaddr);
	for (let i = 0; i < meshNodes.length; i++) {
		for (let j = 0; j < meshNodes.length; j++) {
			if (i === j) continue;
			try { await meshNodes[i]!.dial(multiaddr(addrs[j]!)); } catch { /* reciprocal dial covers this edge */ }
		}
	}
}

describe('Multi-coordinator write (real libp2p, two same-keyspace coordinators)', function () {
	this.timeout(60_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];

	// clusterSize:2 → every block's cohort is BOTH nodes, so a write requires a
	// promise from each. superMajorityThreshold 0.67 → ceil(2 * 0.67) = 2 (2-of-2).
	const clusterPolicy = { allowDownsize: true, sizeTolerance: 1.0, superMajorityThreshold: 0.67 };

	async function spawnNode(overrides: Partial<NodeOptions> = {}): Promise<Libp2p> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
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

	it('A.pend + A.commit reaches 2-of-2 super-majority and B reads the write back', async function () {
		const a = await spawnNode();
		const bootstrapAddr = pickLocalTcpMultiaddr(a);
		const b = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });
		const mesh = [a, b];

		await fullMeshDial(mesh);
		const connected = await waitFor(() => mesh.every(n => n.getPeers().length >= 1), 30_000, 250);
		expect(connected, 'the 2-node mesh connected').to.equal(true);

		// FRET two-sided stabilization: both nodes must rank the same 2-peer ring so
		// findCluster on either node returns the SAME {A, B} cohort for the block.
		const fretOf = (n: Libp2p): { assembleCohort(coord: Uint8Array, wants: number): string[] } =>
			(n as any).services.fret;
		const probeCoord = await hashKey(new TextEncoder().encode('multi-coord-fret-probe'));
		const stabilized = await waitFor(() => {
			const ref = new Set(fretOf(a).assembleCohort(probeCoord, mesh.length));
			if (ref.size !== mesh.length) return false;
			for (const n of mesh) {
				const seen = new Set(fretOf(n).assembleCohort(probeCoord, mesh.length));
				if (seen.size !== mesh.length) return false;
				for (const id of ref) if (!seen.has(id)) return false;
			}
			return true;
		}, 40_000, 500);
		expect(stabilized, 'FRET stabilized the 2-node ring (each node sees both peers)').to.equal(true);

		const blockId = 'multi-coord-block';

		// Confirm the precondition: BOTH nodes are in the block's cohort, so this
		// write genuinely needs an inter-coordinator promise (not the K=1 fast path).
		const aCohort = Object.keys(await (a as any).keyNetwork.findCluster(new TextEncoder().encode(blockId)));
		expect(aCohort.length, "A's cohort for the block has both coordinators").to.equal(2);

		const aRepo = (a as any).coordinatedRepo as IRepo;
		const bRepo = (b as any).coordinatedRepo as IRepo;

		// THE REPRODUCER: on the buggy build this throws at the super-majority check
		// ("Failed to get super-majority: N/2 approvals", cause=StreamResetError).
		const pendResult = await aRepo.pend({
			actionId: 'mcw-a1',
			transforms: makeTransforms(blockId),
			policy: 'c'
		});
		expect(pendResult.success, 'A.pend reaches 2-of-2 super-majority').to.equal(true);

		const commitResult = await aRepo.commit({
			actionId: 'mcw-a1',
			tailId: blockId as BlockId,
			rev: 1,
			blockIds: [blockId as BlockId]
		} as any);
		expect(commitResult.success, 'A.commit reaches consensus').to.equal(true);

		// B sees the committed block (via cluster consensus broadcast / read-repair).
		const bResult = await bRepo.get({ blockIds: [blockId as BlockId] });
		expect(bResult[blockId], 'B.get returns an entry for the committed block').to.exist;
	});

	// Aggressive variant — mimic the Sereus "second storage node joins and
	// immediately registers itself" flow: drive the FIRST writes from the JOINER
	// (B) with minimal settle, and loop several blocks, to catch an intermittent
	// inter-coordinator stream reset that a single post-stabilization write misses.
	it('joiner-driven back-to-back writes each reach 2-of-2 (no inter-coordinator stream reset)', async function () {
		const a = await spawnNode();
		const bootstrapAddr = pickLocalTcpMultiaddr(a);
		const b = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });
		const mesh = [a, b];

		await fullMeshDial(mesh);
		const connected = await waitFor(() => mesh.every(n => n.getPeers().length >= 1), 30_000, 250);
		expect(connected, 'the 2-node mesh connected').to.equal(true);

		// Only a minimal cohort-readiness wait (NOT full FRET stabilization): proceed
		// as soon as the joiner's own cohort for a probe block already has both peers,
		// mirroring a node that writes right after join.
		const cohortReady = await waitFor(async () => {
			const ids = Object.keys(await (b as any).keyNetwork.findCluster(new TextEncoder().encode('mcw-join-probe')));
			return ids.length === 2;
		}, 30_000, 250);
		expect(cohortReady, "joiner's cohort for the probe has both coordinators").to.equal(true);

		const bRepo = (b as any).coordinatedRepo as IRepo;

		const failures: string[] = [];
		for (let i = 0; i < 6; i++) {
			const blockId = `mcw-join-block-${i}`;
			try {
				const pend = await bRepo.pend({ actionId: `mcw-join-${i}`, transforms: makeTransforms(blockId), policy: 'c' });
				if (!pend.success) { failures.push(`pend[${i}] success=false`); continue; }
				const commit = await bRepo.commit({ actionId: `mcw-join-${i}`, tailId: blockId as BlockId, rev: 1, blockIds: [blockId as BlockId] } as any);
				if (!commit.success) failures.push(`commit[${i}] success=false`);
			} catch (err) {
				failures.push(`write[${i}] threw: ${(err as Error).message}`);
			}
		}
		expect(failures, `all joiner-driven 2-of-2 writes succeed; failures: ${failures.join(' | ')}`).to.deep.equal([]);
	});
});
