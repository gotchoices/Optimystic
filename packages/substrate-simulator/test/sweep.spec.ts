import { expect } from 'chai';
import {
	runScaleSweep,
	runSensitivitySweep,
	samplesFor,
	type SensitivitySweepResult,
	type SweepParameter
} from '../src/sweep.js';

/** The observed series for one (parameter, metric) pair, in sweep order. */
function series(result: SensitivitySweepResult, parameter: SweepParameter, metric: string): number[] {
	return samplesFor(result, parameter, metric).map((s) => s.observed);
}

function isNonDecreasing(xs: readonly number[]): boolean {
	return xs.every((x, i) => i === 0 || x >= xs[i - 1]!);
}

function isNonIncreasing(xs: readonly number[]): boolean {
	return xs.every((x, i) => i === 0 || x <= xs[i - 1]!);
}

describe('scale sweep — depth law + logarithmic lookup', () => {
	it('confirms observed depth == ⌈log_F(N/cap)⌉ and bounded walk hops across N {100…1M}', function () {
		this.timeout(180_000);
		const { samples, metrics } = runScaleSweep();
		expect(samples.map((s) => s.N)).to.deep.equal([100, 1_000, 10_000, 100_000, 1_000_000]);
		for (const s of samples) {
			expect(s.depthMatches, `depth law at N=${s.N} (observed ${s.observedDepth}, expected ${s.expectedDepth})`).to.equal(true);
			if (s.walkMeasured) {
				expect(s.hopsBounded, `lookup bounded at N=${s.N} (max ${s.walkHopsMax} ≤ d_max+2 ${s.dMax + 2})`).to.equal(true);
			}
		}
		// N = 1M reaches the expected depth-4 steady state.
		expect(samples.find((s) => s.N === 1_000_000)!.observedDepth).to.equal(4);
		// Walk-hop measurement is gated to N ≤ 10k; larger N is measured for depth only.
		expect(samples.find((s) => s.N === 100_000)!.walkMeasured).to.equal(false);
		expect(samples.find((s) => s.N === 1_000_000)!.walkMeasured).to.equal(false);
		// Depth grows logarithmically: monotone non-decreasing, sublinear (each ×10 in N adds ≤ 1 tier).
		const depths = samples.map((s) => s.observedDepth);
		expect(isNonDecreasing(depths), `depths ${depths} non-decreasing`).to.equal(true);
		for (let i = 1; i < depths.length; i++) {
			expect(depths[i]! - depths[i - 1]!, 'sublinear depth growth').to.be.at.most(1);
		}
		// The metrics sink captured the per-N depth timeline for export.
		expect(metrics.timelineOf('scale.depthByN')).to.have.lengthOf(samples.length);
		expect(metrics.exportJson()).to.contain('scale.observedDepth');
	});
});

describe('sensitivity sweep — parameter effects (input to fold-simulator-findings-into-design-docs)', () => {
	let result: SensitivitySweepResult;

	before(function () {
		this.timeout(120_000);
		result = runSensitivitySweep();
	});

	it('larger cap_promote yields a shallower (non-deeper) tree', () => {
		const depths = series(result, 'cap_promote', 'observedDepth');
		expect(depths.length).to.equal(4);
		expect(isNonIncreasing(depths), `cap_promote depths ${depths}`).to.equal(true);
		expect(depths[0]! > depths[depths.length - 1]!, 'effect is real, not flat').to.equal(true);
	});

	it('larger fan-out F yields a shallower (non-deeper) tree', () => {
		const depths = series(result, 'F', 'observedDepth');
		expect(depths.length).to.equal(4);
		expect(isNonIncreasing(depths), `F depths ${depths}`).to.equal(true);
		expect(depths[0]! > depths[depths.length - 1]!, 'effect is real').to.equal(true);
	});

	it('deeper d_max_cap costs strictly more on a cold lookup', () => {
		const hops = series(result, 'd_max_cap', 'walkHopsMax');
		expect(hops).to.deep.equal([5, 6, 7, 8]); // d_max_cap + 2, monotone
	});

	it('larger replay window W covers strictly more recovery seconds', () => {
		const cov = series(result, 'W', 'replayCoverageSeconds');
		expect(isNonDecreasing(cov)).to.equal(true);
		expect(cov.every((x, i) => i === 0 || x > cov[i - 1]!), `W coverage ${cov} strictly increasing`).to.equal(true);
	});

	it('larger W_checkpoint covers strictly more recovery seconds', () => {
		const cov = series(result, 'W_checkpoint', 'checkpointCoverageSeconds');
		expect(cov.every((x, i) => i === 0 || x > cov[i - 1]!), `W_checkpoint coverage ${cov}`).to.equal(true);
	});

	it('higher contention_factor_cap raises the hang-out threshold monotonically', () => {
		const thresholds = series(result, 'contention_factor_cap', 'hangOutThreshold');
		expect(isNonDecreasing(thresholds), `thresholds ${thresholds}`).to.equal(true);
		expect(thresholds[0]! < thresholds[thresholds.length - 1]!, 'effect is real').to.equal(true);
	});

	it('exports a non-empty JSON/CSV sensitivity report', () => {
		const json = result.metrics.exportJson();
		expect(json).to.contain('sweep.cap_promote.observedDepth');
		const csv = result.metrics.exportCsv();
		expect(csv.split('\n').length).to.be.greaterThan(1);
		expect(result.samples.length).to.be.greaterThan(10);
	});
});
