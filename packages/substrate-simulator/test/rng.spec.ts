import { expect } from 'chai';
import { Mulberry32Rng, createRng } from '../src/rng.js';

describe('SeededRng (mulberry32)', () => {
	it('is deterministic in the seed: two streams agree value-for-value', () => {
		const a = createRng(12345);
		const b = createRng(12345);
		for (let i = 0; i < 1000; i++) {
			expect(a.nextU32()).to.equal(b.nextU32());
		}
	});

	it('differs across seeds', () => {
		const a = createRng(1);
		const b = createRng(2);
		const sameCount = Array.from({ length: 100 }, () => a.nextU32() === b.nextU32())
			.filter(Boolean).length;
		expect(sameCount).to.be.lessThan(5);
	});

	it('nextFloat is in [0, 1)', () => {
		const r = createRng(99);
		for (let i = 0; i < 10000; i++) {
			const f = r.nextFloat();
			expect(f).to.be.gte(0);
			expect(f).to.be.lessThan(1);
		}
	});

	it('nextInt is in [0, maxExclusive) and rejects non-positive bounds', () => {
		const r = createRng(7);
		for (let i = 0; i < 10000; i++) {
			const n = r.nextInt(10);
			expect(n).to.be.gte(0);
			expect(n).to.be.lessThan(10);
			expect(Number.isInteger(n)).to.equal(true);
		}
		expect(() => r.nextInt(0)).to.throw(RangeError);
		expect(() => r.nextInt(-3)).to.throw(RangeError);
		expect(() => r.nextInt(1.5)).to.throw(RangeError);
	});

	it('createRng rejects a non-integer seed', () => {
		expect(() => createRng(1.5)).to.throw(TypeError);
	});

	describe('fork', () => {
		it('same (seed, label) yields identical sub-streams, independent of parent draw interleaving', () => {
			const parentA = createRng(42);
			const parentB = createRng(42);
			// Draw the parent streams a different number of times before forking.
			parentA.nextU32();
			parentA.nextU32();
			parentA.nextU32();
			const forkA = parentA.fork('cohort');
			const forkB = parentB.fork('cohort');
			for (let i = 0; i < 500; i++) {
				expect(forkA.nextU32()).to.equal(forkB.nextU32());
			}
		});

		it('different labels yield different sub-streams', () => {
			const parent = createRng(42);
			const f1 = parent.fork('a');
			const f2 = parent.fork('b');
			const same = Array.from({ length: 100 }, () => f1.nextU32() === f2.nextU32())
				.filter(Boolean).length;
			expect(same).to.be.lessThan(5);
		});

		it('a fork does not advance the parent stream', () => {
			const a = createRng(123);
			const control = createRng(123);
			a.fork('x');
			a.fork('y');
			expect(a.nextU32()).to.equal(control.nextU32());
		});

		it('forks compose: fork-of-fork is deterministic', () => {
			const a = new Mulberry32Rng(5).fork('p').fork('q');
			const b = new Mulberry32Rng(5).fork('p').fork('q');
			for (let i = 0; i < 100; i++) {
				expect(a.nextU32()).to.equal(b.nextU32());
			}
		});
	});
});
