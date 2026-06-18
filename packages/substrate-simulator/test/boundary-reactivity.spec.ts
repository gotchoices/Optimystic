import { expect } from 'chai';
import {
	runReactivityBoundaries,
	revisionContinuityAxis,
	measureContinuityCoverage,
	replayOnlyEdgeCps,
	tailDrainAxis,
	measureRotationDrain,
	NOMINAL_CPS,
	RECONNECT_GAP_SEC,
	SHIPPED_REJOIN_DRAIN_RATIO,
	DEFAULT_REACTIVITY_CONFIG,
	type EnvelopeBoundary,
	type ReactivityBoundaryReport
} from '../src/index.js';

/**
 * The two reactivity (live-update) operating-envelope boundaries (`simulator-envelope-reactivity`):
 * `revision-continuity` vs commit rate `cps` and `completes-within-drain` vs the
 * `T_rejoin_jitter / T_drain` ratio. Each boundary must locate a finite edge with the expected sign of
 * margin; each has a positive control (a known-bad axis value fails the claim) so the boundary is not
 * vacuous; and the whole report is deterministic across two runs. The continuity boundary additionally
 * pins the layered-vs-replay-only bound distinction (the design sits outside the conservative
 * replay-only envelope but inside the authoritative layered one — the adaptive-`W` finding), and the
 * drain boundary additionally defeats the tautology trap: the shipped ratio cannot fail, so a ratio
 * past 1 must flip the claim, and the wave must drain *via promotion fan-out*, not a trivially-short
 * window.
 */

const C = DEFAULT_REACTIVITY_CONFIG;
const SEED = 1;

function axisBoundary(report: ReactivityBoundaryReport, axis: string): EnvelopeBoundary {
	const b = report.boundaries.find((x) => x.axis === axis);
	expect(b, `boundary for axis ${axis} present`).to.not.equal(undefined);
	return b!;
}

