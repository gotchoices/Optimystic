import { expect } from 'chai';
import {
	decide,
	contentionFactor,
	expectedNewMatches,
	hangOutThreshold,
	filterAcceptRatio,
	newFilterAcceptRatioState,
	observeYield,
	DEFAULT_HANG_OUT_CONFIG,
	DEFAULT_MEAN_WANT_COUNT,
} from '../../src/matchmaking/index.js';
import type { SeekerDecisionInputs } from '../../src/matchmaking/index.js';

/** The §Worked example reply (`docs/matchmaking.md` L304-313): hot tier-1 cohort. */
const workedExample: SeekerDecisionInputs = {
	currentMatches: 6,
	directParticipants: 6,
	arrivalsPerMin: 90,
	queriesPerMin: 4,
	childCohortCount: 0,
	wantCount: 8,
	patienceMsRemaining: 10_000,
	filterAcceptRatio: 1.0,
	meanWantCount: DEFAULT_MEAN_WANT_COUNT,
};

describe('matchmaking / seeker decision engine', () => {
	describe('decision formulas (worked example, docs §Hang-out vs. continue)', () => {
		it('expectedNewMatches ≈ 15 for the worked example', () => {
			expect(expectedNewMatches(workedExample)).to.be.closeTo(15, 1e-9);
		});

		it('contentionFactor ≈ 1.13 for the worked example', () => {
			expect(contentionFactor(workedExample, DEFAULT_HANG_OUT_CONFIG)).to.be.closeTo(1.1333, 1e-3);
		});

		it('threshold ≈ 9.07; projected 21 ≥ threshold ⇒ hang out', () => {
			expect(hangOutThreshold(workedExample, DEFAULT_HANG_OUT_CONFIG)).to.be.closeTo(9.067, 1e-3);
			const d = decide(workedExample, DEFAULT_HANG_OUT_CONFIG);
			expect(d.action).to.equal('hangOut');
			if (d.action === 'hangOut') {
				expect(d.requeryIntervalMs).to.equal(DEFAULT_HANG_OUT_CONFIG.requeryIntervalMs);
			}
		});
	});

	it('immediate match (currentMatches ≥ wantCount) ⇒ done', () => {
		const d = decide({ ...workedExample, currentMatches: 8 }, DEFAULT_HANG_OUT_CONFIG);
		expect(d.action).to.equal('done');
	});

	it('thin shard ⇒ escalate (docs §Worked example contrast)', () => {
		// directParticipants: 1, arrivalsPerMin: 8 ⇒ expectedNewMatches ≈ 1.33, threshold far higher.
		const thin: SeekerDecisionInputs = { ...workedExample, currentMatches: 1, directParticipants: 1, arrivalsPerMin: 8 };
		expect(expectedNewMatches(thin)).to.be.closeTo(1.333, 1e-3);
		expect(decide(thin, DEFAULT_HANG_OUT_CONFIG).action).to.equal('escalate');
	});

	describe('edge cases (docs §Edge cases)', () => {
		it('case 5: a runaway queriesPerMin is clamped to contention_factor_cap (4.0)', () => {
			// arrivalsPerMin 10, queriesPerMin 100 ⇒ raw factor 1 + 300/10 = 31, clamped to 4.
			const contended: SeekerDecisionInputs = { ...workedExample, arrivalsPerMin: 10, queriesPerMin: 100 };
			expect(contentionFactor(contended, DEFAULT_HANG_OUT_CONFIG)).to.equal(4.0);
			// threshold 8 * 4 = 32, projected 6 + (10 * 1 * 1/6) ≈ 7.67 ⇒ escalate (root-ward), not pinned absurdly.
			expect(decide(contended, DEFAULT_HANG_OUT_CONFIG).action).to.equal('escalate');
		});

		it('case 4: a filterAcceptRatio decayed toward 0 collapses expectedNewMatches ⇒ escalate at every tier', () => {
			const pathological: SeekerDecisionInputs = { ...workedExample, filterAcceptRatio: 0.02 };
			expect(expectedNewMatches(pathological)).to.be.closeTo(90 * 0.02 * (10_000 / 60_000), 1e-9);
			expect(decide(pathological, DEFAULT_HANG_OUT_CONFIG).action).to.equal('escalate');
		});

		it('case 2: arrivalsPerMin = 0 with an immediate query already at wantCount ⇒ done (not a spurious escalate)', () => {
			const quiet: SeekerDecisionInputs = { ...workedExample, arrivalsPerMin: 0, currentMatches: 8 };
			expect(decide(quiet, DEFAULT_HANG_OUT_CONFIG).action).to.equal('done');
		});

		it('case 2: arrivalsPerMin = 0 and the query still short ⇒ escalate', () => {
			const empty: SeekerDecisionInputs = { ...workedExample, arrivalsPerMin: 0, currentMatches: 2 };
			expect(decide(empty, DEFAULT_HANG_OUT_CONFIG).action).to.equal('escalate');
		});
	});

	describe('filterAcceptRatio running refinement (docs §Edge cases 4)', () => {
		it('starts at the initial estimate before any observation', () => {
			expect(filterAcceptRatio(newFilterAcceptRatioState())).to.equal(1.0);
			expect(filterAcceptRatio(newFilterAcceptRatioState(), 0.5)).to.equal(0.5);
		});

		it('settles near 0.1 after two cohorts each return ~10% matchable', () => {
			let s = newFilterAcceptRatioState();
			s = observeYield(s, 1, 10); // cohort A: 1 of 10 matched
			s = observeYield(s, 1, 10); // cohort B: 1 of 10 matched
			expect(filterAcceptRatio(s)).to.be.closeTo(0.1, 1e-9);
		});

		it('converges to the cumulative matched/returned ratio', () => {
			let s = newFilterAcceptRatioState();
			s = observeYield(s, 5, 10);
			s = observeYield(s, 1, 10);
			expect(filterAcceptRatio(s)).to.be.closeTo(6 / 20, 1e-9);
		});
	});
});
