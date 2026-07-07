import { expect } from 'chai';
import { ConnectionMutex } from '../src/connection-mutex.js';

// Direct unit coverage for the crux of st-nativescript-sqlite-transaction-mutex.
// The integration specs exercise the mutex through the storage layer; these pin the
// three properties the fix relies on: FIFO ordering, per-task result/error propagation,
// and a non-poisoning tail (a rejected task must not stall or reject the tasks behind it).
describe('ConnectionMutex', () => {
	it('runs queued tasks strictly in FIFO order, never overlapping', async () => {
		const mutex = new ConnectionMutex();
		const order: number[] = [];
		let active = 0;
		let maxActive = 0;

		const task = (n: number) => mutex.serialize(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			// Yield across a microtask to give any un-serialized task a chance to overlap.
			await Promise.resolve();
			order.push(n);
			active--;
		});

		await Promise.all([task(1), task(2), task(3), task(4)]);

		expect(order, 'tasks ran in enqueue order').to.deep.equal([1, 2, 3, 4]);
		expect(maxActive, 'never more than one task in flight').to.equal(1);
	});

	it('propagates each task\'s own result and error to its own caller', async () => {
		const mutex = new ConnectionMutex();
		const ok = mutex.serialize(async () => 42);
		const bad = mutex.serialize(async () => { throw new Error('boom'); });

		expect(await ok).to.equal(42);
		let caught: unknown;
		try { await bad; } catch (err) { caught = err; }
		expect((caught as Error)?.message).to.equal('boom');
	});

	it('does not poison the queue: a rejected task still runs the ones behind it, in order', async () => {
		const mutex = new ConnectionMutex();
		const order: string[] = [];

		const failing = mutex.serialize(async () => {
			order.push('fail-start');
			throw new Error('rollback');
		});
		const after = mutex.serialize(async () => {
			order.push('after');
			return 'ok';
		});

		await Promise.allSettled([failing, after]);
		expect(order).to.deep.equal(['fail-start', 'after']);
		expect(await after).to.equal('ok');
	});

	it('accepts synchronous tasks and still serializes them', async () => {
		const mutex = new ConnectionMutex();
		const order: number[] = [];
		await Promise.all([
			mutex.serialize(() => { order.push(1); }),
			mutex.serialize(() => { order.push(2); }),
		]);
		expect(order).to.deep.equal([1, 2]);
	});
});
