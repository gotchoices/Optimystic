import { expect } from 'chai';
import {
	CohortMembership,
	cohortEpochOf,
	slotOf,
	fnv1a32
} from '../src/cohort-membership.js';

/** k synthetic member ids 'm00'..'m{k-1}'. */
function members(k: number): string[] {
	return Array.from({ length: k }, (_v, i) => `m${i.toString().padStart(2, '0')}`);
}

describe('CohortMembership — deterministic primary/backup assignment', () => {
	it('epoch is order-independent and stable for a given member set', () => {
		const ids = members(16);
		const shuffled = [...ids].reverse();
		expect(cohortEpochOf(ids)).to.equal(cohortEpochOf(shuffled));
		expect(new CohortMembership(ids).epoch).to.equal(new CohortMembership(shuffled).epoch);
	});

	it('assigns primary = order[slot], two distinct backups following the slot, all members', () => {
		const m = new CohortMembership(members(16));
		const { primary, backups } = m.assign('participant-A');
		const slot = slotOf('participant-A', m.epoch, m.size);
		expect(primary).to.equal(m.members[slot]);
		expect(backups).to.have.lengthOf(2);
		expect(backups).to.not.include(primary);
		expect(new Set([primary, ...backups]).size).to.equal(3); // all distinct
		for (const id of [primary, ...backups]) {
			expect(m.has(id)).to.equal(true);
		}
		// Wrap-around: backups are the next two members modulo k.
		expect(backups).to.deep.equal([m.members[(slot + 1) % 16], m.members[(slot + 2) % 16]]);
	});

	it('a cohort of one yields no backups; assignment is the lone member', () => {
		const m = new CohortMembership(['solo']);
		expect(m.assign('p')).to.deep.equal({ primary: 'solo', backups: [] });
	});

	it('slot is H(participantId ‖ cohortEpoch) mod k and stays in range', () => {
		const m = new CohortMembership(members(15));
		for (const p of ['a', 'b', 'longer-participant-id', 'zzz']) {
			const slot = slotOf(p, m.epoch, m.size);
			expect(slot).to.equal(fnv1a32(`${p} ${m.epoch}`) % 15);
			expect(slot).to.be.within(0, 14);
		}
	});
});

describe('CohortMembership — partition split / heal convergence (membership level)', () => {
	it('healed (merged) membership reproduces the pre-split epoch and assignment', () => {
		const pre = new CohortMembership(members(16));
		const sideA = new Set(pre.members.slice(0, 8));
		const [a, b] = pre.split((id) => sideA.has(id));

		expect(a.size + b.size).to.equal(pre.size);
		expect([...a.members].some((id) => b.has(id))).to.equal(false); // disjoint

		const healed = CohortMembership.merge(a, b);
		expect(healed.epoch).to.equal(pre.epoch);
		// Every participant's healed primary matches the pre-split primary — both sides converge.
		for (const p of ['p1', 'p2', 'p3', 'subscriber-x']) {
			expect(healed.assign(p).primary).to.equal(pre.assign(p).primary);
		}
	});

	it('the two partition sides generally disagree while split (the partition genuinely diverges)', () => {
		const pre = new CohortMembership(members(16));
		const sideA = new Set(pre.members.slice(0, 8));
		const [a, b] = pre.split((id) => sideA.has(id));
		// At least one participant is served by different primaries on the two isolated sides.
		const diverged = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].some(
			(p) => a.assign(p).primary !== b.assign(p).primary
		);
		expect(diverged).to.equal(true);
	});
});
