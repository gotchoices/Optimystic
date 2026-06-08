import { expect } from 'chai';
import {
	createRejoinJitter,
	DEFAULT_T_REJOIN_JITTER_MS,
	DEFAULT_REJOIN_CAP_PROMOTE,
	outwardMovesArePromoted,
	inwardStepsFollowNoState,
	retriesRestartAtDMax,
	stickyHolds,
	DEFAULT_T_PROMOTE_STICKY_MS,
	type WalkTrace,
} from '../../src/cohort-topic/antiflood/index.js';

describe('cohort-topic / anti-flood', () => {
	describe('rejoin jitter (claim 2: re-registration storm bound)', () => {
		it('exposes the simulator-confirmed defaults', () => {
			expect(DEFAULT_T_REJOIN_JITTER_MS).to.equal(30_000);
			expect(DEFAULT_REJOIN_CAP_PROMOTE).to.equal(64);
		});

		it('a single participant draws a jittered timestamp within the window', () => {
			// Deterministic RNG sweeping [0,1) so the offset spans the whole window.
			let r = 0;
			const jitter = createRejoinJitter({ random: () => r });
			for (const sample of [0, 0.25, 0.5, 0.999]) {
				r = sample;
				const now = 1_000_000;
				const at = jitter.scheduleRejoin(now);
				expect(at).to.be.at.least(now);
				expect(at).to.be.below(now + DEFAULT_T_REJOIN_JITTER_MS);
			}
		});

		it('bounds a registration storm to capacity: any window holds <= cap_promote arrivals', () => {
			// A 2,000-participant re-registration wave (a whole failed cohort rejoining at once).
			const jitter = createRejoinJitter({});
			const count = 2_000;
			const now = 0;
			const stamps = jitter.scheduleWave(count, now);
			expect(stamps).to.have.length(count);

			// Slide a window of T_rejoin_jitter across the wave; no window may exceed cap_promote.
			const window = DEFAULT_T_REJOIN_JITTER_MS;
			const cap = DEFAULT_REJOIN_CAP_PROMOTE;
			let worst = 0;
			let lo = 0;
			for (let hi = 0; hi < stamps.length; hi++) {
				while (stamps[hi]! - stamps[lo]! >= window) {
					lo++;
				}
				worst = Math.max(worst, hi - lo + 1);
			}
			// Unstaggered, all 2,000 would land in one instant (worst == 2000). Staggered, the peak
			// inbound over any window stays at the cap_promote / T_rejoin_jitter ceiling.
			expect(worst, 'peak arrivals per jitter window').to.be.at.most(cap);
		});

		it('widens the window under a higher observed FRET failure rate, holding the rate ceiling', () => {
			const jitter = createRejoinJitter({ failureRateScale: 3 });
			expect(jitter.windowMs).to.equal(DEFAULT_T_REJOIN_JITTER_MS * 3);
			const stamps = jitter.scheduleWave(600, 0);
			const span = stamps[stamps.length - 1]! - stamps[0]!;
			// 600 / cap_promote ≈ 9.4 windows of the widened window.
			expect(span).to.be.greaterThan(jitter.windowMs);
		});
	});

	describe('walk-trace invariants (claims 3, 4 and walk discipline)', () => {
		it('claim 3: accepts a trace whose only outward move follows a Promoted redirect', () => {
			// Walk inward d_max=4 → 3 → 2 on no_state, then a Promoted(3) outward redirect, then accepted.
			const trace: WalkTrace = {
				dMax: 4,
				probes: [
					{ treeTier: 4, result: 'no_state' },
					{ treeTier: 3, result: 'no_state' },
					{ treeTier: 2, result: 'promoted' },
					{ treeTier: 3, result: 'accepted' },
				],
			};
			expect(outwardMovesArePromoted(trace)).to.be.true;
			expect(inwardStepsFollowNoState(trace)).to.be.true;
		});

		it('claim 3: rejects a speculative outward probe not preceded by Promoted', () => {
			const trace: WalkTrace = {
				dMax: 4,
				probes: [
					{ treeTier: 4, result: 'no_state' },
					{ treeTier: 3, result: 'no_state' },
					// Speculative deeper guess: moved outward on a no_state, which the design forbids.
					{ treeTier: 5, result: 'no_state' },
				],
			};
			expect(outwardMovesArePromoted(trace)).to.be.false;
		});

		it('walk discipline: rejects an inward step taken on a non-no_state reply', () => {
			const trace: WalkTrace = {
				dMax: 3,
				probes: [
					{ treeTier: 3, result: 'unwilling_member' },
					// Inward move after unwilling_member — should have retried the same coord, not stepped in.
					{ treeTier: 2, result: 'no_state' },
				],
			};
			expect(inwardStepsFollowNoState(trace)).to.be.false;
		});

		it('claim 4: each retry walk restarts at d_max after an unwilling_cohort back-off', () => {
			const walks: WalkTrace[] = [
				{ dMax: 4, probes: [{ treeTier: 4, result: 'no_state' }, { treeTier: 3, result: 'unwilling_cohort' }] },
				// Back-off elapsed → fresh walk restarts at d_max (4), not at the declined coord (3).
				{ dMax: 4, probes: [{ treeTier: 4, result: 'no_state' }, { treeTier: 3, result: 'accepted' }] },
			];
			expect(retriesRestartAtDMax(walks)).to.be.true;
		});

		it('claim 4: rejects a retry that re-hits the declined coord instead of restarting at d_max', () => {
			const walks: WalkTrace[] = [
				{ dMax: 4, probes: [{ treeTier: 4, result: 'no_state' }, { treeTier: 3, result: 'unwilling_cohort' }] },
				// Bug: restarted at the declined coord (3), re-hammering it — the storm claim 4 forbids.
				{ dMax: 4, probes: [{ treeTier: 3, result: 'unwilling_cohort' }] },
			];
			expect(retriesRestartAtDMax(walks)).to.be.false;
		});
	});

	describe('sticky promotion window (claim 5)', () => {
		it('re-exports the canonical sticky window and reports the window boundary', () => {
			expect(DEFAULT_T_PROMOTE_STICKY_MS).to.equal(60_000);
			const promotedAt = 1_000;
			expect(stickyHolds(promotedAt, promotedAt + DEFAULT_T_PROMOTE_STICKY_MS - 1)).to.be.true;
			expect(stickyHolds(promotedAt, promotedAt + DEFAULT_T_PROMOTE_STICKY_MS)).to.be.false;
		});
	});
});
