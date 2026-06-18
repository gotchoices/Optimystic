import { expect } from 'chai';
import {
	runChurnBoundaries,
	killRateAxis,
	measureKillRateFailover,
	partitionSeverityAxis,
	measurePartitionConvergence,
	createSimWorld,
	CohortMembership,
	TopicCohort,
	ParticipantRenewal,
	type EnvelopeBoundary,
	type ChurnBoundaryReport
} from '../src/index.js';

/**
 * The two cohort-topic *failure-mode* operating-envelope boundaries (`simulator-envelope-churn`):
 * `no-lost-registrations` vs member-kill rate and `heal-convergence` vs partition severity. Each
 * boundary must locate a finite edge with the expected sign of margin; each has a positive control (a
 * known-bad axis value fails the claim) so the boundary is not vacuously "stable"; the mechanism that
 * flipped the claim is recorded; and the whole report is deterministic across two runs. The
 * `heal-convergence` axis additionally guards against the structural-guarantee trap — it proves the
 * claim survives a *changed* healed membership and breaks only on a removed serving member.
 */

const SEED = 4242;
const TTL = 90_000;

function axisBoundary(report: ChurnBoundaryReport, axis: string): EnvelopeBoundary {
	const b = report.boundaries.find((x) => x.axis === axis);
	expect(b, `boundary for axis ${axis} present`).to.not.equal(undefined);
	return b!;
}

describe('envelope-churn — Boundary 1: no-lost-registrations vs member-kill rate', () => {
	let report: ChurnBoundaryReport;
	before(function () {
		this.timeout(60_000);
		report = runChurnBoundaries({ seed: SEED });
	});

	it('finds a finite kill-rate edge with positive margin against the zero-turnover design point', () => {
		const b = axisBoundary(report, 'killRatePerWindow');
		expect(b.claim).to.equal('no-lost-registrations');
		expect(b.boundaryFound, 'a finite edge exists within [0,1]').to.equal(true);
		expect(b.criticalValue, 'edge strictly inside (0,1)').to.be.greaterThan(0);
		expect(b.criticalValue).to.be.lessThan(1);
		expect(b.margin, 'design (kill rate 0) sits inside the envelope ⇒ positive margin').to.be.greaterThan(0);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.monotoneViolated, 'a sustained-kill priority order is monotone-in-harm').to.equal(false);
	});

	it('records which mechanism flipped the claim (race vs backup/coverage exhaustion)', () => {
		expect(report.killMechanism, 'a mechanism is recorded, not "none"').to.be.oneOf(['renewal-race', 'backup-exhaustion']);
	});

	it('positive control: zero turnover loses nothing; a heavy kill rate strands registrations', () => {
		const axis = killRateAxis({ seed: SEED });
		expect(axis.holds(0), 'no kills ⇒ no lost registrations').to.equal(true);
		expect(axis.holds(0.5), 'sustained heavy turnover outruns failover and strands registrations').to.equal(false);
		// Non-vacuity: the failover is genuinely engaged — registrations transiently go lost and recover
		// (the race) well before the edge, even while the snapshot claim still holds.
		const belowEdge = measureKillRateFailover(0.2, { seed: SEED });
		expect(belowEdge.holds, 'below the edge the cohort still covers every registration at the horizon').to.equal(true);
		expect(belowEdge.peakTransientLost, 'yet registrations went transiently lost mid-run — failover raced and won').to.be.greaterThan(0);
		const past = measureKillRateFailover(0.5, { seed: SEED });
		expect(past.lost, 'past the edge registrations remain lost').to.be.greaterThan(0);
		expect(past.mechanism).to.not.equal('none');
	});

	it('window arithmetic: the edge tracks the failover/exhaustion window accounting, not an off-by-one', () => {
		// memberCount 20, killWindows 4: the cohort retains coverage while floor(k·20)·4 < 20, and is
		// driven to full exhaustion once floor(k·20) ≥ 5 (k ≥ 0.25). The located edge must sit just below.
		const b = axisBoundary(report, 'killRatePerWindow');
		expect(b.criticalValue).to.be.greaterThan(0.2);
		expect(b.criticalValue).to.be.lessThan(0.25);
		const justInside = measureKillRateFailover(0.2, { seed: SEED });
		expect(justInside.reachableMembersAtHorizon, 'coverage remains just inside the edge').to.be.greaterThan(0);
		expect(justInside.holds).to.equal(true);
		const justPast = measureKillRateFailover(0.25, { seed: SEED });
		expect(justPast.reachableMembersAtHorizon, 'cohort exhausted just past the edge').to.equal(0);
		expect(justPast.holds).to.equal(false);
	});
});

