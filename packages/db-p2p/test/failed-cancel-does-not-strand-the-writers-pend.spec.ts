/**
 * Ticket: a-cancel-that-misses-the-bar-strands-the-writers-pending-record.
 *
 * At three machines the promise bar is all three (`ceil(3 × 0.75)`), so one silent member sinks every
 * cluster transaction — the write's commit, and then the cancel that should discharge the write's pend.
 * The shape, reported by an embedding application on 1.13.0:
 *
 *  1. **Seed.** A writes a row; every machine holds it.
 *  2. **C answers the pend, then goes silent.** C promises and applies A's next pend, and drops on the first
 *     delivery of that write's commit. The commit fails at its promise round (2/3 approvals), and so does
 *     every round of the cancel the writer then issues. Nothing of the commit landed anywhere — a promise
 *     shortfall is thrown before any member signs a commit — so the pending records the pend stored are the
 *     only trace of the write, and nothing removes them.
 *  3. **C returns.** Nothing re-sends the cancel.
 *  4. **A writes the same row again, and it must land.** Before the fix every member still holding the
 *     stranded record votes `held` on this pend, the write exhausts its retry budget with
 *     `pending conflict: block(s) held by unresolved rival action(s) <the stranded action>`, and so does
 *     every later write to the block from any machine.
 */

import { expect } from 'chai';
import { Tree, type ActionId, type BlockId, type CommitRequest, type ITransactor, type WriteDurability } from '@optimystic/db-core';
import type { Mesh, MeshNode } from '../src/testing/mesh-harness.js';
import { createProductionShapedMesh, setUnreachable, transactorDrivenBy, recording, type Attempt } from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const MACHINES = 3;
const TREE_ID = 'failed-cancel-does-not-strand-the-writers-pend';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

describe('A cancel that misses the promise bar does not strand the writer\'s pending record (three machines)', function () {
	this.timeout(90_000);
	sequentialPhases();

	let mesh: Mesh;
	let a: MeshNode;
	let c: MeshNode;
	const attempts: Attempt[] = [];
	/** The write whose commit and cancel both fell short. */
	let stranded: { actionId: ActionId; blockIds: readonly BlockId[] } | undefined;

	const label = (node: MeshNode): string => 'ABC'[mesh.nodes.indexOf(node)]!;
	/** One transactor per writer for the whole spec, as the Quereus plugin's `CollectionFactory` keeps one per
	 *  transactor key: whatever a writer remembers about a cancel it could not discharge lives there. */
	const transactors = new Map<MeshNode, ITransactor>();
	const driven = (node: MeshNode): ITransactor => {
		let transactor = transactors.get(node);
		if (!transactor) {
			transactor = recording(transactorDrivenBy(mesh, node), attempts);
			transactors.set(node, transactor);
		}
		return transactor;
	};

	async function write(writer: MeshNode, key: string, value: string): Promise<WriteDurability | undefined> {
		const tree = await Tree.createOrOpen<string, Row>(driven(writer), TREE_ID, keyOf);
		return await tree.replace([[key, { key, value }]]);
	}

	/** The machines whose OWN storage still holds a pending record for the stranded action on any of its blocks. */
	async function holdersOfStranded(): Promise<string[]> {
		const holders: string[] = [];
		for (const node of mesh.nodes) {
			for (const blockId of stranded!.blockIds) {
				const entry = (await node.storageRepo.get({ blockIds: [blockId] }))[blockId];
				if ((entry?.state?.pendings ?? []).includes(stranded!.actionId)) {
					holders.push(label(node));
					break;
				}
			}
		}
		return holders;
	}

	before(async () => {
		mesh = await createProductionShapedMesh(MACHINES);
		[a, , c] = mesh.nodes as [MeshNode, MeshNode, MeshNode];
	});

	it('phase 1 — seed: A writes a row with every member reachable', async () => {
		const durability = await write(a, 'row', 'seed');
		expect(durability, 'the seed write is acknowledged').to.not.equal(undefined);
	});

	it('phase 2 — C answers the pend and goes silent before the commit: the commit and every cancel round fall short', async () => {
		const cId = c.peerId.toString();
		mesh.failures.onClusterDelivery = (target, record) => {
			if (stranded !== undefined || target !== cId) return;
			const commit = (record.message.operations[0] as { commit?: CommitRequest }).commit;
			if (commit === undefined) return;
			stranded = { actionId: commit.actionId, blockIds: commit.blockIds };
			setUnreachable(mesh, [c]);
		};

		let threw: Error | undefined;
		try {
			await write(a, 'row', 'never-lands');
		} catch (err) {
			threw = err as Error;
		} finally {
			mesh.failures.onClusterDelivery = undefined;
		}
		console.log(`    phase 2: A's write ${threw ? `threw ${threw.message}` : 'returned'}`);

		expect(stranded, 'C went silent on the write\'s commit').to.not.equal(undefined);
		expect(threw, 'the write fails while C is silent').to.not.equal(undefined);
		console.log(`    phase 2: pending records for ${stranded!.actionId} stand on ${(await holdersOfStranded()).join(', ') || 'nobody'}`);
	});

	it('phase 3 — C returns, and A writes the same row again: the write lands and no member still holds the failed write\'s record', async () => {
		setUnreachable(mesh, []);
		const durability = await write(a, 'row', 'after-C-returned');
		expect(durability, 'the write after C returned is acknowledged').to.not.equal(undefined);
		expect(await holdersOfStranded(), `members still holding ${stranded!.actionId}`).to.deep.equal([]);
	});
});
