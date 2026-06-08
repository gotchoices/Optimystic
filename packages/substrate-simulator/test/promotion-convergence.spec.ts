import { expect } from 'chai';
import {
	runConvergence,
	compareLookahead,
	expectedDepth,
	uniformLadder,
	PromotionTracer
} from '../src/promotion-convergence.js';
import { TopicTree, DEFAULT_LIFECYCLE_CONFIG } from '../src/topic-tree.js';
import { createSimWorld } from '../src/world.js';
import { bytesToHex } from '../src/hex.js';

const F = DEFAULT_LIFECYCLE_CONFIG.F; // 16
const CAP = DEFAULT_LIFECYCLE_CONFIG.capPromote; // 64

/** Independent oracle for the steady-state depth law (mirrors the in-source one). */
function lawDepth(N: number): number {
	return N <= CAP ? 0 : Math.max(0, Math.ceil(Math.log(N / CAP) / Math.log(F)));
}

describe('promotion-convergence — depth law', () => {
	it('steady-state depth == ⌈log_F(N/cap_promote)⌉ across the N sweep {10,100,1k,10k,100k}', function () {
		this.timeout(60000);
		for (const N of [10, 100, 1000, 10000, 100000]) {
			const expected = lawDepth(N);
			expect(expectedDepth(N, F, CAP), `oracle agrees for N=${N}`).to.equal(expected);
			const result = runConvergence({ N, lookahead: true });
			expect(result.expectedDepth, `expectedDepth N=${N}`).to.equal(expected);
			expect(result.steadyStateDepth, `observed depth N=${N}`).to.equal(expected);
		}
	});

	it('the law holds with lookahead disabled too (timing differs, depth does not)', function () {
		this.timeout(60000);
		for (const N of [100, 10000]) {
			const result = runConvergence({ N, lookahead: false });
			expect(result.steadyStateDepth, `observed depth N=${N}`).to.equal(lawDepth(N));
		}
	});
});

describe('promotion-convergence — bounded overshoot', () => {
	it('peak directParticipants past cap_promote stays within one gossip-round of arrivals (< R)', () => {
		const R = 10; // does not divide cap_promote (64) → a real, non-zero overshoot to bound
		const result = runConvergence({ N: 1000, lookahead: false, arrivalsPerRound: R });
		expect(result.steadyStateDepth).to.equal(lawDepth(1000));
		expect(result.peakOvershoot, 'overshoot is real (cap not a multiple of R)').to.be.greaterThan(0);
		expect(result.peakOvershoot, 'overshoot bounded by one round of arrivals').to.be.lessThan(R);
	});
});

describe('promotion-convergence — lookahead reduces overshoot', () => {
	it('slope-based pre-promotion yields strictly lower peak overshoot, same population', () => {
		const cmp = compareLookahead({ N: 1000, arrivalsPerRound: 10 });
		// Same population/parameters → identical steady-state depth; only the promotion timing moves.
		expect(cmp.withLookahead.steadyStateDepth).to.equal(cmp.withoutLookahead.steadyStateDepth);
		expect(cmp.withoutLookahead.peakOvershoot, 'lookahead-off overshoots').to.be.greaterThan(0);
		expect(cmp.withLookahead.peakOvershoot, 'lookahead-on strictly lower')
			.to.be.lessThan(cmp.withoutLookahead.peakOvershoot);
		expect(cmp.withLookahead.peakOvershoot, 'pre-promotion removes the overshoot entirely').to.equal(0);
	});
});

describe('promotion-convergence — hysteresis locks (no depth flapping)', () => {
	it('observed depth converges monotonically — zero oscillations through steady state', function () {
		this.timeout(60000);
		for (const N of [1000, 10000]) {
			const result = runConvergence({ N, lookahead: true });
			expect(result.oscillations, `no depth flapping for N=${N}`).to.equal(0);
			expect(result.convergenceLatency, `latency finite & non-negative N=${N}`).to.be.a('number');
			expect(result.convergenceLatency).to.be.at.least(0);
		}
	});
});

describe('promotion-convergence — tracer wiring', () => {
	it('subscribes to the Promoted/Demoted stream and samples the depth timeline', () => {
		const world = createSimWorld({ seed: 1, gossipRoundMs: 1000 });
		let tracer: PromotionTracer;
		const tree = new TopicTree({
			scheduler: world.scheduler,
			gossipRoundMs: 1000,
			sink: { record: (e) => tracer.record(e) }
		});
		tracer = new PromotionTracer(tree, CAP);

		// A promotion event drives exactly one timeline sample.
		const state = tree.ensure('topic', 'cohortA', 0, 0);
		tree.setParticipants(state, CAP + 5, 0); // over cap → overCapCount + overshoot
		tree.promote(state, 0);

		expect(tracer.samples).to.have.lengthOf(1);
		expect(tracer.samples[0]!.overCapCount, 'one coord above cap').to.equal(1);
		expect(tracer.peakOvershoot(), 'overshoot = directParticipants − cap').to.equal(5);
	});
});

