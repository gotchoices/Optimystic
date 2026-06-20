import { expect } from 'chai';
import {
	runScenario,
	allClaimsPass,
	ColdStartStormScenario,
	ChurnRecoveryScenario,
	TailRotationScenario,
	VotingQuorumScenario,
	AdversarialReportingScenario,
	type ClaimReport
} from '../src/scenarios.js';

/** Assert every claim in a report passed, with a readable failure message naming the offenders. */
function expectAllPass(report: ClaimReport): void {
	const failed = report.claims.filter((c) => !c.pass);
	const detail = failed.map((c) => `${c.id}: expected ${c.expected}, observed ${c.observed}`).join('; ');
	expect(allClaimsPass(report), `${report.scenario} — failing claims: ${detail}`).to.equal(true);
}

describe('Scenario — cold-start storm (cohort-topic §Anti-flood)', () => {
	// Two regimes are pinned so the cumulative-tier-0-acceptance behavior stays visible rather than
	// silently passing the loosened `cap_promote + one round of arrivals` bound (the storm-rate case
	// would otherwise pass that bound by a wide margin and hide the real ~2× overshoot).

	// Moderate-rate regime (== the runAllScenarios() default): cumulative tier-0 acceptance stays ≤ cap.
	it('moderate rate: a burst fans, stays within cap_promote at the root, promotes, and looks up in O(log N)', function () {
		this.timeout(30_000);
		const { report, metrics } = runScenario((m) => new ColdStartStormScenario(m, { subscribers: 3_000, burstWindowMs: 5_000 }));
		expectAllPass(report);
		expect(report.claims.find((c) => c.id === 'walks-fan')!.observed).to.equal('3000');
		// Pinned: at the moderate rate the cumulative tier-0 acceptance stays within cap_promote (64).
		expect(metrics.counterValue('coldstart.acceptedTier0'), 'moderate rate stays ≤ cap_promote').to.be.at.most(64);
	});

	// Storm-rate regime (opt-in): ~2,000/s drives the documented gossip-lag overshoot past cap_promote,
	// bounded by one round of arrivals. The root-not-overloaded claim still holds under the cumulative
	// `cap + one round` bound, and the overshoot stays an explicit, visible fact.
	it('storm rate: cumulative tier-0 acceptance overshoots cap by ≤ one round of arrivals, claim still holds', function () {
		this.timeout(60_000);
		const { report, metrics } = runScenario((m) => new ColdStartStormScenario(m, { subscribers: 10_000, burstWindowMs: 5_000 }));
		expectAllPass(report);
		expect(report.claims.find((c) => c.id === 'walks-fan')!.observed).to.equal('10000');
		const accepted = metrics.counterValue('coldstart.acceptedTier0');
		// The overshoot is real — the storm cumulatively accepts *more* than cap_promote at tier 0.
		expect(accepted, 'storm overshoots cap_promote').to.be.greaterThan(64);
		// ...but bounded by one gossip-round of arrivals: cap_promote + ⌈10000·1000/5000⌉ = 64 + 2000.
		expect(accepted, 'overshoot within one round of arrivals').to.be.at.most(64 + 2_000);
	});
});

describe('Scenario — churn recovery (cohort-topic §Failure modes / §Partition heal)', () => {
	it('a 20% member turnover fails over with no lost registrations and heals to convergence', function () {
		this.timeout(30_000);
		const { report } = runScenario((m) => new ChurnRecoveryScenario(m, { members: 16, participants: 64, turnoverPct: 0.2 }));
		expectAllPass(report);
		expect(report.claims.find((c) => c.id === 'no-lost-registrations')!.observed).to.equal('0');
	});
});

describe('Scenario — tail rotation under load (reactivity §Tail rotation)', () => {
	it('the re-registration wave stays within cap_promote_fast, drains in time, and revisions stay contiguous', function () {
		this.timeout(30_000);
		const { report } = runScenario((m) => new TailRotationScenario(m, { subscribers: 2_000, revisions: 1_000 }));
		expectAllPass(report);
	});
});

describe('Scenario — voting-quorum assembly on a hot proposal (cohort-topic §Worked scenarios)', () => {
	it('the flash herd is absorbed at the depth law with the root never overloaded', function () {
		this.timeout(30_000);
		const { report, metrics } = runScenario((m) => new VotingQuorumScenario(m, { voters: 5_000 }));
		expectAllPass(report);
		// Depth law for 5000 voters at F=16, cap=64 is ⌈log_16(5000/64)⌉ = 2.
		expect(metrics.counterValue('voting.steadyStateDepth')).to.equal(2);
	});
});

describe('Scenario — adversarial traffic reporting (matchmaking §Adversarial traffic reporting)', () => {
	it('under-reporting costs ≤ one extra hop per tier and over-reporting wastes ≤ patienceMs', function () {
		this.timeout(30_000);
		const { report } = runScenario((m) => new AdversarialReportingScenario(m, { patienceMs: 10_000, wantCount: 8 }));
		expectAllPass(report);
	});
});

describe('Scenario — claim report shape', () => {
	it('every scenario emits a named report with at least one claim', () => {
		const reports = [
			runScenario((m) => new ColdStartStormScenario(m, { subscribers: 200 })).report,
			runScenario((m) => new ChurnRecoveryScenario(m, { participants: 16 })).report,
			runScenario((m) => new TailRotationScenario(m, { subscribers: 200, revisions: 300 })).report,
			runScenario((m) => new VotingQuorumScenario(m, { voters: 500 })).report,
			runScenario((m) => new AdversarialReportingScenario(m)).report
		];
		for (const r of reports) {
			expect(r.scenario, 'scenario named').to.be.a('string').and.not.equal('');
			expect(r.claims.length, `${r.scenario} has claims`).to.be.greaterThan(0);
			for (const c of r.claims) {
				expect(c.id).to.be.a('string');
				expect(c.expected).to.be.a('string');
				expect(c.observed).to.be.a('string');
				expect(c.pass).to.be.a('boolean');
			}
		}
	});
});
