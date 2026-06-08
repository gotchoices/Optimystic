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
});
