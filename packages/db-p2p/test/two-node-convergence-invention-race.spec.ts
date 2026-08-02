import { expect } from 'chai';
import { Tree, type ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '../src/testing/mesh-harness.js';

// Repro for the sereus `control-db-two-node-convergence` failure: two nodes each open
// the SAME collection during their own bootstrap — before either has committed a header —
// so both stage ("invent") a fresh empty collection in their own tracker. One node then
// commits; the other can never advance its revision context and every sync retry
// re-requests rev 1 against a coordinator already at rev N.

interface TestEntry {
	key: number;
	value: string;
}

const transactorFor = (transactors: Map<string, ITransactor>, peerIdStr: string): ITransactor => {
	const t = transactors.get(peerIdStr);
	if (!t) throw new Error(`No transactor for peer ${peerIdStr}`);
	return t;
};

describe('Two-node convergence after a collection-invention race', function () {
	this.timeout(60_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;

	beforeEach(async () => {
		mesh = await createMesh(2, {
			responsibilityK: 2,
			clusterSize: 2,
			superMajorityThreshold: 0.67
		});
		transactors = buildNetworkTransactors(mesh);
	});

	it('B converges after both nodes opened the collection before either committed', async () => {
		const treeId = 'two-node-invention-race';
		const keyFn = (entry: TestEntry) => entry.key;

		const nodeA = mesh.nodes[0]!;
		const nodeB = mesh.nodes[1]!;

		// Bootstrap order matters: BOTH open before either writes, so both invent.
		const treeA = await Tree.createOrOpen<number, TestEntry>(
			transactorFor(transactors, nodeA.peerId.toString()), treeId, keyFn);
		const treeB = await Tree.createOrOpen<number, TestEntry>(
			transactorFor(transactors, nodeB.peerId.toString()), treeId, keyFn);

		// A commits first — wins the creation race and advances the collection.
		await treeA.replace([[1, { key: 1, value: 'from-A-1' }]]);
		await treeA.replace([[2, { key: 2, value: 'from-A-2' }]]);
		await treeA.replace([[3, { key: 3, value: 'from-A-3' }]]);

		// B, holding an invented instance, now writes. This is the sereus scenario.
		await treeB.replace([[4, { key: 4, value: 'from-B' }]]);

		// Both directions converge.
		await treeA.sync();
		expect(await treeA.get(4)).to.deep.equal({ key: 4, value: 'from-B' });
		expect(await treeB.get(1)).to.deep.equal({ key: 1, value: 'from-A-1' });
	});

	it('B converges when both staged a write before either synced', async () => {
		const treeId = 'two-node-invention-race-both-staged';
		const keyFn = (entry: TestEntry) => entry.key;

		const treeA = await Tree.createOrOpen<number, TestEntry>(
			transactorFor(transactors, mesh.nodes[0]!.peerId.toString()), treeId, keyFn);
		const treeB = await Tree.createOrOpen<number, TestEntry>(
			transactorFor(transactors, mesh.nodes[1]!.peerId.toString()), treeId, keyFn);

		await treeA.stage([[1, { key: 1, value: 'from-A' }]]);
		await treeB.stage([[2, { key: 2, value: 'from-B' }]]);

		await treeA.sync();
		await treeB.sync();

		await treeA.sync();
		expect(await treeA.get(2)).to.deep.equal({ key: 2, value: 'from-B' });
		expect(await treeB.get(1)).to.deep.equal({ key: 1, value: 'from-A' });
	});

	// The join-a-live-collection ordering: A has already committed the collection when B
	// opens it, but B's very first header read comes back ABSENT (a cold coordinator that
	// has not yet acquired the block). Post-v0.18.0 an absent answer is authoritative, so
	// `createOrOpen` invents a SECOND instance of a collection that already exists.
	it('B converges after inventing a collection the cluster had already committed', async () => {
		const treeId = 'two-node-invention-after-commit';
		const keyFn = (entry: TestEntry) => entry.key;

		const treeA = await Tree.createOrOpen<number, TestEntry>(
			transactorFor(transactors, mesh.nodes[0]!.peerId.toString()), treeId, keyFn);
		await treeA.replace([[1, { key: 1, value: 'from-A-1' }]]);
		await treeA.replace([[2, { key: 2, value: 'from-A-2' }]]);
		await treeA.replace([[3, { key: 3, value: 'from-A-3' }]]);

		const inner = transactorFor(transactors, mesh.nodes[1]!.peerId.toString());
		let blindHeaderReads = 1;
		const coldB: ITransactor = {
			async get(gets) {
				const res = await inner.get(gets);
				if (blindHeaderReads > 0 && gets.blockIds.includes(treeId)) {
					blindHeaderReads--;
					res[treeId] = { state: { latest: undefined, pendings: [] } };
				}
				return res;
			},
			getStatus: refs => inner.getStatus(refs),
			pend: req => inner.pend(req),
			cancel: ref => inner.cancel(ref),
			commit: req => inner.commit(req),
		};

		const treeB = await Tree.createOrOpen<number, TestEntry>(coldB, treeId, keyFn);
		await treeB.replace([[4, { key: 4, value: 'from-B' }]]);

		await treeA.sync();
		expect(await treeA.get(4)).to.deep.equal({ key: 4, value: 'from-B' });
		expect(await treeB.get(1)).to.deep.equal({ key: 1, value: 'from-A-1' });
	});
});
