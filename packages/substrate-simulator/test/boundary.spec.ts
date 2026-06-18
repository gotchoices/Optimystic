import { expect } from 'chai';
import { findBoundary, recordBoundary, type BoundaryAxisSpec } from '../src/boundary.js';
import { Metrics } from '../src/metrics.js';

/**
 * Harness-level proof of `findBoundary` against synthetic, pure step predicates — the edge logic is
 * validated independent of any subsystem driver. (The subsystem axes that plug real `holds`
 * evaluators in are exercised in `boundary-tree.spec.ts`.)
 */

/** A monotone increasing-harm step predicate: holds iff `value ≤ edge`. */
function stepAt(edge: number, over: Partial<BoundaryAxisSpec> = {}): BoundaryAxisSpec {
	return {
		claim: 'synthetic',
		axis: 'x',
		designAssumption: 8,
		lo: 0,
		hi: 100,
		integer: true,
		holds: (v) => v <= edge,
		...over
	};
}

describe('findBoundary — synthetic step predicate (increasing-harm)', () => {
	it('locates the exact edge: criticalValue is the last value that holds, not the first that fails', () => {
		const b = findBoundary(stepAt(10));
		expect(b.criticalValue, 'last passing value').to.equal(10);
		expect(b.boundaryFound).to.equal(true);
		expect(b.monotoneViolated).to.equal(false);
		// margin = criticalValue − designAssumption (10 − 8).
		expect(b.margin).to.equal(2);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.marginRatio).to.equal(10 / 8);
		// Geometric bracket + bisection ⇒ O(log range) evaluations, not a linear sweep of [0,100].
		expect(b.evaluations, `evaluations ${b.evaluations} stay logarithmic`).to.be.lessThan(25);
	});

	it('reports a negative margin when the claim already fails at the scan floor (design outside the envelope)', () => {
		const b = findBoundary(stepAt(-5)); // holds(0) is false → fails at lo
		expect(b.criticalValue, 'edge sits below lo').to.be.lessThan(b.scanLo);
		expect(b.margin, 'negative margin').to.be.lessThan(0);
		expect(b.designInsideEnvelope).to.equal(false);
		expect(b.boundaryFound).to.equal(true);
	});

	it('flags held-to-the-ceiling as a lower bound (boundaryFound=false, criticalValue=hi)', () => {
		const b = findBoundary(stepAt(1000)); // holds everywhere in [0,100]
		expect(b.boundaryFound, 'never flipped within the scanned range').to.equal(false);
		expect(b.criticalValue, 'criticalValue is the scan ceiling, a lower bound').to.equal(b.scanHi);
		expect(b.margin).to.equal(100 - 8);
	});

	it('detects a non-monotone predicate (a pass observed past an observed fail) and still returns the first-fail edge', () => {
		// A second "holds" island at [10,12] beyond the first fail at 4; the small linear-scanned range
		// guarantees every integer is probed so the island is seen.
		const spec = stepAt(3, {
			lo: 0,
			hi: 20,
			holds: (v) => v <= 3 || (v >= 10 && v <= 12)
		});
		const b = findBoundary(spec);
		expect(b.monotoneViolated, 'a later pass after a fail violates monotone-in-harm').to.equal(true);
		expect(b.criticalValue, 'still reports the first-fail edge (last pass before it)').to.equal(3);
		expect(b.boundaryFound).to.equal(true);
	});

	it('is deterministic — identical readout across two runs of the same spec', () => {
		const a = findBoundary(stepAt(37));
		const b = findBoundary(stepAt(37));
		expect(a).to.deep.equal(b);
	});
});

describe('findBoundary — resolution & termination', () => {
	it('integer axis bisects to adjacent integers without looping on a sub-integer tolerance', () => {
		const b = findBoundary(stepAt(42, { tolerance: 1e-9 }));
		expect(b.criticalValue).to.equal(42);
		expect(Number.isInteger(b.criticalValue)).to.equal(true);
	});

	it('real axis bisects to within tolerance', () => {
		const b = findBoundary({
			claim: 'synthetic',
			axis: 'r',
			designAssumption: 0,
			lo: 0,
			hi: 1,
			integer: false,
			tolerance: 1e-4,
			holds: (v) => v <= 0.5
		});
		expect(b.criticalValue, 'within tolerance of the true edge 0.5').to.be.closeTo(0.5, 1e-3);
		expect(b.marginRatio, 'designAssumption 0 ⇒ NaN ratio, never Infinity').to.be.NaN;
	});

	it('a tolerance ≥ the scanned range terminates immediately rather than looping', () => {
		const b = findBoundary({
			claim: 'synthetic',
			axis: 'r',
			designAssumption: 0,
			lo: 0,
			hi: 1,
			integer: false,
			tolerance: 2, // ≥ (hi − lo)
			holds: (v) => v <= 0.5
		});
		expect(b.boundaryFound).to.equal(true);
		expect(b.evaluations, 'no runaway bisection').to.be.lessThan(15);
	});

	it('rejects an inverted scan range (hi ≤ lo)', () => {
		expect(() => findBoundary(stepAt(10, { lo: 50, hi: 50 })), 'hi == lo').to.throw(RangeError);
		expect(() => findBoundary(stepAt(10, { lo: 50, hi: 10 })), 'hi < lo').to.throw(RangeError);
	});
});

describe('findBoundary — decreasing-harm (the rarely-used reflected branch)', () => {
	it('locates the low-value edge for a decreasing-harm axis (holds at large values, fails at small)', () => {
		const b = findBoundary({
			claim: 'synthetic',
			axis: 'big-is-safe',
			designAssumption: 0,
			lo: 0,
			hi: 100,
			integer: false,
			monotoneDirection: 'decreasing-harm',
			holds: (v) => v >= 30
		});
		expect(b.monotoneDirection).to.equal('decreasing-harm');
		expect(b.boundaryFound).to.equal(true);
		expect(b.criticalValue, 'smallest value that still holds').to.be.closeTo(30, 0.2);
	});
});

describe('recordBoundary — metrics fold', () => {
	it('folds the readout into counters/histograms/timeline keyed by (claim, axis)', () => {
		const metrics = new Metrics();
		const b = findBoundary(stepAt(10, { claim: 'root-not-overloaded', axis: 'arrivalsPerRound' }));
		recordBoundary(metrics, b);
		const tags = { claim: 'root-not-overloaded', axis: 'arrivalsPerRound' };
		expect(metrics.histogramValues('boundary.criticalValue', tags)).to.deep.equal([10]);
		expect(metrics.histogramValues('boundary.margin', tags)).to.deep.equal([2]);
		expect(metrics.counterValue('boundary.designInsideEnvelope', tags)).to.equal(1);
		expect(metrics.counterValue('boundary.boundaryFound', tags)).to.equal(1);
		expect(metrics.counterValue('boundary.monotoneViolated', tags)).to.equal(0);
		expect(metrics.timelineOf('boundary.margin.root-not-overloaded.arrivalsPerRound')).to.have.lengthOf(1);
		// The whole readout serializes for offline analysis.
		expect(metrics.exportJson()).to.contain('boundary.criticalValue');
	});
});
