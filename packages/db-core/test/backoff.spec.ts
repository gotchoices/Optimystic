import { expect } from 'chai';
import fc from 'fast-check';
import { jitteredBackoffMs, cryptoRand } from '../src/utility/backoff.js';

describe('jitteredBackoffMs', () => {
	const cfg = { baseMs: 100, capMs: 5000 };

	it('with rand()=0 returns the full (un-jittered) exponential value', () => {
		// delay = exp · (1 - 0.5·0) = exp
		expect(jitteredBackoffMs(0, cfg, () => 0)).to.equal(100);
		expect(jitteredBackoffMs(1, cfg, () => 0)).to.equal(200);
		expect(jitteredBackoffMs(2, cfg, () => 0)).to.equal(400);
		expect(jitteredBackoffMs(3, cfg, () => 0)).to.equal(800);
	});

	it('grows exponentially and is capped at capMs', () => {
		// 100·2^10 = 102400, clamped to 5000
		expect(jitteredBackoffMs(10, cfg, () => 0)).to.equal(5000);
		expect(jitteredBackoffMs(20, cfg, () => 0)).to.equal(5000);
	});

	it('with default jitterFraction 0.5, rand→1 yields half the exponential value', () => {
		// delay = exp · (1 - 0.5·rand); rand just under 1 → ~0.5·exp
		const near = jitteredBackoffMs(0, cfg, () => 0.999999);
		expect(near).to.be.greaterThan(50).and.to.be.lessThan(50.01);
		// The lower bound is exclusive (rand() ∈ [0,1) never reaches 1), but is bounded below by 0.5·exp.
		expect(near).to.be.greaterThan(0.5 * 100 - 0.001);
	});

	it('honours a custom jitterFraction', () => {
		// jitterFraction 0 → no jitter, always the exponential value
		expect(jitteredBackoffMs(2, { ...cfg, jitterFraction: 0 }, () => 0.5)).to.equal(400);
		// jitterFraction 1 → delay ∈ (0, exp]; rand=0.5 → 0.5·exp
		expect(jitteredBackoffMs(2, { ...cfg, jitterFraction: 1 }, () => 0.5)).to.equal(200);
	});

	it('honours a custom growth factor', () => {
		expect(jitteredBackoffMs(3, { baseMs: 10, capMs: 1_000_000, factor: 3 }, () => 0)).to.equal(270); // 10·3^3
	});

	it('rejects a negative or non-integer attempt', () => {
		expect(() => jitteredBackoffMs(-1, cfg, () => 0)).to.throw(RangeError);
		expect(() => jitteredBackoffMs(1.5, cfg, () => 0)).to.throw(RangeError);
	});

	it('property: every delay is in (0, capMs] for any attempt and any rand in [0,1)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 40 }),
				fc.double({ min: 0, max: 0.9999999, noNaN: true }),
				(attempt, r) => {
					const delay = jitteredBackoffMs(attempt, cfg, () => r);
					return delay > 0 && delay <= cfg.capMs;
				}
			)
		);
	});

	it('property: expected delay is non-decreasing in attempt (before the cap)', () => {
		// With rand fixed, delay(n) = min(base·2^n, cap)·(1-0.5·r) is monotonically non-decreasing in n.
		const r = 0.3;
		let prev = -1;
		for (let n = 0; n <= 6; n++) {
			const d = jitteredBackoffMs(n, cfg, () => r);
			expect(d, `attempt ${n} not >= attempt ${n - 1}`).to.be.at.least(prev);
			prev = d;
		}
	});

	it('thundering-herd: N clients drawing at the same attempt spread across (0.5·exp, exp]', () => {
		// A herd that lost the same race re-attempts at attempt=3 (exp = 100·2^3 = 800). With jitter the
		// re-attempts do NOT all land on the same tick — they scatter across (400, 800], shedding the
		// synchronized burst. Uses the real CSPRNG path (cryptoRand).
		const exp = 800;
		const samples = Array.from({ length: 200 }, () =>
			jitteredBackoffMs(3, { baseMs: 100, capMs: 100_000 }, cryptoRand)
		);
		for (const s of samples) {
			expect(s, 'never zero-delay, never below 0.5·exp').to.be.greaterThan(0.5 * exp);
			expect(s, 'never exceeds the exponential value').to.be.at.most(exp);
		}
		// The whole point of jitter: the draws are spread, not clustered on one value.
		const distinct = new Set(samples).size;
		expect(distinct, 'jitter should de-synchronize the herd (many distinct delays)').to.be.greaterThan(100);
	});
});

describe('cryptoRand', () => {
	it('returns values in [0, 1)', () => {
		for (let i = 0; i < 500; i++) {
			const r = cryptoRand();
			expect(r).to.be.at.least(0).and.to.be.lessThan(1);
		}
	});

	it('produces a spread of values (not a constant)', () => {
		const draws = Array.from({ length: 200 }, () => cryptoRand());
		expect(new Set(draws).size, 'CSPRNG should not repeat a single value').to.be.greaterThan(150);
	});
});