describe('envelope-reactivity — Boundary 1: revision-continuity vs commit rate cps', () => {
	let report: ReactivityBoundaryReport;
	before(() => {
		report = runReactivityBoundaries({ seed: SEED });
	});

	it('finds a finite cps edge with positive margin against the nominal commit rate', () => {
		const b = axisBoundary(report, 'commitRateCps');
		expect(b.claim).to.equal('revision-continuity');
		expect(b.designAssumption, 'design assumption is the nominal commit rate').to.equal(NOMINAL_CPS);
		expect(b.boundaryFound, 'a finite edge exists within the scanned range').to.equal(true);
		// Layered edge ≈ (W + W_checkpoint) / gap = 4352 / 60 ≈ 72.5 cps.
		const layeredEdge = (C.W + C.Wcheckpoint) / RECONNECT_GAP_SEC;
		expect(b.criticalValue, 'edge tracks the layered (W + W_checkpoint) coverage').to.be.closeTo(layeredEdge, 0.2);
		expect(b.margin, 'design (10 cps) sits inside the layered envelope ⇒ positive margin').to.be.greaterThan(0);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.monotoneViolated, 'more commits ⇒ weakly shorter coverage — monotone-in-harm').to.equal(false);
	});

	it('uses the layered bound, not the replay-only bound: nominal is outside the conservative edge but inside the layered one', () => {
		const b = axisBoundary(report, 'commitRateCps');
		// The conservative replay-only edge (W / gap ≈ 4.27 cps) sits BELOW nominal (10 cps), which sits
		// below the layered edge (≈ 72.5 cps). This is exactly the adaptive-W finding: at 10 cps the
		// replay-only window already fails the 60 s floor, but the stacked W + W_checkpoint covers it.
		expect(report.replayOnlyEdgeCps, 'replay-only edge = W / gap').to.be.closeTo(C.W / RECONNECT_GAP_SEC, 1e-6);
		expect(report.replayOnlyEdgeCps, 'the conservative edge sits below nominal').to.be.lessThan(NOMINAL_CPS);
		expect(NOMINAL_CPS, 'nominal sits below the layered edge').to.be.lessThan(b.criticalValue);
		// At the located edge the layered window covers ≈ the reconnect gap (that is what defines the edge),
		// while the replay-only window covers far less.
		expect(report.layeredCoverageAtEdge, 'layered coverage at the edge ≈ the reconnect gap').to.be.closeTo(RECONNECT_GAP_SEC, 1);
		expect(report.replayCoverageAtEdge, 'replay-only coverage at the edge is far below the gap').to.be.lessThan(RECONNECT_GAP_SEC / 10);
		// Just past the layered edge the resume falls out of the stacked window entirely.
		expect(report.continuityKindPastEdge, 'past the layered edge ⇒ OutOfWindow').to.equal('OutOfWindow');
	});

	it('positive control: nominal rate stays in-window; a hot rate drops out of the layered window', () => {
		const axis = revisionContinuityAxis();
		expect(axis.holds(NOMINAL_CPS), 'nominal commit rate is recoverable in one round trip').to.equal(true);
		expect(axis.holds(1000), 'a very hot collection outruns the layered window').to.equal(false);
		// At nominal the resume is in-window (CheckpointWindow) yet the replay-only buffer already fails
		// the gap — the layered bound is doing the covering, which is the whole point of Boundary 1.
		const atNominal = measureContinuityCoverage(NOMINAL_CPS);
		expect(atNominal.holds, 'in-window at nominal').to.equal(true);
		expect(atNominal.resumeKind, 'covered by the parent checkpoint, not the ring').to.equal('CheckpointWindow');
		expect(atNominal.replayCoverageSeconds, 'replay-only window already below the 60 s gap at nominal').to.be.lessThan(RECONNECT_GAP_SEC);
		expect(atNominal.layeredCoverageSeconds, 'but the layered window covers the gap with room to spare').to.be.greaterThan(RECONNECT_GAP_SEC);
		// Well past the layered edge ⇒ a genuine continuity gap (chain read required).
		const hot = measureContinuityCoverage(100);
		expect(hot.holds, 'a 100 cps collection cannot cover a 60 s gap in the layered window').to.equal(false);
		expect(hot.resumeKind).to.equal('OutOfWindow');
	});

	it('rejects a non-positive cps (the silent-topic axis floor guard)', () => {
		expect(() => measureContinuityCoverage(0)).to.throw(RangeError);
		// And the axis floor itself is held strictly above 0 so the scan never probes a silent topic.
		expect(revisionContinuityAxis().lo, 'scan floor is above zero').to.be.greaterThan(0);
	});
});

