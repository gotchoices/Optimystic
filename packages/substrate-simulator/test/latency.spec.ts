import { expect } from 'chai';
import {
	DeterministicLatency,
	StochasticLatency,
	AdversarialLatency,
	DEFAULT_GOSSIP_ROUND_MS
} from '../src/latency.js';
import { VirtualScheduler } from '../src/scheduler.js';
import { createRng } from '../src/rng.js';
import { generatePeers } from '../src/peer.js';
import type { EventContext, LatencyModel, PeerRef } from '../src/types.js';

/** Drain a fixed scenario and return the recorded hop delays. */
function recordDelays(latency: LatencyModel, seed: number): number[] {
	const scheduler = new VirtualScheduler(createRng(seed), latency);
	const peers = generatePeers(4, createRng(seed).fork('peers'));
	const delays: number[] = [];
	for (let i = 0; i < 200; i++) {
		scheduler.scheduleAt(i, (c: EventContext) => {
			const d = c.latency.hopDelay(peers[i % 4]!, peers[(i + 1) % 4]!, c);
			delays.push(d);
		});
	}
	scheduler.run();
	return delays;
}

describe('LatencyModel', () => {
	it('exposes a gossip-round constant for Decision 6', () => {
		expect(DEFAULT_GOSSIP_ROUND_MS).to.be.a('number');
		expect(Number.isInteger(DEFAULT_GOSSIP_ROUND_MS)).to.equal(true);
	});

	describe('DeterministicLatency', () => {
		it('returns the fixed delay and ignores rng', () => {
			const model = new DeterministicLatency(75);
			const delays = recordDelays(model, 1);
			expect(delays.every(d => d === 75)).to.equal(true);
		});

		it('rejects a negative or non-integer fixed delay', () => {
			expect(() => new DeterministicLatency(-1)).to.throw(RangeError);
			expect(() => new DeterministicLatency(1.5)).to.throw(RangeError);
		});
	});

	describe('StochasticLatency', () => {
		it('never returns a sub-minMs or negative delay, and always an integer', () => {
			const model = new StochasticLatency({ rttMs: 50, sigma: 1.5, minMs: 5 });
			const scheduler = new VirtualScheduler(createRng(3), model);
			const peers = generatePeers(2, createRng(3));
			let worst = Infinity;
			for (let i = 0; i < 20000; i++) {
				scheduler.scheduleAt(i, (c: EventContext) => {
					const d = c.latency.hopDelay(peers[0]!, peers[1]!, c);
					expect(Number.isInteger(d)).to.equal(true);
					expect(d).to.be.gte(5);
					worst = Math.min(worst, d);
				});
			}
			scheduler.run();
			// With sigma this wide over 20k draws, the floor should actually bind at least once.
			expect(worst).to.equal(5);
		});

		it('is deterministic for a fixed seed and varies with the seed', () => {
			const a = recordDelays(new StochasticLatency({ rttMs: 40, sigma: 0.5, minMs: 1 }), 11);
			const b = recordDelays(new StochasticLatency({ rttMs: 40, sigma: 0.5, minMs: 1 }), 11);
			const c = recordDelays(new StochasticLatency({ rttMs: 40, sigma: 0.5, minMs: 1 }), 12);
			expect(a).to.deep.equal(b);
			expect(a).to.not.deep.equal(c);
		});

		it('rejects invalid options', () => {
			expect(() => new StochasticLatency({ rttMs: 0, sigma: 1, minMs: 0 })).to.throw(RangeError);
			expect(() => new StochasticLatency({ rttMs: 10, sigma: -1, minMs: 0 })).to.throw(RangeError);
			expect(() => new StochasticLatency({ rttMs: 10, sigma: 1, minMs: -1 })).to.throw(RangeError);
		});
	});

	describe('AdversarialLatency', () => {
		it('returns worstMs by default', () => {
			const delays = recordDelays(new AdversarialLatency({ worstMs: 999 }), 1);
			expect(delays.every(d => d === 999)).to.equal(true);
		});

		it('supports a custom strategy that may inspect peers', () => {
			const seen: PeerRef[] = [];
			const model = new AdversarialLatency((a, _b, _c) => {
				seen.push(a);
				return 123;
			});
			const delays = recordDelays(model, 1);
			expect(delays.every(d => d === 123)).to.equal(true);
			expect(seen.length).to.equal(200);
		});

		it('rejects a negative worstMs', () => {
			expect(() => new AdversarialLatency({ worstMs: -1 })).to.throw(RangeError);
		});
	});

	it('swapping the model changes only event times, never the determinism guarantee', () => {
		const fixed = recordDelays(new DeterministicLatency(20), 7);
		const stochastic = recordDelays(new StochasticLatency({ rttMs: 20, sigma: 0.3, minMs: 1 }), 7);
		// Same shape (same count of hops), different times.
		expect(stochastic.length).to.equal(fixed.length);
		expect(stochastic).to.not.deep.equal(fixed);
		// And the stochastic model is itself byte-stable for the seed.
		expect(recordDelays(new StochasticLatency({ rttMs: 20, sigma: 0.3, minMs: 1 }), 7)).to.deep.equal(stochastic);
	});
});
