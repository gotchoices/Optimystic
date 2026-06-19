import { expect } from 'chai';
import {
	runMatchmakingBoundaries,
	lyingFractionAxis,
	measureBoundedHarm,
	seekerContentionAxis,
	measureSeekerContention,
	contentionRatioAtCap,
	BOUNDED_HARM_DESIGN_FRACTION,
	DEFAULT_MATCHMAKING_CONFIG,
	type EnvelopeBoundary,
	type MatchmakingBoundaryReport
} from '../src/index.js';

/**
 * The two matchmaking operating-envelope boundaries (`simulator-envelope-matchmaking`): `bounded-harm`
 * vs the fraction of per-query-flip lying reporters, and `hang-out-fairness` vs the seeker:provider
 * contention ratio. Each boundary must locate a finite edge with the expected sign of margin; each has a
 * positive control (a known-bad axis value fails the claim) so the boundary is not vacuous; and the
 * whole report is deterministic across two runs. The bounded-harm boundary additionally defeats the
 * tautology trap: a *static* under-report still matches at the root across the whole range, so only the
 * per-query-flip (whose over-report the seeker cannot settle against) breaks the claim. The contention
 * boundary additionally pins the misfire-before-the-cap finding (the located ratio sits below the ratio
 * at which the exact contention saturates the cap — a negative margin warranting the exact-sum
 * refinement) and isolates the actual decision flip, not merely "the raw factor exceeded 4".
 */

const C = DEFAULT_MATCHMAKING_CONFIG;
const SEED = 90909;
const START_TIER = 8;

function axisBoundary(report: MatchmakingBoundaryReport, axis: string): EnvelopeBoundary {
	const b = report.boundaries.find((x) => x.axis === axis);
	expect(b, `boundary for axis ${axis} present`).to.not.equal(undefined);
	return b!;
}

describe('envelope-matchmaking — Boundary 1: bounded-harm vs lying-reporter fraction', () => {
	let report: MatchmakingBoundaryReport;
	before(function () {
		this.timeout(60_000);
		report = runMatchmakingBoundaries({ seed: SEED });
	});

	it('finds a finite lying-fraction edge with positive margin against the all-honest design point', () => {
		const b = axisBoundary(report, 'lyingFraction');
		expect(b.claim).to.equal('bounded-harm');
		expect(b.designAssumption, 'design assumption is the all-honest fraction').to.equal(BOUNDED_HARM_DESIGN_FRACTION);
		expect(b.boundaryFound, 'a finite edge exists within [0,1]').to.equal(true);
		// The flip's over-report first lands on the second path tier once two tiers lie, i.e. at the
		// fraction where round(f · pathLength) crosses 1 → 2 = 1.5 / startTier.
		expect(b.criticalValue, 'edge tracks the 1→2 lied-tier transition').to.be.closeTo(1.5 / START_TIER, 0.03);
		expect(b.margin, 'all-honest (f = 0) sits inside the envelope ⇒ positive margin').to.be.greaterThan(0);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.monotoneViolated, 'more flipping reporters ⇒ weakly worse outcome — monotone-in-harm').to.equal(false);
	});

	it('the harm that breaks the claim is a match failure (the flip drains the whole patience budget)', () => {
		// Past the edge the per-query-flip over-reports a provider-less tier; with patience_per_tier_fraction
		// = 1.0 the seeker commits its whole budget there and never matches — the fragility that motivates
		// matchmaking-per-tier-patience-splitting.
		expect(report.harmMechanismAtEdge, 'the flip breaks the claim via match failure').to.equal('match-failure');
		expect(report.lyingTierCountPastEdge, 'two lied-about tiers just past the edge (the second over-reports)').to.equal(2);
	});

	it('de-tautologizes: a static under-report stays bounded across the whole range; only the flip breaks it', () => {
		// The static lie is the near-tautological case: the seeker escalates through every under-reported
		// tier and still matches at the root, so the claim holds even at f = 1.
		expect(report.staticUnderReportHoldsAtCeiling, 'static under-report still matches at f = 1').to.equal(true);
		const staticAtCeiling = measureBoundedHarm(1, { seed: SEED }, 'static-under-report');
		expect(staticAtCeiling.holds, 'static under-report holds at the ceiling').to.equal(true);
		expect(staticAtCeiling.liedMatched, 'and the seeker still matches').to.equal(true);
		expect(staticAtCeiling.harmMechanism).to.equal('within-bounds');
		// The very same fraction under the per-query-flip fails — the flip is what gives the adversary teeth.
		const flipAtCeiling = measureBoundedHarm(1, { seed: SEED }, 'per-query-flip');
		expect(flipAtCeiling.holds, 'the per-query-flip breaks the claim at the same fraction').to.equal(false);
		expect(flipAtCeiling.liedMatched).to.equal(false);
	});

	it('positive control: all-honest holds; a heavy flipping fraction fails', () => {
		const axis = lyingFractionAxis({ seed: SEED });
		expect(axis.holds(0), 'no lying reporters ⇒ bounded harm trivially holds').to.equal(true);
		expect(axis.holds(1), 'every path reporter flipping ⇒ the seeker fails to match').to.equal(false);
		// At a single lied-about tier the (under-reporting) flip is still bounded — the seeker matches at the root.
		const oneTier = measureBoundedHarm(1 / START_TIER, { seed: SEED }, 'per-query-flip');
		expect(oneTier.lyingTierCount, 'one lied-about tier at f = 1/pathLength').to.equal(1);
		expect(oneTier.holds, 'a single under-reporting flip still matches').to.equal(true);
	});

	it('is deterministic: two bounded-harm runs at the same (seed, fraction) agree', () => {
		const a = measureBoundedHarm(2 / START_TIER, { seed: SEED }, 'per-query-flip');
		const b = measureBoundedHarm(2 / START_TIER, { seed: SEED }, 'per-query-flip');
		expect(a).to.deep.equal(b);
	});
});

