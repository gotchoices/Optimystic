import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { CollectingEventSink } from '../src/topic-events.js';
import { CohortMembership } from '../src/cohort-membership.js';
import { TopicCohort, ParticipantRenewal } from '../src/registration.js';

const SEED = 4242;
const TTL = 90_000; // Core default; ping interval = ttl/3 = 30_000

function members(k: number): string[] {
	return Array.from({ length: k }, (_v, i) => `m${i.toString().padStart(2, '0')}`);
}

function buildCohort(sink?: CollectingEventSink): TopicCohort {
	return new TopicCohort({
		topicId: 'topic',
		coord: 'coordX',
		tier: 1,
		membership: new CohortMembership(members(16)),
		sink
	});
}

describe('registration — backup promotion within the renewal window', () => {
	it('a crashed primary promotes backups[0] after three failed pings and repoints', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const cohort = buildCohort(sink);
		const assignment = cohort.register('P', 0, TTL);
		const renewal = new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: 'P', ttl: TTL, sink });
		renewal.start();

		// Primary crashes before the first ping window: every ping to it now fails.
		cohort.kill(assignment.primary);

		// Two ping windows in: two failures, not yet promoted (needs three).
		world.scheduler.run(2 * renewal.pingInterval);
		expect(renewal.backupPromotions).to.equal(0);
		expect(renewal.failures).to.equal(2);

		// Third ping window: three consecutive failures → promote backups[0] via re-attach.
		world.scheduler.run(3 * renewal.pingInterval);
		expect(renewal.backupPromotions).to.equal(1);
		expect(renewal.primary).to.equal(assignment.backups[0]);
		expect(renewal.failures).to.equal(0);
		// Promotion landed within one TTL of the crash (3 × ttl/3) — bounded recovery window.
		expect(renewal.lastBackupPromotionAt).to.be.at.most(TTL);
		expect(sink.countOf('BackupPromoted')).to.equal(1);

		// The re-attached backup serves steadily thereafter: no further promotions or re-lookups.
		world.scheduler.run(10 * renewal.pingInterval);
		expect(renewal.backupPromotions).to.equal(1);
		expect(renewal.reLookups).to.equal(0);
	});

	it('falls through to re-lookup when the primary and all backups are unreachable', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const cohort = buildCohort();
		const assignment = cohort.register('Q', 0, TTL);
		const renewal = new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: 'Q', ttl: TTL });
		renewal.start();

		cohort.kill(assignment.primary);
		for (const b of assignment.backups) {
			cohort.kill(b);
		}
		world.scheduler.run(3 * renewal.pingInterval);
		// No reachable backup → re-run lookup against the live membership (a fresh primary).
		expect(renewal.backupPromotions).to.equal(0);
		expect(renewal.reLookups).to.equal(1);
		expect(cohort.reachable(renewal.primary)).to.equal(true);
	});
});

describe('registration — deterministic primary handoff (primary_moved)', () => {
	it('a membership rotation that re-slots the primary surfaces as primary_moved on the next ping', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const sink = new CollectingEventSink();
		const base = new CohortMembership(members(8));

		// Find a participant whose primary changes under a rotated membership while staying reachable
		// (so the move is a lazy primary_moved, not a crash-driven backup promotion).
		const rotated = base.withMembers([...base.members, 'm08']);
		let participant = '';
		for (let i = 0; i < 200; i++) {
			const p = `sub-${i}`;
			const before = base.assign(p).primary;
			const after = rotated.assign(p).primary;
			if (before !== after && rotated.has(before)) {
				participant = p;
				break;
			}
		}
		expect(participant, 'found a participant that re-slots under rotation').to.not.equal('');

		const cohort = new TopicCohort({ topicId: 'topic', coord: 'c', tier: 1, membership: base, sink });
		const original = cohort.register(participant, 0, TTL);
		const renewal = new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: participant, ttl: TTL });
		renewal.start();

		world.scheduler.run(renewal.pingInterval); // one clean ping
		expect(renewal.repoints).to.equal(0);
		expect(renewal.primary).to.equal(original.primary);

		// Rotate membership; the change is lazy — surfaced on the participant's next ping.
		cohort.rotate(rotated);
		world.scheduler.run(2 * renewal.pingInterval);
		expect(renewal.repoints).to.equal(1);
		expect(renewal.primary).to.equal(rotated.assign(participant).primary);
		expect(renewal.lastRepointAt).to.be.at.most(2 * renewal.pingInterval);
		expect(sink.countOf('PrimaryMoved')).to.equal(1);
	});
});

describe('registration — cohort-side stale eviction', () => {
	it('evicts a record only once its last ping ages past the TTL', () => {
		const sink = new CollectingEventSink();
		const cohort = buildCohort(sink);
		cohort.register('gone', 0, TTL);
		expect(cohort.registrationCount).to.equal(1);

		// Exactly at the TTL boundary it survives (now − lastPing == ttl, not > ttl).
		expect(cohort.evictStale(TTL)).to.deep.equal([]);
		expect(cohort.registrationCount).to.equal(1);

		// One ms past the TTL it is evicted and the event is emitted.
		expect(cohort.evictStale(TTL + 1)).to.deep.equal(['gone']);
		expect(cohort.registrationCount).to.equal(0);
		expect(sink.countOf('Evicted')).to.equal(1);
	});
});
