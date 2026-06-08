import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { CollectingEventSink } from '../src/topic-events.js';
import { CohortMembership } from '../src/cohort-membership.js';
import { TopicCohort, ParticipantRenewal } from '../src/registration.js';
import { splitMembership, healMembership, checkConvergence } from '../src/partition.js';

const SEED = 909;
const TTL = 90_000;

function members(k: number): string[] {
	return Array.from({ length: k }, (_v, i) => `m${i.toString().padStart(2, '0')}`);
}

describe('partition — split/heal convergence oracle', () => {
	it('checkConvergence reports a healed assignment equal to the pre-split assignment', () => {
		const pre = new CohortMembership(members(16));
		const sideA = new Set(pre.members.slice(0, 9));
		const [a, b] = splitMembership(pre, sideA);
		const result = checkConvergence(pre, a, b, 'subscriber');
		expect(result.healedEpoch).to.equal(result.preEpoch);
		expect(result.converged).to.equal(true);
		expect(result.healedPrimary).to.equal(pre.assign('subscriber').primary);
		expect(healMembership(a, b).epoch).to.equal(pre.epoch);
	});
});

describe('partition — subscriber repoints across a split then re-converges on heal', () => {
	it('serves on the isolated side, then converges to the pre-split primary within one gossip round', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const M = new CohortMembership(members(16));
		const sideAIds = new Set(M.members.slice(0, 8));
		const [a] = splitMembership(M, sideAIds);

		// A subscriber whose primary lives on side A (so it stays reachable across the partition —
		// the move is a deterministic primary_moved, not a crash) and whose side-A primary differs
		// from its whole-cohort primary (so the partition genuinely re-slots it).
		let participant = '';
		let pM = '';
		for (let i = 0; i < 300; i++) {
			const p = `sub-${i}`;
			const whole = M.assign(p).primary;
			if (sideAIds.has(whole) && a.assign(p).primary !== whole) {
				participant = p;
				pM = whole;
				break;
			}
		}
		expect(participant, 'found a side-A subscriber that re-slots under partition').to.not.equal('');

		const cohort = new TopicCohort({ topicId: 'topic', coord: 'c', tier: 1, membership: M, sink });
		cohort.register(participant, 0, TTL);
		const renewal = new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: participant, ttl: TTL });
		renewal.start();

		world.scheduler.run(renewal.pingInterval); // clean ping under whole membership
		expect(renewal.primary).to.equal(pM);

		// Partition: the cohort now only sees side A. The subscriber re-slots within side A.
		cohort.rotate(a);
		world.scheduler.run(3 * renewal.pingInterval);
		expect(renewal.repoints).to.be.greaterThan(0);
		expect(renewal.primary).to.equal(a.assign(participant).primary);

		// Heal: membership merges back to the pre-split set; the subscriber converges to pM.
		const healTime = world.scheduler.now();
		cohort.rotate(healMembership(a, splitMembership(M, sideAIds)[1]));
		world.scheduler.run(healTime + 3 * renewal.pingInterval);

		expect(renewal.primary).to.equal(pM);
		// Convergence detected via primary_moved within ~one renewal window (gossip round) of heal.
		expect(renewal.lastRepointAt).to.be.at.most(healTime + renewal.pingInterval);
		expect(sink.countOf('PrimaryMoved')).to.be.greaterThan(0);
	});
});
