import { expect } from 'chai';
import type { ISizeEstimator } from '../../src/cohort-topic/ports.js';
import {
	makeDMaxComputer,
	DEFAULT_CONFIDENCE_MIN,
	DEFAULT_D_MAX_CAP,
} from '../../src/cohort-topic/dmax.js';

function fixedEstimator(nEst: number, confidence: number): ISizeEstimator {
	return { estimate: () => ({ nEst, confidence }) };
}

describe('cohort-topic / d_max', () => {
	it('d_max = max(0, floor(log_F(n_est)) − 1) across the N regime (F=16, high confidence)', () => {
		const cases: Array<[number, number]> = [
			[100, 0],
			[1_000, 1],
			[10_000, 2],
			[100_000, 3],
		];
		for (const [n, expected] of cases) {
			const c = makeDMaxComputer({ estimator: fixedEstimator(n, 0.9), F: 16 });
			expect(c.dMax(), `n=${n}`).to.equal(expected);
		}
	});

	it('is exact at powers of F (no floating-point off-by-one)', () => {
		// 16^2 = 256 → floor 2 → d_max 1; 16^3 = 4096 → floor 3 → d_max 2.
		expect(makeDMaxComputer({ estimator: fixedEstimator(256, 0.9), F: 16 }).dMax()).to.equal(1);
		expect(makeDMaxComputer({ estimator: fixedEstimator(4096, 0.9), F: 16 }).dMax()).to.equal(2);
		expect(makeDMaxComputer({ estimator: fixedEstimator(4095, 0.9), F: 16 }).dMax()).to.equal(1);
	});

	it('never goes negative for tiny networks', () => {
		expect(makeDMaxComputer({ estimator: fixedEstimator(1, 0.9), F: 16 }).dMax()).to.equal(0);
		expect(makeDMaxComputer({ estimator: fixedEstimator(15, 0.9), F: 16 }).dMax()).to.equal(0);
	});

	it('clamps to floor(d_max_cap / 2) when confidence < confidence_min', () => {
		// Large network that would otherwise give a deep d_max, but low confidence forces the clamp.
		const c = makeDMaxComputer({
			estimator: fixedEstimator(1_000_000, DEFAULT_CONFIDENCE_MIN - 0.05),
			F: 16,
		});
		expect(c.dMax()).to.equal(Math.floor(DEFAULT_D_MAX_CAP / 2));
	});

	it('does not clamp exactly at confidence_min', () => {
		const c = makeDMaxComputer({ estimator: fixedEstimator(100, DEFAULT_CONFIDENCE_MIN), F: 16 });
		expect(c.dMax()).to.equal(0); // computed, not clamped
	});

	it('honors custom confidenceMin and dMaxCap', () => {
		const c = makeDMaxComputer({
			estimator: fixedEstimator(1_000_000, 0.4),
			F: 16,
			confidenceMin: 0.5,
			dMaxCap: 10,
		});
		// confidence 0.4 < 0.5 → clamp to floor(10/2) = 5.
		expect(c.dMax()).to.equal(5);
	});

	it('caps a confident-but-huge estimate at d_max_cap', () => {
		const c = makeDMaxComputer({
			estimator: fixedEstimator(Number.MAX_SAFE_INTEGER, 0.9),
			F: 2,
			dMaxCap: 8,
		});
		expect(c.dMax()).to.equal(8);
	});

	it('reads the estimate lazily on each call', () => {
		let n = 100;
		const estimator: ISizeEstimator = { estimate: () => ({ nEst: n, confidence: 0.9 }) };
		const c = makeDMaxComputer({ estimator, F: 16 });
		expect(c.dMax()).to.equal(0);
		n = 100_000;
		expect(c.dMax()).to.equal(3);
	});

	it('rejects invalid fan-out', () => {
		expect(() => makeDMaxComputer({ estimator: fixedEstimator(100, 0.9), F: 1 })).to.throw(RangeError);
	});
});
