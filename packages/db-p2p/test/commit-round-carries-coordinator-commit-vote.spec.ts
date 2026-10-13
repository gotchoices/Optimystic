/**
 * Tickets: cluster-commit-round-carries-the-coordinators-commit-vote, then
 * a-single-collection-write-defers-a-two-member-pends-delivery.
 *
 * On a two-member cohort the other member, answering a promise round, sees both approvals and signs its
 * commit in the same answer. The coordinating node keeps that signature, since it was signed over the
 * record's final promise map, so its own member's pre-sign completes the majority and applies: no commit
 * round runs, and the other member is owed only the decision. For the pend of a write that reserves
 * everything it will commit through this one coordinator (`PendRequest.soleReservation`), that decision
 * rides on the first request of the action's commit. Such a write therefore costs the other member three
 * requests — the pend's promise round, the commit's promise round carrying the pend's decision, and the
 * commit's decision — where it cost four.
 */

import { expect } from 'chai';
import type { BlockHeader, BlockId, ClusterRecord, IBlock, PendRequest, Transforms } from '@optimystic/db-core';
import { isConflictFailure } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

const BLOCK = 'commit-vote-block' as BlockId;
const ACTION = 'commit-vote-action';

const transforms: Transforms = {
	inserts: { [BLOCK]: { header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
};

/** A single-collection write's pend, as `TransactorSource.transact` sends it. */
const pendRequest: PendRequest = { actionId: ACTION, transforms, policy: 'r', rev: 1, soleReservation: true };

const commitRequest = { actionId: ACTION, tailId: BLOCK, rev: 1, blockIds: [BLOCK] };

const latestOn = async (node: MeshNode) =>
	(await node.storageRepo.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest;

/** Read from storage metadata: `get` lists no pending record on a block with no committed revision. */
const pendingOn = async (node: MeshNode) =>
	(await node.storageRepo.listPendingClaims(BLOCK)).map(claim => claim.actionId);

/** The kind of a record's operation: `pend`, `commit` or `cancel`. */
const operationOf = (record: ClusterRecord): string => Object.keys(record.message.operations[0]!)[0]!;

/** Whether `record` is the commit operation's decision: the commit with every member's signature on it. */
const isCommitDecision = (record: ClusterRecord): boolean =>
	operationOf(record) === 'commit' && Object.keys(record.commits).length === Object.keys(record.peers).length;

/** One remote delivery as the other member saw it: the request's own operation, and the operations of the records it carried. */
interface Delivery { operation: string; carried: string[] }

describe('a single-collection write on a two-member cohort costs the other member three requests', () => {
	let mesh: Mesh;
	let coordinator: MeshNode;
	let other: MeshNode;
	let deliveries: Delivery[];

	const build = async (coordinatorConfig?: { pendDeliveryDeferralMs?: number }) => {
		mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2, ...(coordinatorConfig ? { coordinatorConfig } : {}) });
		[coordinator, other] = mesh.nodes as [MeshNode, MeshNode];
		deliveries = [];
		mesh.failures.onClusterDelivery = (target, record, carried) => {
			if (target === other.peerId.toString()) deliveries.push({ operation: operationOf(record), carried: carried.map(operationOf) });
		};
	};

	it('the pend\'s decision rides on the commit\'s first request, and both members hold the commit', async () => {
		await build();

		expect((await coordinator.coordinatorRepo.pend(pendRequest)).success, 'pend').to.equal(true);
		expect(await pendingOn(other), 'the other member has not applied the pend yet').to.deep.equal([]);
		const committed = await coordinator.coordinatorRepo.commit(commitRequest);
		expect(committed.success, 'commit').to.equal(true);

		expect(deliveries, 'the pend\'s promise round; the commit\'s promise round carrying the pend; the commit\'s decision').to.deep.equal([
			{ operation: 'pend', carried: [] },
			{ operation: 'commit', carried: ['pend'] },
			{ operation: 'commit', carried: [] }
		]);
		for (const node of mesh.nodes) {
			expect(await latestOn(node), 'both members hold the commit').to.deep.equal({ actionId: ACTION, rev: 1 });
		}
	});

	it('a pend the writer did not mark its action\'s only reservation is delivered at once: four requests', async () => {
		await build();
		const { soleReservation: _sole, ...unmarked } = pendRequest;

		expect((await coordinator.coordinatorRepo.pend(unmarked)).success, 'pend').to.equal(true);
		expect((await coordinator.coordinatorRepo.commit(commitRequest)).success, 'commit').to.equal(true);

		expect(deliveries.map(d => d.operation), 'promise round and decision for each operation').to.deep.equal(['pend', 'pend', 'commit', 'commit']);
		expect(deliveries.flatMap(d => d.carried), 'nothing is carried').to.deep.equal([]);
	});

	it('a member on an older build gets four requests and is carried nothing', async () => {
		await build();
		mesh.failures.carryUnawarePeers = new Set([other.peerId.toString()]);

		expect((await coordinator.coordinatorRepo.pend(pendRequest)).success, 'pend').to.equal(true);
		expect((await coordinator.coordinatorRepo.commit(commitRequest)).success, 'commit').to.equal(true);

		expect(deliveries.map(d => d.operation), 'promise round and decision for each operation').to.deep.equal(['pend', 'pend', 'commit', 'commit']);
		expect(deliveries.flatMap(d => d.carried), 'nothing is carried').to.deep.equal([]);
		for (const node of mesh.nodes) {
			expect(await latestOn(node), 'both members hold the commit').to.deep.equal({ actionId: ACTION, rev: 1 });
		}
	});

	it('a pend with no commit after it reaches the other member when the deferral runs out', async () => {
		await build({ pendDeliveryDeferralMs: 50 });

		expect((await coordinator.coordinatorRepo.pend(pendRequest)).success, 'pend').to.equal(true);
		expect(deliveries.map(d => d.operation), 'only the promise round so far').to.deep.equal(['pend']);

		await waitFor(async () => (await pendingOn(other)).includes(ACTION), {
			timeoutMs: 5_000,
			description: 'the other member holds the pending record once the deferral runs out'
		});
		expect(deliveries, 'the decision went alone').to.deep.equal([{ operation: 'pend', carried: [] }, { operation: 'pend', carried: [] }]);
	});

	it('the other member\'s refusal of the carried pend answers the commit as a retryable conflict', async () => {
		await build();

		expect((await coordinator.coordinatorRepo.pend(pendRequest)).success, 'pend').to.equal(true);
		// A rival takes the block on the other member before the pend's decision reaches it.
		expect((await other.storageRepo.pend({ actionId: 'commit-vote-rival', transforms, policy: 'c', rev: 1 })).success, 'rival').to.equal(true);

		const committed = await coordinator.coordinatorRepo.commit(commitRequest);

		expect(committed.success, 'commit').to.equal(false);
		expect(!committed.success && isConflictFailure(committed), 'the other member\'s pend refusal, as a retryable conflict').to.equal(true);
		for (const node of mesh.nodes) {
			expect(await latestOn(node), 'no member holds the revision').to.equal(undefined);
		}
		expect(await pendingOn(other), 'the other member kept only the rival').to.deep.equal(['commit-vote-rival']);
	});

	it('a member that missed the commit\'s decision applies when the retry reaches it', async () => {
		await build();
		expect((await coordinator.coordinatorRepo.pend(pendRequest)).success, 'pend').to.equal(true);
		// Both attempts of the decision's delivery fail: the first and its in-line retry.
		let missed = 0;
		mesh.failures.onClusterDelivery = (target, record) => {
			if (missed < 2 && target === other.peerId.toString() && isCommitDecision(record)) {
				missed++;
				throw new Error('the other member misses the commit\'s decision');
			}
		};

		const committed = await coordinator.coordinatorRepo.commit(commitRequest);
		expect(missed, 'the other member missed the decision').to.equal(2);
		expect(committed.success, 'one holder of two is not a durable majority').to.equal(false);
		expect(await latestOn(coordinator), 'the coordinating member applied on its pre-sign').to.deep.equal({ actionId: ACTION, rev: 1 });

		await waitFor(async () => (await latestOn(other))?.rev === 1, {
			timeoutMs: 5_000,
			description: 'the other member holds the commit once the scheduled retry reaches it'
		});
	});
});
