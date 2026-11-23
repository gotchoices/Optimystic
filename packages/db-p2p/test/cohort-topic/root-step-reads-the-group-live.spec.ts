import { expect } from 'chai';
import { type Tier } from '@optimystic/db-core';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import type { RootGroupOptions } from '../../src/cohort-topic/host.js';
import { buildMesh, makeMembers } from '../../src/testing/cohort-topic-mesh-harness.js';

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i * 9 + 5) & 0xff);
const ROOT_KEY = new TextEncoder().encode('tail-block-id:root-placement');

describe('cohort-topic: the root step of a register walk reads the group live', () => {
	it('a second walk reaches the group the rule names now, not the one the first walk filled the snapshot with', async function () {
		this.timeout(20_000);
		const members = await makeMembers(3);
		const [g0, g1, participant] = members as [typeof members[0], typeof members[0], typeof members[0]];
		// The participant's view of the root group is what the walk's root step dials. It starts at [g0] and
		// moves to [g1]; each group member reads itself as the whole group, so whichever one a walk dials
		// admits and reports itself — making the reply name the group the walk actually reached.
		let participantView: readonly string[] = [g0.idStr];
		const mesh = await buildMesh(members, {
			wantK: 3,
			minSigs: 2,
			sizeEstimate: 16,
			rootGroup: (m): RootGroupOptions => ({
				quorumRatio: 0.75,
				membersAt: (): Promise<readonly string[]> =>
					Promise.resolve(m.idStr === participant.idStr ? participantView : [m.idStr]),
			}),
		});
		try {
			const svc = mesh.nodeOf(participant.idStr).host.service;
			const first = await svc.register({ topicId: TOPIC, tier: 0 as Tier, rootKey: ROOT_KEY });
			expect(first.cohortMembers.map(bytesToPeerIdString), 'the first walk lands on g0').to.deep.equal([g0.idStr]);

			participantView = [g1.idStr];
			const second = await svc.register({ topicId: TOPIC, tier: 0 as Tier, rootKey: ROOT_KEY });
			expect(second.cohortMembers.map(bytesToPeerIdString), 'the second walk lands on the group the rule names now').to.deep.equal([g1.idStr]);
		} finally {
			await mesh.stop();
		}
	});
});
