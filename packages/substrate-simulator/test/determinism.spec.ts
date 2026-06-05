import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { StochasticLatency } from '../src/latency.js';
import { generatePeers } from '../src/peer.js';
import type { EventContext, LatencyModel, SimConfig } from '../src/types.js';

/**
 * A small reusable scenario that exercises every determinism-relevant path: equal-time
 * cohorts, events scheduling events, latency draws, and rng draws. Returns a flat trace
 * plus a tag-only projection (structure independent of the stochastic values).
 */
function runScenario(seed: number, latency: LatencyModel): { trace: string; tags: string } {
	const config: SimConfig = { seed, gossipRoundMs: 200 };
	const world = createSimWorld(config, latency);
	const peers = generatePeers(5, world.rng.fork('peers'));
	const trace: string[] = [];
	const tags: string[] = [];
	for (let i = 0; i < 30; i++) {
		world.scheduler.scheduleAfter(i % 4, (c: EventContext) => {
			const a = peers[i % 5]!;
			const b = peers[(i + 1) % 5]!;
			const d = c.latency.hopDelay(a, b, c);
			const jitter = c.rng.nextInt(10);
			trace.push(`${c.now}:e${i}:d${d}:j${jitter}`);
			// Only the deterministically-timed `e` events feed the structural projection: their
			// (at, seq) order is seed-independent. The `f` events fire at now+d (d is stochastic),
			// so their relative order legitimately varies with the seed — that is expected.
			tags.push(`e${i}`);
			if (i < 10) {
				c.scheduler.scheduleAfter(d, (c2: EventContext) => {
					trace.push(`${c2.now}:f${i}`);
				});
			}
		});
	}
	world.scheduler.run();
	return { trace: trace.join('|'), tags: tags.join('|') };
}

describe('determinism', () => {
	it('two full runs with the same (seed, config) produce byte-identical traces', () => {
		const latency = () => new StochasticLatency({ rttMs: 60, sigma: 0.6, minMs: 5 });
		const a = runScenario(2024, latency());
		const b = runScenario(2024, latency());
		expect(a.trace).to.equal(b.trace);
	});

	it('changing only the seed changes stochastic values but not the equal-time ordering rule', () => {
		const latency = () => new StochasticLatency({ rttMs: 60, sigma: 0.6, minMs: 5 });
		const a = runScenario(1, latency());
		const b = runScenario(2, latency());
		// Different stochastic values...
		expect(a.trace).to.not.equal(b.trace);
		// ...but the firing structure (which event fires in what order) is unchanged.
		expect(a.tags).to.equal(b.tags);
	});

	it('equal-at ordering is seq-ascending and identical across two same-seed runs', () => {
		// Pure ordering check: no latency draws, all events at the same at.
		const order1: number[] = [];
		const order2: number[] = [];
		for (const sink of [order1, order2]) {
			const world = createSimWorld({ seed: 5, gossipRoundMs: 200 });
			for (let i = 0; i < 50; i++) {
				world.scheduler.scheduleAt(100, () => sink.push(i));
			}
			world.scheduler.run();
		}
		expect(order1).to.deep.equal(Array.from({ length: 50 }, (_v, i) => i));
		expect(order1).to.deep.equal(order2);
	});
});