describe('envelope-reactivity — Boundary 2: completes-within-drain vs rejoin/drain ratio', () => {
	let report: ReactivityBoundaryReport;
	before(function () {
		this.timeout(60_000);
		report = runReactivityBoundaries({ seed: SEED });
	});

	it('finds a finite ratio edge with positive margin against the shipped ratio', () => {
		const b = axisBoundary(report, 'rejoinDrainRatio');
		expect(b.claim).to.equal('completes-within-drain');
		expect(b.designAssumption, 'design assumption is the shipped ratio (30 s / 60 s)').to.equal(SHIPPED_REJOIN_DRAIN_RATIO);
		expect(b.boundaryFound).to.equal(true);
		// The wave drains while the rejoin spread fits the drain window, and first fails just past ratio 1.
		expect(b.criticalValue, 'edge sits just above ratio 1').to.be.within(0.9, 1.1);
		expect(b.margin, 'shipped ratio (0.5) sits inside the envelope ⇒ positive margin ≈ 0.5').to.be.within(0.4, 0.6);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.monotoneViolated, 'a wider rejoin spread ⇒ weakly later last arrival — monotone-in-harm').to.equal(false);
	});

	it('defeats the tautology trap: the shipped ratio cannot fail, but a ratio past 1 flips the claim', () => {
		const axis = tailDrainAxis({ seed: SEED });
		// Positive control both ways: the shipped ratio always drains; a ratio past 1 outlasts forwarding.
		expect(axis.holds(SHIPPED_REJOIN_DRAIN_RATIO), 'shipped ratio (0.5) drains well inside T_drain').to.equal(true);
		expect(axis.holds(2.0), 'a rejoin spread twice the drain window cannot finish in time').to.equal(false);
		const past = measureRotationDrain(2.0, { seed: SEED });
		expect(past.holds, 'past ratio 1 the wave fails to drain').to.equal(false);
		expect(past.lastArrivalAt, 'the last re-registration lands after the old tail stops forwarding').to.be.greaterThan(C.tDrainMs);
		// The diagnostic just past the located edge confirms the same.
		expect(report.lastArrivalPastDrainEdge, 'just past the edge the wave outlasts T_drain').to.be.greaterThan(C.tDrainMs);
	});

	it('drains via promotion fan-out, not a trivially-short window (non-vacuity witness)', () => {
		// At the shipped ratio the new root fast-promotes at cap_promote_fast and the tree spreads off the
		// root — the wave drains because the fast-promote mechanism absorbed it, not because the arrival
		// window was trivially short. This is the heal-convergence structural-trap analogue.
		expect(report.drainViaFanoutAtDesign, 'the design-ratio burst drained via fast-promote fan-out').to.equal(true);
		const design = measureRotationDrain(SHIPPED_REJOIN_DRAIN_RATIO, { seed: SEED });
		expect(design.holds, 'the shipped burst drains').to.equal(true);
		expect(design.peakRootDirect, 'root filled to cap_promote_fast then promoted').to.equal(C.capPromoteFast);
		expect(design.finalDepth, 'the tree spread past the root').to.be.greaterThan(0);
		expect(design.lastArrivalAt, 'last arrival well inside T_drain at the shipped ratio').to.be.at.most(C.tRejoinJitterMs);
	});

	it('threads the seed: two bursts at the same (seed, ratio) give identical drain outcomes', () => {
		const a = measureRotationDrain(0.8, { seed: SEED });
		const b = measureRotationDrain(0.8, { seed: SEED });
		expect(a).to.deep.equal(b);
		// The seed genuinely drives the jitter wave: across several seeds the last-arrival time is not a
		// constant (so determinism above is reproducibility, not a seed-independent fixed answer).
		const arrivals = new Set([SEED, SEED + 1, SEED + 2].map((s) => measureRotationDrain(0.8, { seed: s }).lastArrivalAt));
		expect(arrivals.size, 'the burst depends on the seed').to.be.greaterThan(1);
	});
});

describe('envelope-reactivity — determinism & metrics folding', () => {
	it('is byte-identical across two runs from the same (seed, config)', function () {
		this.timeout(120_000);
		const a = runReactivityBoundaries({ seed: SEED });
		const b = runReactivityBoundaries({ seed: SEED });
		expect(a.boundaries).to.deep.equal(b.boundaries);
		expect(a.continuityKindPastEdge).to.equal(b.continuityKindPastEdge);
		expect(a.layeredCoverageAtEdge).to.equal(b.layeredCoverageAtEdge);
		expect(a.replayCoverageAtEdge).to.equal(b.replayCoverageAtEdge);
		expect(a.replayOnlyEdgeCps).to.equal(b.replayOnlyEdgeCps);
		expect(a.drainViaFanoutAtDesign).to.equal(b.drainViaFanoutAtDesign);
		expect(a.lastArrivalPastDrainEdge).to.equal(b.lastArrivalPastDrainEdge);
	});

	it('both boundaries are folded into the metrics sink, keyed by (claim, axis)', () => {
		const report = runReactivityBoundaries({ seed: SEED });
		const continuityTags = { claim: 'revision-continuity', axis: 'commitRateCps' };
		const drainTags = { claim: 'completes-within-drain', axis: 'rejoinDrainRatio' };
		expect(report.metrics.histogramValues('boundary.criticalValue', continuityTags)).to.have.lengthOf(1);
		expect(report.metrics.counterValue('boundary.boundaryFound', continuityTags)).to.equal(1);
		expect(report.metrics.histogramValues('boundary.criticalValue', drainTags)).to.have.lengthOf(1);
		expect(report.metrics.counterValue('boundary.boundaryFound', drainTags)).to.equal(1);
	});

	it('the replay-only continuity edge is below the nominal commit rate (adaptive-W warranted)', () => {
		expect(replayOnlyEdgeCps()).to.be.lessThan(NOMINAL_CPS);
	});
});
