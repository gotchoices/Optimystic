import { expect } from 'chai';
import {
	makeMemberWillingness,
	setMemberLoadBucket,
	isWilling,
	willingnessVector,
	willingnessBits,
	cohortWillingnessBits,
	classifyAdmission,
	type Tier
} from '../src/willingness.js';

describe('willingness — device profiles', () => {
	it('Edge advertises T0+T1 only; Core advertises all four', () => {
		const edge = makeMemberWillingness('edge');
		const core = makeMemberWillingness('core');
		expect(willingnessVector(edge)).to.deep.equal([true, true, false, false]);
		expect(willingnessVector(core)).to.deep.equal([true, true, true, true]);
		expect(willingnessBits(edge)).to.equal(0b0011);
		expect(willingnessBits(core)).to.equal(0b1111);
	});

	it('Edge never advertises T2/T3, even with an override or zero load attempting to turn them on', () => {
		const edge = makeMemberWillingness('edge', { overrides: { 2: true, 3: true } });
		setMemberLoadBucket(edge, 2, 0);
		setMemberLoadBucket(edge, 3, 0);
		expect(isWilling(edge, 2)).to.equal(false);
		expect(isWilling(edge, 3)).to.equal(false);
		// T0/T1 remain advertised.
		expect(isWilling(edge, 0)).to.equal(true);
		expect(isWilling(edge, 1)).to.equal(true);
	});

	it('a per-node override can restrict a Core node to fewer tiers', () => {
		const restricted = makeMemberWillingness('core', { overrides: { 3: false } });
		expect(willingnessVector(restricted)).to.deep.equal([true, true, true, false]);
	});
});

describe('willingness — load barometer sheds tiers', () => {
	it('flips a tier off when its load bucket reaches the overload threshold, and back on below it', () => {
		const core = makeMemberWillingness('core'); // overloadBucket = 6
		expect(isWilling(core, 2)).to.equal(true);
		setMemberLoadBucket(core, 2, 6);
		expect(isWilling(core, 2)).to.equal(false); // shed under overload
		setMemberLoadBucket(core, 2, 5);
		expect(isWilling(core, 2)).to.equal(true); // recovered below threshold
	});
});

describe('willingness — cohort-level classification', () => {
	const core = (): ReturnType<typeof makeMemberWillingness> => makeMemberWillingness('core');

	it('aggregates a willing-bit per tier on a member quorum', () => {
		const members = [core(), core(), makeMemberWillingness('edge')];
		// Quorum 2: T0/T1 — all three (≥2). T2/T3 — only the two cores (=2), edge unwilling.
		expect(cohortWillingnessBits(members, 2)).to.equal(0b1111);
		// Quorum 3: T2/T3 lose the bit (only 2 cores willing).
		expect(cohortWillingnessBits(members, 3)).to.equal(0b0011);
	});

	it('accepted when the routed member is willing', () => {
		const members = [core(), core()];
		expect(classifyAdmission(members, 2, 0, 1).result).to.equal('accepted');
	});

	it('unwilling_member when the routed member sheds but a sibling will serve', () => {
		const members = [core(), core()];
		setMemberLoadBucket(members[0]!, 2, 6); // routed member sheds T2
		const verdict = classifyAdmission(members, 2 as Tier, 0, 1);
		expect(verdict.result).to.equal('unwilling_member');
		expect(verdict.candidates).to.deep.equal([1]);
	});

	it('unwilling_cohort when fewer than quorum members will serve the tier', () => {
		const members = [makeMemberWillingness('edge'), makeMemberWillingness('edge')];
		// No edge member serves T2 → quorum cannot be met.
		expect(classifyAdmission(members, 2 as Tier, 0, 1).result).to.equal('unwilling_cohort');
	});
});
