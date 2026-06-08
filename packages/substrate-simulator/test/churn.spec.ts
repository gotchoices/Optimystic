import { expect } from 'chai';
import { createSimWorld } from '../src/world.js';
import { ChurnGenerator } from '../src/churn.js';
import { BackoffAdmission } from '../src/backoff.js';

const SEED = 31337;

function ids(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_v, i) => `${prefix}${i}`);
}

describe('ChurnGenerator — scheduled arrivals/departures', () => {
	it('turns over churnPctPerMin of the population each minute, balanced and population-stable', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const arrived: string[] = [];
		const departed: string[] = [];
		const gen = new ChurnGenerator({
			scheduler: world.scheduler,
			rng: world.rng.fork('churn'),
			config: { churnPctPerMin: 0.2, latencyJitterMs: 50 },
			active: ids('a', 100),
			pool: ids('b', 100),
			tickMs: 60_000,
			onArrival: (id) => arrived.push(id),
			onDeparture: (id) => departed.push(id)
		});
		gen.start();

		// Five churn ticks (60s..300s); their jittered events all resolve by 300_050.
		world.scheduler.run(305_000);

		// 0.2 × 100 = 20 turn over per minute, in and out balanced, over five minutes.
		expect(gen.arrivals).to.equal(100);
		expect(gen.departures).to.equal(100);
		expect(arrived).to.have.lengthOf(100);
		expect(departed).to.have.lengthOf(100);
		// Arrivals balance departures, so the active population is conserved.
		expect(gen.activeCount).to.equal(100);
	});

	it('is byte-deterministic from (seed, config): two runs churn the same peers in the same order', () => {
		function run(): string {
			const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
			const trace: string[] = [];
			const gen = new ChurnGenerator({
				scheduler: world.scheduler,
				rng: world.rng.fork('churn'),
				config: { churnPctPerMin: 0.2, latencyJitterMs: 50 },
				active: ids('a', 100),
				pool: ids('b', 100),
				tickMs: 60_000,
				onArrival: (id, now) => trace.push(`+${id}@${now}`),
				onDeparture: (id, now) => trace.push(`-${id}@${now}`)
			});
			gen.start();
			world.scheduler.run(185_000);
			return trace.join('|');
		}
		expect(run()).to.equal(run());
	});
});

describe('willingness back-off — gating sheds load without a cascade', () => {
	it('caps accepted/sec at capacity under a burst and offered load decays rather than cascading', () => {
		const world = createSimWorld({ seed: SEED, gossipRoundMs: 1000 });
		const M = 40; // burst size
		const capacityPerSec = 4; // willing-quorum admission capacity
		const acceptedAt: number[] = [];
		const attemptAt: number[] = [];

		// Admission gate: willingness/barometer admits at most `capacityPerSec` over any rolling
		// second; the rest get UnwillingCohort and back off (cohort-topic.md §Capacity barometer).
		const gate = (now: number): boolean => {
			attemptAt.push(now);
			const recent = acceptedAt.reduce((n, t) => (t > now - 1000 ? n + 1 : n), 0);
			if (recent < capacityPerSec) {
				acceptedAt.push(now);
				return true;
			}
			return false;
		};

		const drivers = Array.from({ length: M }, (_v, i) => new BackoffAdmission({
			scheduler: world.scheduler,
			participantId: `p${i}`,
			gate,
			config: { baseMs: 500, factor: 2, maxMs: 8000 }
		}));

		world.scheduler.run(600_000);

		// Every participant is eventually admitted — gating delays, it does not starve.
		expect(drivers.every((d) => d.admitted)).to.equal(true);

		// Accepted/sec never exceeds capacity (capacity-matched, no cascade past the barometer).
		const perSecond = new Map<number, number>();
		for (const t of acceptedAt) {
			const s = Math.floor(t / 1000);
			perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
		}
		expect(Math.max(...perSecond.values())).to.be.at.most(capacityPerSec);

		// No cascading load increase: exponential back-off makes offered load *decay* over time —
		// the back half of the run sees no more attempts than the front half. A fixed-interval
		// retry would do the opposite, piling rejected participants onto every window.
		const lastAdmit = Math.max(...drivers.map((d) => d.admittedAt!));
		const mid = lastAdmit / 2;
		const firstHalf = attemptAt.filter((t) => t < mid).length;
		const secondHalf = attemptAt.filter((t) => t >= mid).length;
		expect(secondHalf).to.be.at.most(firstHalf);

		// Total offered load stays bounded (a small multiple of the burst), not a retry storm.
		const totalAttempts = drivers.reduce((n, d) => n + d.attempts, 0);
		expect(totalAttempts).to.be.at.most(M * 12);
	});
});
