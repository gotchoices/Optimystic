/**
 * Ticket: writer-and-harness-route-to-the-cohort.
 *
 * The mesh harness must place a block exactly where production places it, or every mesh spec models a
 * world production does not live in. Production's rule is `Libp2pKeyPeerNetwork.findCluster`: FRET's
 * ring walk outward from the key's coordinate, membership-scoped, cut to `clusterSize`, with this node
 * in the cohort only when it is among the nearest. The harness ranks with the same FRET walk, so the two
 * agree by construction; this spec is what keeps that true.
 *
 * A seeded mesh and the seeded ring from `util/seeded-ring.ts` hold the same peers, so for every block the
 * harness's cohort must equal production's as an ordered list, the harness's coordinator must be that
 * cohort's first entry, and each node's own view (`MeshNode.keyNetwork`, what its coordinator judges
 * responsibility by) must contain the node exactly when production's cohort does.
 */
import { expect } from 'chai';
import { routingKeyForBlock } from '@optimystic/db-core';
import { createMesh } from '../src/testing/mesh-harness.js';
import { ringOf, ringPeersOf, ringKeyNetworkOf } from './util/seeded-ring.js';

const NODES = 16;
const BLOCKS = 300;

describe('mesh harness cohort parity with the production key network (16 seeded nodes)', function () {
	this.timeout(120_000);

	it('the seeded mesh and the seeded ring hold the same peers in the same order', async () => {
		const mesh = await createMesh(NODES, { responsibilityK: 1, keySeed: NODES });
		const ring = await ringPeersOf(NODES);
		expect(mesh.nodes.map(n => n.peerId.toString())).to.deep.equal(ring.map(p => p.toString()));
	});

	for (const width of [1, 2, 4]) {
		it(`width ${width}: cohort, coordinator and every node's self-membership match production for ${BLOCKS} blocks`, async () => {
			const mesh = await createMesh(NODES, { responsibilityK: width, clusterSize: width, keySeed: NODES });
			const peers = await ringPeersOf(NODES);
			const production = ringKeyNetworkOf(peers[0]!, peers, await ringOf(NODES), { clusterSize: width, scoped: true });

			let selfInOwnView = 0;
			for (let i = 0; i < BLOCKS; i++) {
				const id = `parity-block-${i}`;
				const key = routingKeyForBlock(id);
				const expected = Object.keys(await production.findCluster(key));
				expect(expected, `${id}: production cohort width`).to.have.length(width);

				expect(Object.keys(await mesh.keyNetwork.findCluster(key)), `${id}: harness cohort (ordered)`).to.deep.equal(expected);
				expect((await mesh.keyNetwork.findCoordinator(key)).toString(), `${id}: harness coordinator`).to.equal(expected[0]);

				for (const node of mesh.nodes) {
					const selfId = node.peerId.toString();
					const inOwnView = selfId in await node.keyNetwork.findCluster(key);
					expect(inOwnView, `${id}: node ${selfId.substring(0, 12)} in its own view`).to.equal(expected.includes(selfId));
					if (inOwnView) selfInOwnView++;
				}
			}
			// Every block has exactly `width` responsible nodes, each of which sees itself; nobody else does.
			expect(selfInOwnView).to.equal(BLOCKS * width);
		});
	}

	it('under a partition, a node sees only its side\'s share of the cohort, and nothing when its side holds none of it', async () => {
		const width = 2;
		const mesh = await createMesh(NODES, { responsibilityK: width, clusterSize: width, keySeed: NODES });
		const ids = mesh.nodes.map(n => n.peerId.toString());
		const sides = [new Set(ids.slice(0, NODES / 2)), new Set(ids.slice(NODES / 2))];
		mesh.failures.partitionSides = sides;

		let emptyViews = 0;
		for (let i = 0; i < 50; i++) {
			const key = routingKeyForBlock(`partition-parity-block-${i}`);
			const cohort = Object.keys(await mesh.keyNetwork.findCluster(key));
			for (const node of mesh.nodes) {
				const side = sides.find(s => s.has(node.peerId.toString()))!;
				const view = Object.keys(await node.keyNetwork.findCluster(key));
				expect(view).to.deep.equal(cohort.filter(id => side.has(id)));
				if (view.length === 0) emptyViews++;
			}
		}
		expect(emptyViews, 'some side holds none of some block\'s cohort').to.be.greaterThan(0);
	});
});
