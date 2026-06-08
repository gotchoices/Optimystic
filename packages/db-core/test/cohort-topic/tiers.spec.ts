import { expect } from 'chai';
import {
	Tier,
	ALL_TIERS,
	edgeProfile,
	coreProfile,
} from '../../src/cohort-topic/tiers.js';

describe('cohort-topic / tier ladder', () => {
	it('Tier values are T0..T3 = 0..3 in priority order', () => {
		expect([Tier.T0, Tier.T1, Tier.T2, Tier.T3]).to.deep.equal([0, 1, 2, 3]);
		expect(ALL_TIERS).to.deep.equal([0, 1, 2, 3]);
	});

	describe('edge profile', () => {
		it('forwards T0 + T1 only; excludes T2/T3', () => {
			const p = edgeProfile();
			expect(p.kind).to.equal('edge');
			expect(p.willingTiers.has(Tier.T0)).to.equal(true);
			expect(p.willingTiers.has(Tier.T1)).to.equal(true);
			expect(p.willingTiers.has(Tier.T2)).to.equal(false);
			expect(p.willingTiers.has(Tier.T3)).to.equal(false);
			expect(p.willingTiers.size).to.equal(2);
		});

		it('cannot be widened to T2/T3 via operator override (override only narrows)', () => {
			const p = edgeProfile({ willingTiers: [Tier.T0, Tier.T1, Tier.T2, Tier.T3] });
			expect(p.willingTiers.has(Tier.T2)).to.equal(false);
			expect(p.willingTiers.has(Tier.T3)).to.equal(false);
			expect(p.willingTiers.size).to.equal(2);
		});

		it('an override may further narrow an edge node to {T0}', () => {
			const p = edgeProfile({ willingTiers: [Tier.T0] });
			expect([...p.willingTiers]).to.deep.equal([Tier.T0]);
		});
	});

	describe('core profile', () => {
		it('forwards all four tiers by default', () => {
			const p = coreProfile();
			expect(p.kind).to.equal('core');
			for (const t of ALL_TIERS) expect(p.willingTiers.has(t)).to.equal(true);
			expect(p.willingTiers.size).to.equal(4);
		});

		it('operator override narrows core to a subset', () => {
			const p = coreProfile({ willingTiers: [Tier.T0, Tier.T1, Tier.T2] });
			expect(p.willingTiers.has(Tier.T3)).to.equal(false);
			expect(p.willingTiers.size).to.equal(3);
		});

		it('override cannot introduce out-of-range tiers', () => {
			// Requesting only T3 narrows to exactly {T3}; nothing spurious appears.
			const p = coreProfile({ willingTiers: [Tier.T3] });
			expect([...p.willingTiers]).to.deep.equal([Tier.T3]);
		});
	});
});
