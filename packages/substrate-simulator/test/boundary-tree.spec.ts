import { expect } from 'chai';
import {
	runTreeBoundaries,
	prefixSkewAxis,
	churnFlapAxis,
	unwillingFractionAxis,
	measureChurnFlap,
	measureUnwillingWalks,
	type EnvelopeBoundary,
	type TreeBoundaryReport
} from '../src/index.js';

/**
 * The three cohort-topic *tree* operating-envelope boundaries (`simulator-envelope-tree`). Each
 * boundary must locate a finite edge with the expected sign of margin; each has a positive control
 * (a known-bad axis value fails the claim) so the boundary is not vacuously "stable"; and the whole
 * report is deterministic across two runs. N is kept modest so a full tree is grown per evaluation
 * inside the suite's time budget.
 */

const N = 2000; // depth law = 2 at F=16, cap=64 — full-tree growth stays fast
const SEED = 1;

function axisBoundary(report: TreeBoundaryReport, axis: string): EnvelopeBoundary {
	const b = report.boundaries.find((x) => x.axis === axis);
	expect(b, `boundary for axis ${axis} present`).to.not.equal(undefined);
	return b!;
}

describe('envelope-tree — Boundary 1: depth-law vs prefix skew', () => {
	let report: TreeBoundaryReport;
	before(function () {
		this.timeout(120_000);
		report = runTreeBoundaries({ N, seed: SEED });
	});

	it('finds a finite skew edge with positive margin against the uniform-sharding design point (skew 0)', () => {
		const b = axisBoundary(report, 'prefixSkew');
		expect(b.claim).to.equal('depth-law');
		expect(b.boundaryFound, 'a finite edge exists within [0,1]').to.equal(true);
		expect(b.criticalValue, 'edge strictly inside (0,1)').to.be.greaterThan(0);
		expect(b.criticalValue).to.be.lessThan(1);
		expect(b.margin, 'design (skew 0) sits inside the envelope ⇒ positive margin').to.be.greaterThan(0);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.monotoneViolated, 'skew is monotone-in-harm (more concentration ⇒ deeper)').to.equal(false);
	});

	it('positive control: uniform (skew 0) matches the law; a known-bad skew deepens the tree past it', () => {
		const axis = prefixSkewAxis({ N, F: 16, capPromote: 64, seed: SEED });
		expect(axis.holds(0), 'uniform sharding tracks ⌈log_F(N/cap)⌉ exactly').to.equal(true);
		expect(axis.holds(0.5), 'heavy concentration deepens the tree past the law').to.equal(false);
	});
});

describe('envelope-tree — Boundary 2: promotion/demotion stability vs churn', () => {
	let report: TreeBoundaryReport;
	before(function () {
		this.timeout(120_000);
		report = runTreeBoundaries({ N, seed: SEED });
	});

	it('finds a finite churn-rate edge with positive margin against the settled-tree design point (churn 0)', () => {
		const b = axisBoundary(report, 'churnRate');
		expect(b.claim).to.equal('promotion-demotion-stable');
		expect(b.boundaryFound).to.equal(true);
		expect(b.criticalValue).to.be.greaterThan(0);
		expect(b.criticalValue).to.be.lessThan(1);
		expect(b.margin, 'a settled tree (churn 0) is inside the envelope — T_demote buys the margin').to.be.greaterThan(0);
		expect(b.monotoneViolated).to.equal(false);
	});

	it('positive control: zero churn is flat; high churn flaps AND exercises real demotions (non-vacuous)', () => {
		const axis = churnFlapAxis({ F: 16, capPromote: 64, seed: SEED, churnCycles: 6 });
		expect(axis.holds(0), 'no churn ⇒ no oscillation').to.equal(true);
		expect(axis.holds(0.8), 'high churn outruns the hysteresis ⇒ flapping').to.equal(false);
		// The "hysteresis sticky floor" caveat: demotion must be reachable, else oscillations is
		// structurally 0 and the boundary is vacuous.
		const hi = measureChurnFlap(0.8, { seed: SEED });
		expect(hi.oscillations, 'depth flaps under high churn').to.be.greaterThan(0);
		expect(hi.demotions, 'real demotions occurred — the cohort genuinely demoted, not a vacuous edge').to.be.greaterThan(0);
		expect(measureChurnFlap(0, { seed: SEED }).oscillations, 'settled tree, no flapping').to.equal(0);
	});
});

describe('envelope-tree — Boundary 3: walk no-give-ups / hop bound vs unwilling fraction', () => {
	let report: TreeBoundaryReport;
	before(function () {
		this.timeout(120_000);
		report = runTreeBoundaries({ N, seed: SEED });
	});

	it('finds a finite unwilling-fraction edge with positive margin against the all-willing design point (f 0)', () => {
		const b = axisBoundary(report, 'unwillingFraction');
		expect(b.claim).to.equal('no-give-ups');
		expect(b.boundaryFound).to.equal(true);
		expect(b.criticalValue).to.be.greaterThan(0);
		expect(b.criticalValue).to.be.lessThan(1);
		expect(b.margin, 'all-willing (f 0) is inside the envelope').to.be.greaterThan(0);
		expect(b.monotoneViolated).to.equal(false);
	});

	it('records which sub-condition flips first (give-up vs hop-bound breach)', () => {
		// Member retries each cost a hop, so the d_max+2 hop bound breaches before walks give up.
		expect(report.unwillingBreach).to.be.oneOf(['give-up', 'hop-bound', 'both']);
		expect(report.unwillingBreach, 'the conjunction is diagnosable, not "none"').to.not.equal('none');
	});

	it('positive control: all-willing succeeds within the hop bound; near-total unwillingness makes walks give up', () => {
		const axis = unwillingFractionAxis({ N, F: 16, capPromote: 64, seed: SEED, walkSamples: 100 });
		expect(axis.holds(0), 'no unwilling members ⇒ no give-ups, hops bounded').to.equal(true);
		const hostile = measureUnwillingWalks(1.0, { N, seed: SEED });
		expect(hostile.gaveUp, 'every member unwilling ⇒ walks exhaust back-off and give up').to.be.greaterThan(0);
		expect(hostile.maxHops, 'hop bound is blown past').to.be.greaterThan(hostile.bound);
	});
});

describe('envelope-tree — determinism & N-gating', () => {
	it('is byte-identical across two runs from the same (seed, config)', function () {
		this.timeout(180_000);
		const a = runTreeBoundaries({ N, seed: SEED });
		const b = runTreeBoundaries({ N, seed: SEED });
		expect(a.boundaries).to.deep.equal(b.boundaries);
		expect(a.unwillingBreach).to.equal(b.unwillingBreach);
		expect(a.skipped).to.deep.equal(b.skipped);
	});

	it('gates the two full-tree axes by N: a large-N run skips them and records the skip', function () {
		this.timeout(120_000);
		const gated = runTreeBoundaries({ N: 100_000, treeSampleMaxN: 10_000, seed: SEED });
		// Full-tree axes (prefix-skew, unwilling) are skipped; the single-cohort churn axis still runs.
		expect(gated.skipped).to.have.members(['prefixSkew', 'unwillingFraction']);
		expect(gated.boundaries.map((x) => x.axis)).to.deep.equal(['churnRate']);
		// The skip is recorded in the metrics sink (mirrors sweep's walkHopsSkipped), not silent.
		expect(gated.metrics.counterValue('boundary.skipped', { axis: 'prefixSkew' })).to.equal(1);
		expect(gated.metrics.counterValue('boundary.skipped', { axis: 'unwillingFraction' })).to.equal(1);
	});
});
