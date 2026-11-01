/**
 * Ticket: a-coordinator-runs-an-actions-collections-as-one-record.
 *
 * `CoordinatorRepo.pendMany` and `commitMany` run one action's pends, or commits, of several collections
 * as one consensus record. Each collection keeps its own request and counts its revisions separately, so
 * a committed batch lands every collection at the revision its own request named, and a refusal is read
 * per collection: a member that already holds a newer revision of any collection rejects the record, and
 * the coordinator turns that rejection into a retryable conflict only when its own storage confirms the
 * loss, reading every collection's blocks against the revision that collection's own request asked for.
 */

import { expect } from 'chai';
import type { ActionId, BlockHeader, BlockId, CommitRequest, IBlock, PendRequest, StaleFailure, Transforms } from '@optimystic/db-core';
import { createMesh, type MeshNode } from '../src/testing/mesh-harness.js';

/** The log tail of the first collection (a table) and of the second (one of its indexes). */
const TABLE_TAIL = 'batch-table-tail' as BlockId;
const INDEX_TAIL = 'batch-index-tail' as BlockId;
const ACTION = 'a-batch' as ActionId;

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

/** Seed the table at revision 5 and the index at revision 3, each by its own one-collection write. */
const seed = async (node: MeshNode): Promise<void> => {
	await write(node, 'a-seed-table', TABLE_TAIL, 5, insertOf(TABLE_TAIL, 'table'));
	await write(node, 'a-seed-index', INDEX_TAIL, 3, insertOf(INDEX_TAIL, 'table/index/by-name'));
};

describe('a coordinator running one action\'s collections as one record', () => {
	it('commits every collection on every member, each at the revision its own request named', async () => {
		const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
		const nodes = mesh.nodes as [MeshNode, MeshNode];
		const [coordinator] = nodes;
		await seed(coordinator);

		const pends: PendRequest[] = [
			{ actionId: ACTION, rev: 6, transforms: updateOf(TABLE_TAIL), policy: 'c' },
			{ actionId: ACTION, rev: 4, transforms: updateOf(INDEX_TAIL), policy: 'c' }
		];
		expect((await coordinator.coordinatorRepo.pendMany(pends)).success, 'batch pend').to.equal(true);
		const commits: CommitRequest[] = [
			{ actionId: ACTION, blockIds: [TABLE_TAIL], tailId: TABLE_TAIL, rev: 6 },
			{ actionId: ACTION, blockIds: [INDEX_TAIL], tailId: INDEX_TAIL, rev: 4 }
		];
		expect((await coordinator.coordinatorRepo.commitMany(commits)).success, 'batch commit').to.equal(true);

		for (const node of nodes) {
			const held = await node.storageRepo.get({ blockIds: [TABLE_TAIL, INDEX_TAIL] });
			expect(held[TABLE_TAIL]?.state.latest, `${node.peerId} table`).to.deep.equal({ actionId: ACTION, rev: 6 });
			expect(held[INDEX_TAIL]?.state.latest, `${node.peerId} index`).to.deep.equal({ actionId: ACTION, rev: 4 });
		}
	});

	it('answers a rival\'s newer revision of the second collection with a conflict naming that collection', async () => {
		const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
		const [coordinator] = mesh.nodes as [MeshNode, MeshNode];
		// The table sits at revision 5 and the index at 4, taken by a rival. The batch asks for 6 and 4:
		// read against the table's revision the index would look current, and against the index's the
		// table would look lost, so only a per-collection reading names the index alone.
		await seed(coordinator);
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
