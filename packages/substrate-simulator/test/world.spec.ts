import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { DeterministicLatency, StochasticLatency, DEFAULT_HOP_MS } from '../src/latency.js';
import { generatePeers } from '../src/peer.js';

describe('createSimWorld (SimWorldCore)', () => {
	it('wires the core four fields from (config, latency)', () => {
		const latency = new StochasticLatency({ rttMs: 30, sigma: 0.4, minMs: 1 });
		const world = createSimWorld({ seed: 17, gossipRoundMs: 250 }, latency);
		expect(world.config.seed).to.equal(17);
		expect(world.config.gossipRoundMs).to.equal(250);
		expect(world.scheduler.now()).to.equal(0);
		expect(world.latency).to.equal(latency);
		expect(world.rng.nextU32()).to.be.a('number');
	});

	it('defaults latency to DeterministicLatency(DEFAULT_HOP_MS)', () => {
		const world = createSimWorld({ seed: 1, gossipRoundMs: 200 });
		expect(world.latency).to.be.instanceOf(DeterministicLatency);
		let delay = -1;
		world.scheduler.scheduleAt(0, c => {
			delay = c.latency.hopDelay(generatePeers(1, c.rng)[0]!, generatePeers(1, c.rng)[0]!, c);
		});
		world.scheduler.run();
		expect(delay).to.equal(DEFAULT_HOP_MS);
	});

	it('config carries scenario params through the open index signature', () => {
		const world = createSimWorld({ seed: 1, gossipRoundMs: 200, nodeCount: 1000, capPromote: 8 });
		expect(world.config.nodeCount).to.equal(1000);
		expect(world.config.capPromote).to.equal(8);
	});
});

describe('generatePeers', () => {
	it('is deterministic for a fixed rng seed', () => {
		const a = generatePeers(100, createSimWorld({ seed: 9, gossipRoundMs: 1 }).rng);
		const b = generatePeers(100, createSimWorld({ seed: 9, gossipRoundMs: 1 }).rng);
		expect(a.map(p => p.id)).to.deep.equal(b.map(p => p.id));
	});

	it('produces 256-bit keys and distinct ids', () => {
		const peers = generatePeers(500, createSimWorld({ seed: 9, gossipRoundMs: 1 }).rng);
		expect(peers.every(p => p.key.length === 32)).to.equal(true);
		expect(new Set(peers.map(p => p.id)).size).to.equal(500);
	});

	it('rejects a negative count', () => {
		expect(() => generatePeers(-1, createSimWorld({ seed: 1, gossipRoundMs: 1 }).rng)).to.throw(RangeError);
	});
});
