import { expect } from 'chai';
import { VirtualScheduler } from '../src/scheduler.js';
import { createRng } from '../src/rng.js';
import { DeterministicLatency } from '../src/latency.js';
import type { EventContext } from '../src/types.js';

function makeScheduler(maxEvents?: number): VirtualScheduler {
	return new VirtualScheduler(createRng(1), new DeterministicLatency(10), { maxEvents });
}

describe('VirtualScheduler', () => {
	it('starts at now() == 0 with an empty queue', () => {
		const s = makeScheduler();
		expect(s.now()).to.equal(0);
		expect(s.pending()).to.equal(0);
	});

	it('fires events in strictly non-decreasing at order; now() tracks the firing event', () => {
		const s = makeScheduler();
		const times: number[] = [];
		s.scheduleAt(30, c => times.push(c.now));
		s.scheduleAt(10, c => times.push(c.now));
		s.scheduleAt(20, c => times.push(c.now));
		s.scheduleAt(10, c => times.push(c.now));
		const fired = s.run();
		expect(fired).to.equal(4);
		expect(times).to.deep.equal([10, 10, 20, 30]);
		expect(s.now()).to.equal(30);
	});

	it('equal-at events fire in insertion (seq) order', () => {
		const s = makeScheduler();
		const order: number[] = [];
		for (let i = 0; i < 5; i++) {
			s.scheduleAt(100, () => order.push(i));
		}
		s.run();
		expect(order).to.deep.equal([0, 1, 2, 3, 4]);
	});

	it('an event scheduled at now() during a fire lands after the current equal-time cohort', () => {
		const s = makeScheduler();
		const order: string[] = [];
		s.scheduleAt(50, c => {
			order.push('a');
			c.scheduler.scheduleAt(c.now, () => order.push('a-child'));
		});
		s.scheduleAt(50, () => order.push('b'));
		s.scheduleAt(50, () => order.push('c'));
		s.run();
		expect(order).to.deep.equal(['a', 'b', 'c', 'a-child']);
	});

	it('scheduleAfter(delay) equals scheduleAt(now()+delay)', () => {
		const s = makeScheduler();
		const seen: number[] = [];
		s.scheduleAt(100, c => {
			seen.push(c.now);
			c.scheduler.scheduleAfter(25, c2 => seen.push(c2.now));
			c.scheduler.scheduleAt(c.now + 25, c2 => seen.push(c2.now));
		});
		s.run();
		expect(seen).to.deep.equal([100, 125, 125]);
	});

	it('rejects past-time and negative scheduling', () => {
		const s = makeScheduler();
		s.scheduleAt(100, () => undefined);
		s.run();
		expect(s.now()).to.equal(100);
		expect(() => s.scheduleAt(99, () => undefined)).to.throw(RangeError);
		expect(() => s.scheduleAfter(-1, () => undefined)).to.throw(RangeError);
		expect(() => s.scheduleBatch(99, 1, () => undefined)).to.throw(RangeError);
		expect(() => s.scheduleBatch(200, -1, () => undefined)).to.throw(RangeError);
		// at == now() and delay == 0 are allowed.
		expect(() => s.scheduleAt(100, () => undefined)).to.not.throw();
		expect(() => s.scheduleAfter(0, () => undefined)).to.not.throw();
	});

	it('rejects non-integer times', () => {
		const s = makeScheduler();
		expect(() => s.scheduleAt(1.5, () => undefined)).to.throw(TypeError);
		expect(() => s.scheduleAfter(1.5, () => undefined)).to.throw(TypeError);
		expect(() => s.scheduleBatch(1.5, 1, () => undefined)).to.throw(TypeError);
		expect(() => s.scheduleBatch(10, 1.5, () => undefined)).to.throw(TypeError);
	});

	describe('run(until)', () => {
		it('fires events with at <= until; an event at until fires, one at until+1 stays', () => {
			const s = makeScheduler();
			const fired: number[] = [];
			s.scheduleAt(10, c => fired.push(c.now));
			s.scheduleAt(20, c => fired.push(c.now));
			s.scheduleAt(21, c => fired.push(c.now));
			s.scheduleAt(30, c => fired.push(c.now));
			const n = s.run(20);
			expect(n).to.equal(2);
			expect(fired).to.deep.equal([10, 20]);
			expect(s.now()).to.equal(20);
			expect(s.pending()).to.equal(2);
		});

		it('does not fabricate now() forward to until', () => {
			const s = makeScheduler();
			s.scheduleAt(10, () => undefined);
			s.run(1000);
			expect(s.now()).to.equal(10);
		});

		it('a second run(until) with only future events returns 0 and leaves now() unchanged', () => {
			const s = makeScheduler();
			s.scheduleAt(10, () => undefined);
			s.scheduleAt(50, () => undefined);
			s.run(20);
			expect(s.now()).to.equal(10);
			const n = s.run(20);
			expect(n).to.equal(0);
			expect(s.now()).to.equal(10);
			expect(s.pending()).to.equal(1);
		});
	});

	describe('empty / termination', () => {
		it('run() over an empty queue returns 0 and leaves now() unchanged', () => {
			const s = makeScheduler();
			expect(s.run()).to.equal(0);
			expect(s.now()).to.equal(0);
		});

		it('a run that schedules no further events drains to empty and terminates', () => {
			const s = makeScheduler();
			for (let i = 0; i < 100; i++) {
				s.scheduleAt(i, () => undefined);
			}
			expect(s.run()).to.equal(100);
			expect(s.pending()).to.equal(0);
		});

		it('maxEvents backstop throws on an unbounded same-time reschedule loop', () => {
			const s = makeScheduler(1000);
			s.scheduleAt(0, function loop(c: EventContext) {
				c.scheduler.scheduleAt(c.now, loop);
			});
			expect(() => s.run()).to.throw(/event ceiling exceeded/);
		});
	});

	describe('scheduleBatch', () => {
		it('fires indices 0..count-1 ascending, atomically at at', () => {
			const s = makeScheduler();
			const indices: number[] = [];
			const times = new Set<number>();
			s.scheduleBatch(40, 5, (c, i) => {
				indices.push(i);
				times.add(c.now);
			});
			const n = s.run();
			expect(n).to.equal(5);
			expect(indices).to.deep.equal([0, 1, 2, 3, 4]);
			expect([...times]).to.deep.equal([40]);
		});

		it('count 0 is a no-op that adds no heap entry', () => {
			const s = makeScheduler();
			s.scheduleBatch(40, 0, () => {
				throw new Error('should not fire');
			});
			expect(s.pending()).to.equal(0);
			expect(s.run()).to.equal(0);
		});

		it('a batch occupies one heap slot and events it schedules fire after it completes', () => {
			const s = makeScheduler();
			const order: string[] = [];
			s.scheduleBatch(10, 3, (c, i) => {
				order.push(`b${i}`);
				if (i === 0) {
					c.scheduler.scheduleAt(c.now, () => order.push('after-batch'));
				}
			});
			expect(s.pending()).to.equal(1);
			s.run();
			expect(order).to.deep.equal(['b0', 'b1', 'b2', 'after-batch']);
		});

		it('a batch fires before a later-seq single event at the same at', () => {
			const s = makeScheduler();
			const order: string[] = [];
			s.scheduleBatch(10, 2, (_c, i) => order.push(`b${i}`));
			s.scheduleAt(10, () => order.push('single'));
			s.run();
			expect(order).to.deep.equal(['b0', 'b1', 'single']);
		});
	});
});
