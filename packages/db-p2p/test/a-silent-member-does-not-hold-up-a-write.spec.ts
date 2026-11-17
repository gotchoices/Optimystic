/**
 * Ticket: a-consensus-round-stops-waiting-once-its-outcome-is-decided (GitHub #64).
 *
 * A member that is connected but does not answer — a sleeping phone, a background browser tab — used to cost
 * every write it took part in its whole RPC deadline, once per round: the coordinator awaited every member of
 * each round before counting. On a cohort of four the other three decide each round alone, so the write now
 * completes, and is acknowledged, while the fourth has answered nothing. The fourth is owed every record and
 * is never blamed for its silence: once it answers, it is sent what it missed and holds the commit.
 */

import { expect } from 'chai';
import type { BlockHeader, BlockId, IBlock, PendRequest, Transforms } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { createMesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
import { DEFAULT_RESPONSE_TIMEOUT_MS } from '../src/rpc-deadline.js';

const BLOCK = 'silent-member-block' as BlockId;
const ACTION = 'silent-member-action';

const transforms: Transforms = {
	inserts: { [BLOCK]: { header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId } as BlockHeader } as IBlock },
	updates: {},
	deletes: []
};

const pendRequest: PendRequest = { actionId: ACTION, transforms, policy: 'r', rev: 1 };
const commitRequest = { actionId: ACTION, tailId: BLOCK, rev: 1, blockIds: [BLOCK] };

const latestOn = async (node: MeshNode) =>
	(await node.storageRepo.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest;

describe('a silent member does not hold up a write', () => {
	it('a four-member cohort commits without the silent member, which holds the commit once it answers', async () => {
		const reputation = new PeerReputationService();
		const mesh = await createMesh(4, { responsibilityK: 4, clusterSize: 4, reputationFor: () => reputation });
		const [coordinator, , , silent] = mesh.nodes as [MeshNode, MeshNode, MeshNode, MeshNode];
		const silentId = silent.peerId.toString();
		let answer!: () => void;
		const asleep = new Promise<void>(resolve => { answer = resolve; });
		mesh.failures.onClusterDelivery = async target => {
			if (target === silentId) await asleep;
		};

		const started = Date.now();
		expect((await coordinator.coordinatorRepo.pend(pendRequest)).success, 'pend').to.equal(true);
		const committed = await coordinator.coordinatorRepo.commit(commitRequest);
		expect(committed.success, 'commit').to.equal(true);
		expect(Date.now() - started, 'well inside one RPC deadline').to.be.below(DEFAULT_RESPONSE_TIMEOUT_MS);
		expect(committed.success && committed.durability?.unconfirmed, 'the silent member is the one not confirmed').to.deep.equal([silentId]);
		expect(await latestOn(silent), 'the silent member has applied nothing yet').to.equal(undefined);
		expect(reputation.getScore(silentId), 'a member the rounds did not wait for is not penalised').to.equal(0);

		answer();
		await waitFor(async () => (await latestOn(silent))?.rev === 1, {
			timeoutMs: 10_000,
			description: 'the silent member holds the commit once it answers, with no further write'
		});
		expect(reputation.getScore(silentId), 'nor once it answers late').to.equal(0);
	});
});
