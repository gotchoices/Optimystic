import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
use(chaiAsPromised);

import { delay, waitFor, waitForValue } from '../src/testing/async-wait.js';

describe('async-wait helpers', () => {
	describe('delay', () => {
		it('resolves after at least the specified ms', async () => {
			const start = Date.now();
			await delay(20);
			expect(Date.now() - start).to.be.at.least(10);
		});
	});

	describe('waitFor', () => {
		it('resolves immediately when predicate is already true', async () => {
			await waitFor(() => true, { timeoutMs: 100 });
		});

		it('resolves once predicate becomes true', async () => {
			let ready = false;
			setTimeout(() => { ready = true; }, 20);
			await waitFor(() => ready, { timeoutMs: 200, intervalMs: 5 });
		});

		it('throws when predicate never becomes true within timeoutMs', async () => {
			await expect(
				waitFor(() => false, { timeoutMs: 50, intervalMs: 5 }),
			).to.be.rejectedWith(/timed out after 50ms/);
		});

		it('includes description in the thrown message', async () => {
			await expect(
				waitFor(() => false, { timeoutMs: 20, intervalMs: 5, description: 'foo must be true' }),
			).to.be.rejectedWith(/foo must be true/);
		});

		it('awaits an async predicate', async () => {
			let count = 0;
			await waitFor(async () => {
				count++;
				await delay(1);
				return count >= 3;
			}, { timeoutMs: 500, intervalMs: 1 });
			expect(count).to.be.at.least(3);
		});

		it('propagates a predicate rejection immediately', async () => {
			const boom = new Error('pred-boom');
			await expect(
				waitFor(async () => { throw boom; }, { timeoutMs: 500 }),
			).to.be.rejectedWith('pred-boom');
		});
	});

	describe('waitForValue', () => {
		it('returns the value once fn returns non-undefined', async () => {
			let n = 0;
			const result = await waitForValue(() => {
				n++;
				return n >= 3 ? 'found' : undefined;
			}, { timeoutMs: 500, intervalMs: 1 });
			expect(result).to.equal('found');
		});

		it('throws when fn never returns a value within timeoutMs', async () => {
			await expect(
				waitForValue(() => undefined, { timeoutMs: 50, intervalMs: 5 }),
			).to.be.rejectedWith(/timed out after 50ms/);
		});

		it('includes description in the thrown message', async () => {
			await expect(
				waitForValue(() => undefined, { timeoutMs: 20, intervalMs: 5, description: 'item to appear' }),
			).to.be.rejectedWith(/item to appear/);
		});

		it('works with async fn', async () => {
			let ready = false;
			setTimeout(() => { ready = true; }, 20);
			const val = await waitForValue(async () => {
				await delay(1);
				return ready ? 42 : undefined;
			}, { timeoutMs: 200, intervalMs: 5 });
			expect(val).to.equal(42);
		});
	});
});
