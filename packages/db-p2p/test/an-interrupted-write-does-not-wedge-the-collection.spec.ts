/**
 * Ticket: an-interrupted-write-wedges-a-collection-for-good (GitHub #54).
 *
 * One machine, one group. A write has two steps: its pending record is saved, then the write commits.
 * A process that exits between the two — the embedder's `Promise.race([node.stop(), timeout])` followed
 * by `process.exit`, or a phone closing the app — leaves the record on disk. Nothing node-side removes
 * it: its claimed slot is never reached, so the dead-claim sweep never fires, and the writer's owed
 * cancels were in memory. The next process's first write to the collection asks for the same slot,
 * `StorageRepo.pend` reads the dead record as a live reservation, and the write is refused on every
 * attempt until its retry budget runs out. So does every later write: the collection is unwritable.
 *
 *  1. **Seed.** Run 1 writes a row; the collection is at revision 1.
 *  2. **Run 1 is interrupted between pend and commit.** Its transactor pends a second write at
 *     revision 2 and never commits or cancels it. The node is restarted over the same storage — the
 *     new process — and run 1's transactor is dropped, as a process exit drops it.
 *  3. **Run 2 writes the same collection, and it must land.** Its pend asks for revision 2 too. Before
 *     the fix the pend is refused naming run 1's dead action, and a tree write exhausts its retries
 *     with `SyncRetryExhaustedError … held by unresolved rival action(s) <the dead action>`.
 *
 * Two shapes must stay refused, because they are live reservations and not dead ones: a second
 * writer in the SAME run (two handles in one process racing for one slot), and a record a DIFFERENT
 * machine wrote through this node (a remote client whose process may still commit it).
 */

import { expect } from 'chai';
import { Tree, type ActionId, type BlockId, type ITransactor, type PendRequest, type PendResult } from '@optimystic/db-core';
import type { Mesh, MeshNode } from '../src/testing/mesh-harness.js';
import { createProductionShapedMesh, transactorDrivenBy } from './util/node-count-mesh.js';
import { sequentialPhases } from './util/two-machine-lifecycle.js';

const TREE_ID = 'an-interrupted-write-does-not-wedge-the-collection';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

describe('An interrupted write does not wedge the collection for good (one machine)', function () {
	this.timeout(90_000);
	sequentialPhases();

	let mesh: Mesh;
	let node: MeshNode;
	/** The log tail block every write to the collection names, read off the committed header. */
	let tailId: BlockId;
	/** Run 1's interrupted write. */
	const deadAction = 'dead-action-of-run-1' as ActionId;

	/** A pend of `actionId` at revision 2 on the log tail — the shape every second write to the collection takes. */
	const secondWriteOf = (actionId: ActionId): PendRequest => ({
		transforms: { updates: { [tailId]: [['entries', 0, 0, []]] } },
		actionId,
		rev: 2,
		policy: 'r',
		soleReservation: true,
		baseRevs: { [tailId]: 1 }
	});

	async function committedTailId(): Promise<BlockId> {
		const header = (await node.storageRepo.get({ blockIds: [TREE_ID as BlockId] }))[TREE_ID as BlockId]?.block as { tailId?: BlockId } | undefined;
		expect(header?.tailId, 'the committed header names the log tail').to.be.a('string');
		return header!.tailId!;
	}

	before(async () => {
		mesh = await createProductionShapedMesh(1);
		node = mesh.nodes[0]!;
	});

	it('phase 1: run 1 writes a row; the collection is at revision 1', async () => {
		const tree = await Tree.createOrOpen<string, Row>(transactorDrivenBy(mesh, node), TREE_ID, keyOf);
		const durability = await tree.replace([['a', { key: 'a', value: 'first' }]]);
		expect(durability?.quorum).to.equal('local');
		tailId = await committedTailId();
	});

	it('phase 2: run 1 pends a second write, and the process exits before committing or cancelling it', async () => {
		const run1: ITransactor = transactorDrivenBy(mesh, node);
		const pended = await run1.pend(secondWriteOf(deadAction));
		expect(pended.success, 'run 1\'s pend lands').to.equal(true);
		// The process exits: the node is rebuilt over the same storage and run 1's transactor is never used again.
		mesh.restart(node);
		expect(await holdersOf(deadAction), 'the record survives the restart').to.deep.equal([tailId]);
	});

	it('phase 3: run 2\'s write to the collection lands on its first pend', async () => {
		const run2: ITransactor = transactorDrivenBy(mesh, node);
		const result: PendResult = await run2.pend(secondWriteOf('fresh-action-of-run-2' as ActionId));
		expect(result.success, `run 2's pend is refused: ${describe(result)}`).to.equal(true);
		await run2.cancel({ actionId: 'fresh-action-of-run-2' as ActionId, blockIds: [tailId] });
		expect(await holdersOf(deadAction), 'the dead record is gone').to.deep.equal([]);
	});

	it('phase 3b: a tree write from run 2 commits instead of exhausting its retries', async () => {
		const tree = await Tree.createOrOpen<string, Row>(transactorDrivenBy(mesh, node), TREE_ID, keyOf);
		const durability = await tree.replace([['b', { key: 'b', value: 'second' }]]);
		expect(durability?.quorum).to.equal('local');
	});

	it('phase 4: a second writer in the same run is still refused by a live reservation', async () => {
		const run2: ITransactor = transactorDrivenBy(mesh, node);
		const rival: ITransactor = transactorDrivenBy(mesh, node);
		const liveAction = 'live-action-of-run-2' as ActionId;
		const nextTail = await committedTailId();
		const pendOf = (actionId: ActionId): PendRequest => ({
			transforms: { updates: { [nextTail]: [['entries', 0, 0, []]] } },
			actionId, rev: 3, policy: 'r', soleReservation: true, baseRevs: { [nextTail]: 2 }
		});
		expect((await run2.pend(pendOf(liveAction))).success).to.equal(true);
		const refused = await rival.pend(pendOf('racing-action-of-run-2' as ActionId));
		expect(refused.success, 'a live record of this run reserves the slot').to.equal(false);
		await run2.cancel({ actionId: liveAction, blockIds: [nextTail] });
	});

	/** The blocks whose pending records on this node name `actionId`. */
	async function holdersOf(actionId: ActionId): Promise<BlockId[]> {
		const entry = (await node.storageRepo.get({ blockIds: [tailId] }))[tailId];
		return (entry?.state?.pendings ?? []).includes(actionId) ? [tailId] : [];
	}

	function describe(result: PendResult): string {
		if (result.success) return 'success';
		const pending = 'pending' in result ? (result.pending ?? []).map(p => p.actionId).join(', ') : '';
		return `conflict=${'conflict' in result ? result.conflict : '?'} pending=[${pending}]`;
	}
});
