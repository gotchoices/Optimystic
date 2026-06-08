import { expect } from 'chai';
import type { TopicTrafficV1 } from '../src/topic-events.js';
import {
	type SimProvider,
	type CapabilityFilter,
	DEFAULT_MATCHMAKING_CONFIG,
	matchesFilter,
	countMatchable,
	expectedNewMatches,
	contentionFactor,
	decideHangOut,
	FilterAcceptEstimator
} from '../src/matchmaking.js';

/** Build a `topicTraffic` snapshot for the decision tests. */
function traffic(arrivalsPerMin: number, queriesPerMin: number, directParticipants: number, childCohortCount = 0): TopicTrafficV1 {
	return { windowSeconds: 60, arrivalsPerMin, queriesPerMin, directParticipants, childCohortCount };
}

function provider(id: string, capabilities: string[], capacityBudget = 1): SimProvider {
	return { id, capabilities, capacityBudget, attachedAt: 0 };
}

describe('matchmaking decision engine — docs/matchmaking.md worked example', () => {
	it('reproduces expectedNewMatches = 15, contentionFactor ≈ 1.13, decision = hang out', () => {
		// 6 providers, arrivalsPerMin=90, queriesPerMin=4, wantCount=8, meanWantCount=3, patienceMs=10s.
		const newMatches = expectedNewMatches(90, 1.0, 10_000);
		expect(newMatches, 'expectedNewMatches').to.be.closeTo(15, 1e-6);

		const contention = contentionFactor(90, 4, 3, 4.0);
		expect(contention, 'contentionFactor').to.be.closeTo(1.1333, 1e-3);

		const threshold = 8 * contention;
		expect(threshold, 'threshold = wantCount × contentionFactor').to.be.closeTo(9.07, 0.05);

		const decision = decideHangOut(
			traffic(90, 4, 6),
			6, // currentMatches
			{ wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 }
		);
		expect(decision.action, 'have 6 + 15 = 21 ≥ 9.05 → hang out').to.equal('hang-out');
		expect(decision.expectedNewMatches).to.be.closeTo(15, 1e-6);
		expect(decision.contentionFactor).to.be.closeTo(1.1333, 1e-3);
		expect(decision.threshold).to.be.closeTo(9.07, 0.05);
	});

	it('matches immediately when currentMatches already ≥ wantCount', () => {
		const decision = decideHangOut(traffic(90, 4, 8), 8, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 });
		expect(decision.action).to.equal('matched');
		expect(decision.reason).to.equal('matched');
	});
});

describe('matchmaking decision engine — edge cases (matchmaking.md §Edge cases)', () => {
	it('missing topicTraffic → conservative escalate, but the immediate-match check still fires', () => {
		// Absent signal, below wantCount: no estimation against absent inputs → escalate.
		const escalate = decideHangOut(undefined, 2, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 });
		expect(escalate.action).to.equal('escalate');
		expect(escalate.reason).to.equal('no-traffic');
		// Absent signal but the cohort already holds enough → still resolves (query first).
		const matched = decideHangOut(undefined, 8, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 });
		expect(matched.action).to.equal('matched');
	});

	it('a single stale arrivalsPerMin = 0 reading does not over-react: query first, escalate only if still short', () => {
		// Zero arrivals but the cohort was simply quiet and already holds wantCount → matched.
		const quiet = decideHangOut(traffic(0, 0, 8), 8, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 });
		expect(quiet.action, 'quiet-not-empty: query met wantCount').to.equal('matched');
		// Zero arrivals and genuinely short → escalate on the reading.
		const short = decideHangOut(traffic(0, 0, 2), 2, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 });
		expect(short.action).to.equal('escalate');
		expect(short.reason).to.equal('below-threshold');
		expect(short.expectedNewMatches, 'zero arrivals → zero expected').to.equal(0);
	});

	it('pathological filter (filterAcceptRatio → 0) collapses expectedNewMatches and forces escalate', () => {
		// Even with a hot arrival rate, a near-zero accept ratio makes hang-out infeasible.
		const decision = decideHangOut(traffic(600, 4, 4), 4, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 0.0 });
		expect(decision.action).to.equal('escalate');
		expect(decision.expectedNewMatches).to.equal(0);
	});
});

describe('matchmaking decision engine — contention_factor_cap (matchmaking.md §Configuration)', () => {
	it('clamps a pathological queriesPerMin / arrivalsPerMin ratio to the cap of 4.0', () => {
		const cap = DEFAULT_MATCHMAKING_CONFIG.contentionFactorCap;
		// Runaway query rate vs. trickle of arrivals would push the raw multiplier far past 4.
		const raw = 1 + (10_000 * 3) / Math.max(1, 1);
		expect(raw, 'uncapped would explode').to.be.greaterThan(cap);
		expect(contentionFactor(1, 10_000, 3, cap)).to.equal(cap);
	});

	it('100 competing seekers stay fair: the capped factor keeps the threshold bounded (no escalation storm)', () => {
		const cap = DEFAULT_MATCHMAKING_CONFIG.contentionFactorCap;
		// A hot topic: arrivalsPerMin=600, and 100 seekers drive queriesPerMin high.
		const queriesPerMin = 1200;
		const contention = contentionFactor(600, queriesPerMin, 3, cap);
		expect(contention, 'capped at 4.0 — a runaway query rate cannot pin every seeker to the root').to.equal(cap);
		// With the cap, a hot topic still satisfies the hang-out threshold, so seekers stay put.
		const decision = decideHangOut(traffic(600, queriesPerMin, 4), 4, { wantCount: 8, patienceMs: 10_000, filterAcceptRatio: 1.0 });
		expect(decision.action, 'hot topic + capped contention → hang out, not escalate').to.equal('hang-out');
	});
});

describe('matchmaking — capability filter + FilterAcceptEstimator', () => {
	it('matchesFilter honors must / mustNot / minBudget', () => {
		const p = provider('a', ['pdf', 'gpu'], 4);
		expect(matchesFilter(p, { must: ['pdf'] })).to.equal(true);
		expect(matchesFilter(p, { must: ['pdf', 'tpu'] })).to.equal(false);
		expect(matchesFilter(p, { mustNot: ['gpu'] })).to.equal(false);
		expect(matchesFilter(p, { minBudget: 8 })).to.equal(false);
		expect(matchesFilter(p, { minBudget: 4 })).to.equal(true);
		expect(matchesFilter(p, undefined)).to.equal(true);
	});

	it('countMatchable counts only providers passing the filter', () => {
		const filter: CapabilityFilter = { must: ['pdf'] };
		const pool = [provider('a', ['pdf']), provider('b', ['gpu']), provider('c', ['pdf', 'gpu'])];
		expect(countMatchable(pool, filter)).to.equal(2);
	});

	it('filterAcceptRatio decays toward the observed yield (≈ 0.1 after two cohorts at 10%)', () => {
		const est = new FilterAcceptEstimator(1.0);
		expect(est.ratio, 'starts at the initial estimate').to.equal(1.0);
		est.observe(1, 10);
		est.observe(1, 10);
		expect(est.ratio, 'settles near 0.1').to.be.closeTo(0.1, 1e-9);
	});

	it('an empty query (0 returned) leaves the estimate unchanged', () => {
		const est = new FilterAcceptEstimator(1.0);
		est.observe(0, 0);
		expect(est.ratio).to.equal(1.0);
	});
});
