import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { IRepo, IKeyNetwork } from '@optimystic/db-core';
import { NetworkTransactor, Tree } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';
import { RepoClient } from '../src/repo/client.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

// In-repo acceptance for `blocked/two-node-convergence-acceptance-cross-repo-build`.
//
// The convergence fixes d6a22d2 / 07cb230 / d31be12 were only ever confirmed by unit
// tests; the end-to-end assertion lived in the sereus repo, which is why that ticket
// asked a human to rebuild two sibling checkouts. This test moves the assertion here:
// two REAL libp2p nodes, both coordinators for the same keyspace (clusterSize 2), each
// driving its own NetworkTransactor over a Tree collection — the same layering the
// sereus `control-db-two-node-convergence` scenario exercises through Quereus.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 like the other real-socket specs:
//   yarn workspace @optimystic/db-p2p test:integration

const NETWORK_NAME = 'two-node-convergence-it';

interface TestEntry {
	key: number;
	value: string;
}

const keyFn = (entry: TestEntry) => entry.key;

const transactorFor = (node: Libp2p): NetworkTransactor => {
	const keyNetwork = (node as any).keyNetwork as IKeyNetwork;
	const coordinatedRepo = (node as any).coordinatedRepo as IRepo;
	return new NetworkTransactor({
		timeoutMs: 30_000,
		abortOrCancelTimeoutMs: 10_000,
		dialTimeoutMs: 3_000,
		keyNetwork,
		getRepo: (peerId) => peerId.toString() === node.peerId.toString()
			? coordinatedRepo
			: RepoClient.create(peerId, keyNetwork as any, `/optimystic/${NETWORK_NAME}`)
	});
};

async function fullMeshDial(meshNodes: Libp2p[]): Promise<void> {
	const addrs = meshNodes.map(pickLocalTcpMultiaddr);
	for (let i = 0; i < meshNodes.length; i++) {
		for (let j = 0; j < meshNodes.length; j++) {
			if (i === j) continue;
			try { await meshNodes[i]!.dial(multiaddr(addrs[j]!)); } catch { /* reciprocal dial covers this edge */ }
		}
	}
}

describe('Two-node convergence over real libp2p', function () {
	this.timeout(120_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let nodes: Libp2p[] = [];

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

	async function stabilizedPair(): Promise<[Libp2p, Libp2p]> {
		const a = await spawnNode();
		const b = await spawnNode({ bootstrapNodes: [pickLocalTcpMultiaddr(a)], fretProfile: 'core' });
		const mesh = [a, b];
		await fullMeshDial(mesh);
		await waitFor(() => mesh.every(n => n.getPeers().length >= 1),
			{ timeoutMs: 30_000, intervalMs: 250, description: 'the 2-node mesh connected' });
		await waitFor(async () => {
			for (const n of mesh) {
				const ids = Object.keys(await (n as any).keyNetwork.findCluster(new TextEncoder().encode('two-node-conv-probe')));
				if (ids.length !== 2) return false;
			}
			return true;
		}, { timeoutMs: 40_000, intervalMs: 500, description: 'both nodes assemble the same 2-peer cohort' });
		return [a, b];
	}

	// The sereus scenario proper: A writes a row, B must read it back.
	it('a row written on A is readable on B', async function () {
		const [a, b] = await stabilizedPair();
		const treeId = 'two-node-conv-owner-row';

		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a), treeId, keyFn);
		await treeA.replace([[1, { key: 1, value: 'written-on-A' }]]);

		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b), treeId, keyFn);
		expect(await treeB.get(1)).to.deep.equal({ key: 1, value: 'written-on-A' });
	});

	// The invention race: both nodes hold an instance of the collection before either
	// has committed a header, so both stage ("invent") one. The loser must still be able
	// to write — this is the shape that livelocks at `requested rev 1` in sereus.
	it('B writes and converges after both nodes invented the collection', async function () {
		const [a, b] = await stabilizedPair();
		const treeId = 'two-node-conv-invention-race';

		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a), treeId, keyFn);
		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b), treeId, keyFn);

		await treeA.replace([[1, { key: 1, value: 'from-A-1' }]]);
		await treeA.replace([[2, { key: 2, value: 'from-A-2' }]]);
		await treeA.replace([[3, { key: 3, value: 'from-A-3' }]]);

		await treeB.replace([[4, { key: 4, value: 'from-B' }]]);

		await treeA.sync();
		expect(await treeA.get(4), "A sees B's row").to.deep.equal({ key: 4, value: 'from-B' });
		expect(await treeB.get(1), "B sees A's row").to.deep.equal({ key: 1, value: 'from-A-1' });
	});

	// The joiner ordering: B opens the collection only after A has already advanced it,
	// then writes immediately — sereus's "node joins a party whose control collections
	// were already committed by another node".
	it('a joiner writes into a collection another node already advanced', async function () {
		const [a, b] = await stabilizedPair();
		const treeId = 'two-node-conv-joiner-write';

		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a), treeId, keyFn);
		await treeA.replace([[1, { key: 1, value: 'from-A-1' }]]);
		await treeA.replace([[2, { key: 2, value: 'from-A-2' }]]);
		await treeA.replace([[3, { key: 3, value: 'from-A-3' }]]);

		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b), treeId, keyFn);
		await treeB.replace([[4, { key: 4, value: 'from-B' }]]);

		await treeA.sync();
		expect(await treeA.get(4), "A sees the joiner's row").to.deep.equal({ key: 4, value: 'from-B' });
		expect(await treeB.get(2), "the joiner sees A's earlier rows").to.deep.equal({ key: 2, value: 'from-A-2' });
	});
});