describe('envelope-matchmaking — Boundary 2: hang-out-fairness vs seeker-pool contention ratio', () => {
	let report: MatchmakingBoundaryReport;
	before(() => {
		report = runMatchmakingBoundaries({ seed: SEED });
	});

	it('finds a finite contention-ratio edge with the expected (negative) margin against the cap ratio', () => {
		const b = axisBoundary(report, 'seekerProviderRatio');
		expect(b.claim).to.equal('hang-out-fairness');
		// Design assumption: the ratio at which the exact contention 1 + ρ saturates the cap (cap − 1 = 3).
		expect(b.designAssumption, 'design assumption is the cap-saturation ratio').to.equal(C.contentionFactorCap - 1);
		expect(b.boundaryFound).to.equal(true);
		// The decision flips once the exact contention crosses the seeker's hang-out threshold — at ρ ≈ 2.5.
		expect(b.criticalValue, 'edge sits at the flip onset ρ ≈ 2.5').to.be.closeTo(2.5, 0.05);
		expect(b.margin, 'the misfire precedes the cap ⇒ negative margin ≈ −0.5').to.be.closeTo(-0.5, 0.06);
		expect(b.designInsideEnvelope, 'the cap-saturation point sits OUTSIDE the fair-decision envelope').to.equal(false);
		expect(b.monotoneViolated, 'a larger seeker pool ⇒ weakly larger exact contention — monotone-in-harm').to.equal(false);
	});

	it('the misfire precedes cap saturation — warranting the exact-sum refinement', () => {
		// ρ* < cap − 1: the capped approximation diverges from the exact Σ wantCount and misfires before
		// contention even reaches the design's assumed worst case. This is the principled "yes" for
		// matchmaking-contention-from-seeker-pool.
		expect(report.contentionFlipOnsetRatio, 'flip onset sits below the cap-saturation ratio')
			.to.be.lessThan(report.contentionRatioAtCap);
		expect(report.contentionRatioAtCap).to.equal(contentionRatioAtCap());
		expect(report.exactContentionAtEdge, 'exact contention at the edge is still below the cap')
			.to.be.lessThan(C.contentionFactorCap);
		expect(report.exactContentionAtEdge, 'and sits at the threshold-crossing value ≈ 3.5').to.be.closeTo(3.5, 0.05);
		expect(report.contentionRefinementWarranted, 'negative margin ⇒ refinement warranted').to.equal(true);
	});

	it('isolates the decision flip, not merely the raw factor exceeding the cap', () => {
		// Below the onset the two decisions agree even though the exact term is already growing; the
		// boundary is the flip, not "exact > cap".
		const below = measureSeekerContention(2);
		expect(below.wouldFlip, 'no flip below the onset').to.equal(false);
		expect(below.holds).to.equal(true);
		const above = measureSeekerContention(3.5);
		expect(above.wouldFlip, 'flip above the onset').to.equal(true);
		expect(above.approxHangOut, 'the capped approximation says hang out').to.equal(true);
		expect(above.exactHangOut, 'the exact Σ wantCount says escalate').to.equal(false);
	});

	it('positive control: no competing demand holds; a heavy ratio misfires', () => {
		const axis = seekerContentionAxis();
		expect(axis.holds(0), 'no competing seeker demand ⇒ decisions agree').to.equal(true);
		expect(axis.holds(3.5), 'a heavy seeker pool flips the capped-approximation decision').to.equal(false);
	});

	it('guards the arrivalsPerMin = 0 divide path', () => {
		// The exact term divides by max(arrivalsPerMin, 1); a silent provider pool must not throw.
		expect(() => measureSeekerContention(2, { arrivalsPerMin: 0 })).to.not.throw();
	});
});

describe('envelope-matchmaking — determinism & metrics folding', () => {
	it('is byte-identical across two runs from the same (seed, config)', function () {
		this.timeout(120_000);
		const a = runMatchmakingBoundaries({ seed: SEED });
		const b = runMatchmakingBoundaries({ seed: SEED });
		expect(a.boundaries).to.deep.equal(b.boundaries);
		expect(a.harmMechanismAtEdge).to.equal(b.harmMechanismAtEdge);
		expect(a.lyingTierCountPastEdge).to.equal(b.lyingTierCountPastEdge);
		expect(a.staticUnderReportHoldsAtCeiling).to.equal(b.staticUnderReportHoldsAtCeiling);
		expect(a.contentionFlipOnsetRatio).to.equal(b.contentionFlipOnsetRatio);
		expect(a.exactContentionAtEdge).to.equal(b.exactContentionAtEdge);
		expect(a.contentionRefinementWarranted).to.equal(b.contentionRefinementWarranted);
	});

	it('both boundaries are folded into the metrics sink, keyed by (claim, axis)', () => {
		const report = runMatchmakingBoundaries({ seed: SEED });
		const harmTags = { claim: 'bounded-harm', axis: 'lyingFraction' };
		const contentionTags = { claim: 'hang-out-fairness', axis: 'seekerProviderRatio' };
		expect(report.metrics.histogramValues('boundary.criticalValue', harmTags)).to.have.lengthOf(1);
		expect(report.metrics.counterValue('boundary.boundaryFound', harmTags)).to.equal(1);
		expect(report.metrics.histogramValues('boundary.criticalValue', contentionTags)).to.have.lengthOf(1);
		expect(report.metrics.counterValue('boundary.boundaryFound', contentionTags)).to.equal(1);
	});
});