describe('envelope-churn — Boundary 2: heal-convergence vs partition severity', () => {
	let report: ChurnBoundaryReport;
	before(function () {
		this.timeout(60_000);
		report = runChurnBoundaries({ seed: SEED });
	});

	it('finds a finite severity edge with positive margin against the no-churn / instant-heal design point', () => {
		const b = axisBoundary(report, 'partitionSeverity');
		expect(b.claim).to.equal('heal-convergence');
		expect(b.boundaryFound).to.equal(true);
		expect(b.criticalValue).to.be.greaterThan(0);
		expect(b.criticalValue).to.be.lessThan(1);
		expect(b.margin, 'design (severity 0) sits inside the envelope ⇒ positive margin').to.be.greaterThan(0);
		expect(b.designInsideEnvelope).to.equal(true);
		expect(b.monotoneViolated, 'more concurrent churn ⇒ weakly more non-convergence').to.equal(false);
	});

	it('records the converged fraction at the edge and proves it is all-participants-converge', () => {
		// The breaking partition leaves some participants un-converged (not a boolean-only readout), and
		// asymmetric per-side churn means convergence is partial, not 0 — the converged fraction is recorded.
		expect(report.convergedFractionAtEdge, 'the edge partition strands at least one participant').to.be.lessThan(1);
		expect(report.convergedFractionAtEdge, 'but converges most — partial, per-participant, not all-or-nothing').to.be.greaterThan(0);
	});

	it('defeats the structural-guarantee trap: convergence survives a CHANGED healed set, breaks only on a removed serving member', () => {
		// Below the edge the concurrent churn already changes the healed membership (epoch ≠ pre.epoch),
		// yet every participant still re-converges within one window via a lazy primary_moved — so the
		// claim is NOT held up by the trivial merge(a,b).epoch === pre.epoch path.
		const belowEdge = measurePartitionConvergence(0.25, { seed: SEED });
		expect(belowEdge.holds, 'still converges below the edge').to.equal(true);
		expect(belowEdge.healedEpochChanged, 'even though the healed membership genuinely changed').to.equal(true);
		expect(belowEdge.convergedFraction).to.equal(1);
		// The partition that breaks the claim also has a changed healed set — the edge is emergent, not structural.
		expect(report.healedEpochChangedAtEdge, 'the breaking partition healed into a changed membership').to.equal(true);
	});

	it('positive control: instant heal converges everyone; a severe partition leaves participants un-converged', () => {
		const axis = partitionSeverityAxis({ seed: SEED });
		expect(axis.holds(0), 'no concurrent churn ⇒ trivial convergence').to.equal(true);
		expect(axis.holds(0.7), 'heavy concurrent churn removes serving members ⇒ multi-window failover, misses the window').to.equal(false);
		const severe = measurePartitionConvergence(0.7, { seed: SEED });
		expect(severe.failoverForced, 'participants forced into multi-window backup promotion').to.be.greaterThan(0);
		expect(severe.convergedFraction).to.be.lessThan(1);
	});
});

describe('envelope-churn — determinism & window cadence', () => {
	it('is byte-identical across two runs from the same (seed, config)', function () {
		this.timeout(120_000);
		const a = runChurnBoundaries({ seed: SEED });
		const b = runChurnBoundaries({ seed: SEED });
		expect(a.boundaries).to.deep.equal(b.boundaries);
		expect(a.killMechanism).to.equal(b.killMechanism);
		expect(a.convergedFractionAtEdge).to.equal(b.convergedFractionAtEdge);
		expect(a.healedEpochChangedAtEdge).to.equal(b.healedEpochChangedAtEdge);
	});

	it('pins the renewal cadence both axes depend on: ping interval = ⌊ttl/3⌋ (one renewal window)', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const cohort = new TopicCohort({
			topicId: 't',
			coord: 'c',
			tier: 1,
			membership: new CohortMembership(['m0', 'm1', 'm2', 'm3'])
		});
		cohort.register('p', 0, TTL);
		const renewal = new ParticipantRenewal({ scheduler: world.scheduler, cohort, participantId: 'p', ttl: TTL });
		expect(renewal.pingInterval, 'the renewal window is ttl/3 — both boundaries account in these units').to.equal(Math.floor(TTL / 3));
	});

	it('both boundaries are folded into the metrics sink, keyed by (claim, axis)', () => {
		const report = runChurnBoundaries({ seed: SEED });
		const killTags = { claim: 'no-lost-registrations', axis: 'killRatePerWindow' };
		const healTags = { claim: 'heal-convergence', axis: 'partitionSeverity' };
		expect(report.metrics.histogramValues('boundary.criticalValue', killTags)).to.have.lengthOf(1);
		expect(report.metrics.counterValue('boundary.boundaryFound', killTags)).to.equal(1);
		expect(report.metrics.histogramValues('boundary.criticalValue', healTags)).to.have.lengthOf(1);
		expect(report.metrics.counterValue('boundary.boundaryFound', healTags)).to.equal(1);
	});
});
