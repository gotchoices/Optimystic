import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { BlockUnavailableError, Tree, routingKeyForBlock } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';
import { transactorFor } from './util/two-machine-lifecycle.js';

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

	let nodes: OptimysticNode[] = [];

	const clusterPolicy = { allowDownsize: true, sizeTolerance: 1.0, superMajorityThreshold: 0.67 };

	async function spawnNode(overrides: Partial<NodeOptions> = {}): Promise<OptimysticNode> {
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

	async function stabilizedPair(): Promise<[OptimysticNode, OptimysticNode]> {
		const a = await spawnNode();
		const b = await spawnNode({ bootstrapNodes: [pickLocalTcpMultiaddr(a)], fretProfile: 'core' });
		const mesh = [a, b];
		await fullMeshDial(mesh);
		await waitFor(() => mesh.every(n => n.getPeers().length >= 1),
			{ timeoutMs: 30_000, intervalMs: 250, description: 'the 2-node mesh connected' });
		await waitFor(async () => {
			for (const n of mesh) {
				const ids = Object.keys(await n.keyNetwork.findCluster(routingKeyForBlock('two-node-conv-probe')));
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

		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a, NETWORK_NAME), treeId, keyFn);
		await treeA.replace([[1, { key: 1, value: 'written-on-A' }]]);

		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b, NETWORK_NAME), treeId, keyFn);
		expect(await treeB.get(1)).to.deep.equal({ key: 1, value: 'written-on-A' });
	});

	// The invention race: both nodes hold an instance of the collection before either
	// has committed a header, so both stage ("invent") one. The loser must still be able
	// to write — this is the shape that livelocks at `requested rev 1` in sereus.
	it('B writes and converges after both nodes invented the collection', async function () {
		const [a, b] = await stabilizedPair();
		const treeId = 'two-node-conv-invention-race';

		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a, NETWORK_NAME), treeId, keyFn);
		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b, NETWORK_NAME), treeId, keyFn);

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

		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a, NETWORK_NAME), treeId, keyFn);
		await treeA.replace([[1, { key: 1, value: 'from-A-1' }]]);
		await treeA.replace([[2, { key: 2, value: 'from-A-2' }]]);
		await treeA.replace([[3, { key: 3, value: 'from-A-3' }]]);

		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b, NETWORK_NAME), treeId, keyFn);
		await treeB.replace([[4, { key: 4, value: 'from-B' }]]);

		await treeA.sync();
		expect(await treeA.get(4), "A sees the joiner's row").to.deep.equal({ key: 4, value: 'from-B' });
		expect(await treeB.get(2), "the joiner sees A's earlier rows").to.deep.equal({ key: 2, value: 'from-A-2' });
	});

	// GitHub issue #27. Every case above waits for the mesh before opening anything, which is why
	// none of them saw this: a joiner that opens a collection the moment its node exists used to do
	// so before it had dialed the machine it was told to join, found nothing locally, and founded
	// its own copy at revision 1.
	it('a joiner that opens a collection the moment it starts finds the founder\'s, not its own', async function () {
		const a = await spawnNode();
		const treeId = 'two-node-conv-cold-joiner';
		const treeA = await Tree.createOrOpen<number, TestEntry>(transactorFor(a, NETWORK_NAME), treeId, keyFn);
		await treeA.replace([[1, { key: 1, value: 'from-A' }]]);

		const b = await spawnNode({ bootstrapNodes: [pickLocalTcpMultiaddr(a)], fretProfile: 'core' });
		const treeB = await Tree.createOrOpen<number, TestEntry>(transactorFor(b, NETWORK_NAME), treeId, keyFn);
		await treeB.replace([[2, { key: 2, value: 'from-B' }]]);

		expect(await treeB.get(1), "the joiner sees the founder's row").to.deep.equal({ key: 1, value: 'from-A' });
		await treeA.sync();
		expect(await treeA.get(2), "the founder sees the joiner's row").to.deep.equal({ key: 2, value: 'from-B' });

		// The header block's id is the collection id, and only the commit that creates the collection
		// writes it. So the joiner holding the founder's action there is the joiner never having
		// committed a revision 1 of its own.
		const headerOn = async (node: OptimysticNode) => (await node.storageRepo.get({ blockIds: [treeId] }))[treeId]?.state.latest;
		const founded = await headerOn(a);
		expect(founded?.rev, 'the founder created the collection at revision 1').to.equal(1);
		expect(await headerOn(b), "the joiner holds the founder's header").to.deep.equal(founded);
	});

	// A bootstrap peer is often infrastructure rather than a member: a relay or another group's
	// node, serving a different network. Such a peer refuses this network's identify, and that
	// refusal is its answer: a node alone on its own network then founds what it needs, at once.
	it('a node that bootstraps through a peer on another network founds its collection without waiting out the deadline', async function () {
		const infrastructure = await spawnNode({ networkName: `${NETWORK_NAME}-other` });
		const founder = await spawnNode({ bootstrapNodes: [pickLocalTcpMultiaddr(infrastructure)], fretProfile: 'core' });
		const treeId = 'two-node-conv-foreign-bootstrap';

		const started = Date.now();
		const tree = await Tree.createOrOpen<number, TestEntry>(transactorFor(founder, NETWORK_NAME), treeId, keyFn);
		await tree.replace([[1, { key: 1, value: 'founded' }]]);
		expect(await tree.get(1)).to.deep.equal({ key: 1, value: 'founded' });
		// The bootstrap contact wait is 10 s here. Half of it is far above anything a loopback
		// identify takes and far below a wait that ran to its deadline.
		expect(Date.now() - started, 'did not wait for the deadline').to.be.below(5_000);
	});

	// The other half of the rule: with the machine it was told to join unreachable, the joiner has
	// no basis for "this collection does not exist yet", so it must not found one.
	it('a joiner whose bootstrap peer never answers refuses to found a collection', async function () {
		const a = await spawnNode();
		const unreachable = pickLocalTcpMultiaddr(a);
		await a.stop();

		const b = await spawnNode({ bootstrapNodes: [unreachable], fretProfile: 'core' });
		const treeId = 'two-node-conv-unreachable-founder';

		let refusal: unknown;
		try {
			await Tree.createOrOpen<number, TestEntry>(transactorFor(b, NETWORK_NAME), treeId, keyFn);
		} catch (err) {
			refusal = err;
		}
		expect(refusal, 'the open is refused').to.be.instanceOf(BlockUnavailableError);
		expect((refusal as BlockUnavailableError).reason).to.equal('cohort-unreachable');
		expect((await b.storageRepo.get({ blockIds: [treeId] }))[treeId]?.state.latest, 'nothing was committed').to.equal(undefined);
	});
});
