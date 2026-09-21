/**
 * Ticket: cluster-commit-round-carries-the-coordinators-commit-vote.
 *
 * The coordinating machine signs its own commit vote in process before the commit round goes out, so
 * in a two-member cohort the other member reaches consensus, and applies, on receipt of that round.
 * The consensus broadcast that used to be every operation's third call to each remote member is then
 * owed only to a member that has not applied or reports a refused commit — in a healthy cohort, to
 * nobody. Sereus measured 9 `/cluster` streams for one inserted row over a relay before this.
 *
 * The coordinating member now applies only after the commit round, so when the other member misses
 * that round the record holds one commit of two and nobody applies. The scheduled commit retry is what
 * completes the majority then, and it has to reach the coordinating member as well as the returning one.
 */

import { expect } from 'chai';
import type { BlockHeader, BlockId, ClusterRecord, IBlock, Transforms } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

const BLOCK = 'commit-vote-block' as BlockId;
const ACTION = 'commit-vote-action';

const transforms: Transforms = {
	inserts: { [BLOCK]: { header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
};

const commitRequest = { actionId: ACTION, tailId: BLOCK, rev: 1, blockIds: [BLOCK] };

const latestOn = async (node: MeshNode) =>
	(await node.storageRepo.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest;

const isCommitRound = (record: ClusterRecord): boolean =>
	record.message.operations.some(op => 'commit' in op) && Object.keys(record.commits).length === 1;

describe('the commit round carries the coordinating member\'s commit vote (two-member cohort)', () => {
	let mesh: Mesh;
	let coordinator: MeshNode;
	let other: MeshNode;

	beforeEach(async () => {
		mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
		[coordinator, other] = mesh.nodes as [MeshNode, MeshNode];
	});

	it('a consensus operation costs the other member two calls, and it applies on the second', async () => {
		const deliveries: string[] = [];
		mesh.failures.onClusterDelivery = (target) => { deliveries.push(target); };

		const pended = await coordinator.coordinatorRepo.pend({ actionId: ACTION, transforms, policy: 'c' });
		expect(pended.success, 'pend').to.equal(true);
		const committed = await coordinator.coordinatorRepo.commit(commitRequest);
		expect(committed.success, 'commit').to.equal(true);

		const otherId = other.peerId.toString();
		expect(deliveries, 'promise and commit round for the pend, then for the commit — no broadcast').to.deep.equal([otherId, otherId, otherId, otherId]);
		for (const node of mesh.nodes) {
			expect(await latestOn(node), 'both members hold the commit').to.deep.equal({ actionId: ACTION, rev: 1 });
		}
	});

	it('a member that missed the commit round applies when the retry reaches it, and the coordinating member then applies too', async () => {
		const pended = await coordinator.coordinatorRepo.pend({ actionId: ACTION, transforms, policy: 'c' });
		expect(pended.success, 'pend').to.equal(true);
		let missed = false;
		mesh.failures.onClusterDelivery = (target, record) => {
			if (!missed && target === other.peerId.toString() && isCommitRound(record)) {
				missed = true;
				throw new Error('the other member misses the commit round');
			}
		};

		const committed = await coordinator.coordinatorRepo.commit(commitRequest);
		expect(missed, 'the other member missed the commit round').to.equal(true);
		expect(committed.success, 'one commit of two is no majority, so nobody applied and nothing is durable').to.equal(false);
		expect(await latestOn(coordinator), 'the coordinating member has not applied').to.equal(undefined);

		await waitFor(async () => (await latestOn(coordinator))?.rev === 1 && (await latestOn(other))?.rev === 1, {
			timeoutMs: 5_000,
			description: 'both members hold the commit once the scheduled retry reaches the other member'
		});
	});
});
