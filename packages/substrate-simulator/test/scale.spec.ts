import { expect } from 'chai';
import { VirtualScheduler } from '../src/scheduler.js';
import { createRng } from '../src/rng.js';
import { DeterministicLatency } from '../src/latency.js';

const N = 1_000_000;

/** Replace real-time globals with spies for the duration of `body`; restore afterward. */
function withRealTimeSpies(body: () => void): { random: number; dateNow: number; setTimeout: number } {
	const counts = { random: 0, dateNow: 0, setTimeout: 0 };
	const origRandom = Math.random;
	const origDateNow = Date.now;
	const origSetTimeout = globalThis.setTimeout;
	Math.random = () => {
		counts.random++;
		return origRandom();
	};
	Date.now = () => {
		counts.dateNow++;
		return origDateNow();
	};
	(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((...args: Parameters<typeof setTimeout>) => {
		counts.setTimeout++;
		return origSetTimeout(...args);
	}) as typeof setTimeout;
	try {
		body();
	} finally {
		Math.random = origRandom;
		Date.now = origDateNow;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
	}
	return counts;
}

describe('scale (1M)', () => {
	it('drains 1,000,000 discrete events in seconds with no real-time calls', function () {
		this.timeout(30_000);
		const scheduler = new VirtualScheduler(createRng(1), new DeterministicLatency(10));
		let lastNow = -1;
		let monotonic = true;
		const spies = withRealTimeSpies(() => {
			for (let i = 0; i < N; i++) {
				scheduler.scheduleAt(i, c => {
					if (c.now < lastNow) {
						monotonic = false;
					}
					lastNow = c.now;
				});
			}
			const fired = scheduler.run();
			expect(fired).to.equal(N);
		});
		expect(monotonic).to.equal(true);
		expect(scheduler.now()).to.equal(N - 1);
		expect(scheduler.pending()).to.equal(0);
		expect(spies.random).to.equal(0);
		expect(spies.dateNow).to.equal(0);
		expect(spies.setTimeout).to.equal(0);
	});

	it('scheduleBatch(at, 1M) drains from a single heap slot', function () {
		this.timeout(30_000);
		const scheduler = new VirtualScheduler(createRng(1), new DeterministicLatency(10));
		let count = 0;
		let firstIndex = -1;
		let lastIndex = -1;
		scheduler.scheduleBatch(100, N, (_c, i) => {
			if (count === 0) {
				firstIndex = i;
			}
			lastIndex = i;
			count++;
		});
		// One burst → one heap entry, regardless of count.
		expect(scheduler.pending()).to.equal(1);
		const fired = scheduler.run();
		expect(fired).to.equal(N);
		expect(count).to.equal(N);
		expect(firstIndex).to.equal(0);
		expect(lastIndex).to.equal(N - 1);
		expect(scheduler.now()).to.equal(100);
	});
});