describe('promotion-convergence — uniformLadder', () => {
	it('nests prefix buckets so every tier-d coord refines its tier-(d−1) parent', () => {
		// Two participants sharing the first F^1 bucket (index ≡ mod 16) must share the tier-1 coord;
		// the root coord is shared by all.
		const a = uniformLadder(3, 2, F);
		const b = uniformLadder(3 + F, 2, F); // same index mod F → same tier-1 bucket
		expect(bytesToHex(a[0]!), 'root shared').to.equal(bytesToHex(b[0]!));
		expect(bytesToHex(a[1]!), 'tier-1 bucket shared (index ≡ mod F)').to.equal(bytesToHex(b[1]!));
		// A different residue mod F lands on a different tier-1 coord.
		const c = uniformLadder(4, 2, F);
		expect(bytesToHex(a[1]!)).to.not.equal(bytesToHex(c[1]!));
	});

	it('rejects malformed inputs and bucket-field overflow', () => {
		expect(() => uniformLadder(-1, 2, F), 'negative index').to.throw(RangeError);
		expect(() => uniformLadder(1.5, 2, F), 'non-integer index').to.throw(RangeError);
		expect(() => uniformLadder(0, -1, F), 'negative dMax').to.throw(RangeError);
		expect(() => uniformLadder(0, 1.5, F), 'non-integer dMax').to.throw(RangeError);
		expect(() => uniformLadder(0, 2, 15), 'F not a power of two').to.throw(RangeError);
		// F^8 = 2^32 overflows the 32-bit bucket field (max is 0xffff_ffff = 2^32 − 1).
		expect(() => uniformLadder(0, 8, F), 'F^dMax exceeds the bucket field').to.throw(RangeError);
		// dMax = 0 is valid: a root-only ladder of length 1.
		expect(uniformLadder(0, 0, F)).to.have.lengthOf(1);
	});
});

describe('promotion-convergence — runConvergence guards & sparse regime', () => {
	it('rejects a negative or non-integer N', () => {
		expect(() => runConvergence({ N: -1, lookahead: true }), 'negative N').to.throw(RangeError);
		expect(() => runConvergence({ N: 2.5, lookahead: true }), 'non-integer N').to.throw(RangeError);
	});

	it('N = 0 produces an empty, depth-0, overshoot-free run', () => {
		const r = runConvergence({ N: 0, lookahead: true });
		expect(r.steadyStateDepth, 'no participants ⇒ depth 0').to.equal(0);
		expect(r.peakOvershoot, 'nothing to overshoot').to.equal(0);
		expect(r.oscillations).to.equal(0);
		expect(r.convergenceLatency).to.be.at.least(0);
	});

	it('sparse regime (N ≤ cap_promote) stays at the root with lookahead OFF', () => {
		// Lookahead OFF is the faithful measure of the *structural* steady-state depth: the root
		// holds all N ≤ cap_promote participants without ever crossing the promotion cap.
		for (const N of [1, CAP - 1, CAP]) {
			const r = runConvergence({ N, lookahead: false });
			expect(r.steadyStateDepth, `root holds N=${N} ≤ cap`).to.equal(0);
		}
	});
});

describe('promotion-convergence — boundary characterization (law is ±1 near cap·F^k)', () => {
	// The closed-form law `⌈log_F(N/cap)⌉` is an approximation: it ignores that a promoted ancestor
	// retains its participants, so near the `N = cap·F^k` boundaries observed depth can sit one tier
	// below the law, and slope-based lookahead can pre-promote a still-ramping root one tier above it
	// in the sparse regime. These are pinned so the divergence stays visible, not silently "passing".
	it('lookahead pre-promotes a full-but-not-overflowing root above the law in the sparse regime', () => {
		// N == cap_promote: structurally a root-only tree (law = 0), but slope-based lookahead
		// extrapolates the ramp past the cap and pre-promotes, yielding observed depth 1.
		const law = expectedDepth(CAP, F, CAP);
		expect(law, 'law clamps the sparse regime to 0').to.equal(0);
		expect(runConvergence({ N: CAP, lookahead: true }).steadyStateDepth, 'lookahead over-promotes')
			.to.equal(1);
		expect(runConvergence({ N: CAP, lookahead: false }).steadyStateDepth, 'no-lookahead matches law')
			.to.equal(0);
	});

	it('just past cap·F retained ancestors keep observed depth one tier below the law', () => {
		// N = cap·F + 1 = 1025: the law rounds up to 2, but cap·F participants already fit across the
		// F tier-1 cohorts (plus the retained root), so the observed tree settles at depth 1.
		const N = CAP * F + 1; // 1025
		expect(expectedDepth(N, F, CAP), 'law rounds up').to.equal(2);
		expect(runConvergence({ N, lookahead: true }).steadyStateDepth, 'model is tighter').to.equal(1);
		expect(runConvergence({ N, lookahead: false }).steadyStateDepth).to.equal(1);
	});
});
