/**
 * Ticket: a-coordinator-runs-an-actions-collections-as-one-record.
 *
 * `CoordinatorRepo.pendMany` runs one action's pends of several collections as one consensus record. A
 * member that already holds a newer revision of any collection rejects the record, and the coordinator
 * turns that rejection into a retryable conflict only when its own storage confirms the loss. Each
 * collection counts its revisions separately, so the confirmation has to read every collection's blocks
 * against the revision that collection's own request asked for, and report the one that lost.
 */

import { expect } from 'chai';
import type { ActionId, BlockHeader, BlockId, IBlock, PendRequest, StaleFailure, Transforms } from '@optimystic/db-core';
import { createMesh, type MeshNode } from '../src/testing/mesh-harness.js';

/** The log tail of the first collection (a table) and of the second (one of its indexes). */
const TABLE_TAIL = 'batch-pend-table-tail' as BlockId;
const INDEX_TAIL = 'batch-pend-index-tail' as BlockId;
const ACTION = 'a-batch-pend' as ActionId;

const insertOf = (blockId: BlockId, collectionId: string): Transforms => ({
	inserts: { [blockId]: { header: { id: blockId, type: 'test', collectionId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
});

const updateOf = (blockId: BlockId): Transforms => ({ inserts: {}, updates: { [blockId]: [] }, deletes: [] });

/** Pend and commit `transforms` on `blockId` at `rev` through the coordinator, as one collection's write. */
const write = async (node: MeshNode, actionId: string, blockId: BlockId, rev: number, transforms: Transforms): Promise<void> => {
	expect((await node.coordinatorRepo.pend({ actionId, rev, transforms, policy: 'c' })).success, `${actionId} pend`).to.equal(true);
	expect((await node.coordinatorRepo.commit({ actionId, blockIds: [blockId], tailId: blockId, rev })).success, `${actionId} commit`).to.equal(true);
};

describe('a coordinator running one action\'s pends of several collections as one record', () => {
	it('answers a rival\'s newer revision of the second collection with a conflict naming that collection', async () => {
		const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
		const [coordinator] = mesh.nodes as [MeshNode, MeshNode];
		// The table sits at revision 5 and the index at 4, taken by a rival. The batch asks for 6 and 4:
		// read against the table's revision the index would look current, and against the index's the
		// table would look lost, so only a per-collection reading names the index alone.
		await write(coordinator, 'a-seed-table', TABLE_TAIL, 5, insertOf(TABLE_TAIL, 'table'));
		await write(coordinator, 'a-seed-index', INDEX_TAIL, 3, insertOf(INDEX_TAIL, 'table/index/by-name'));
		await write(coordinator, 'a-rival', INDEX_TAIL, 4, updateOf(INDEX_TAIL));

		const requests: PendRequest[] = [
			{ actionId: ACTION, rev: 6, transforms: updateOf(TABLE_TAIL), policy: 'c' },
			{ actionId: ACTION, rev: 4, transforms: updateOf(INDEX_TAIL), policy: 'c' }
		];
		const result = await coordinator.coordinatorRepo.pendMany(requests);

		expect(result.success).to.equal(false);
		const refusal = result as StaleFailure;
		expect(refusal.conflict).to.equal(true);
		expect(refusal.staleAt).to.deep.equal({ blockId: INDEX_TAIL, rev: 4 });
	});
});
