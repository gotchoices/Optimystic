/**
 * Ticket: a-decided-promise-map-is-never-extended.
 *
 * A member's commit vote is a signature over the record's whole promise map, and every member checks every
 * commit signature against the record it holds. So once a record's approved promises reach super-majority
 * — it is decided — adding a promise to it invalidates every commit signature already on it.
 *
 * On a four-member cohort (super-majority 3 of 4) a member that missed the promise round is still sent the
 * commit round. Before the fix it added its own promise there, signed its commit over the map with that
 * promise, and the coordinator merged the commit into a record without it: every member then refused the
 * consensus broadcast (`Invalid commit signature from …`), nobody applied, and the retry timer re-sent the
 * same record. The late member now signs over the decided map as it is, and the broadcast applies.
 */

import { expect } from 'chai';
import type { BlockHeader, BlockId, ClusterRecord, IBlock, PendRequest, Transforms } from '@optimystic/db-core';
import { createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

const BLOCK = 'late-member-block' as BlockId;
const ACTION = 'late-member-action';

const transforms: Transforms = {
	inserts: { [BLOCK]: { header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
};

const pendRequest: PendRequest = { actionId: ACTION, transforms, policy: 'r', rev: 1 };

const pendingOn = async (node: MeshNode): Promise<string[]> =>
	(await node.storageRepo.listPendingClaims(BLOCK)).map(claim => claim.actionId);

const isPend = (record: ClusterRecord): boolean => 'pend' in record.message.operations[0]!;

/** Every error a member threw while handling a cluster update, in process or remote. */
function memberFaults(mesh: Mesh): string[] {
	const faults: string[] = [];
	for (const node of mesh.nodes) {
		const member = node.clusterMember;
		const update = member.update.bind(member);
		member.update = async (record: ClusterRecord): Promise<ClusterRecord> => {
			try {
				return await update(record);
			} catch (err) {
				faults.push(`${node.peerId.toString()}: ${(err as Error).message}`);
				throw err;
			}
		};
	}
	return faults;
}

describe('a member that missed the promise round signs its commit over the decided promise map', () => {
	it('the pend applies on every member at the consensus broadcast, with no invalid commit signature', async () => {
		const mesh = await createMesh(4, { responsibilityK: 4, clusterSize: 4 });
		const [coordinator, , , late] = mesh.nodes as [MeshNode, MeshNode, MeshNode, MeshNode];
		const lateId = late.peerId.toString();
		const faults = memberFaults(mesh);
		let missedPromiseRound = 0;
		/** The signers of the most commits any delivery carried: the consensus broadcast's. */
		let broadcastSigners: string[] = [];
		// The promise round's record carries no commit yet; every later delivery carries at least the
		// coordinating member's pre-signed one.
		mesh.failures.onClusterDelivery = (target, record) => {
			if (target === lateId && isPend(record) && Object.keys(record.commits).length === 0) {
				missedPromiseRound++;
				throw new Error('the late member misses the promise round');
			}
			if (Object.keys(record.commits).length > broadcastSigners.length) broadcastSigners = Object.keys(record.commits);
		};

		const pended = await coordinator.coordinatorRepo.pend(pendRequest);

		expect(missedPromiseRound, 'the late member missed the promise round').to.be.greaterThan(0);
		expect(pended.success, `pend: ${JSON.stringify(pended)}`).to.equal(true);
		expect(faults, 'no member refused a record').to.deep.equal([]);
		// A coordinator drops a commit signed over another map; this one was signed over the decided map.
		expect(broadcastSigners, 'the broadcast carries the late member\'s commit').to.include(lateId);
		// Read before any commit-retry timer can have run: what is applied here was applied by the broadcast.
		for (const [index, node] of mesh.nodes.entries()) {
			expect(await pendingOn(node), `member ${'ABCD'[index]} holds the pend`).to.include(ACTION);
		}
	});
});
