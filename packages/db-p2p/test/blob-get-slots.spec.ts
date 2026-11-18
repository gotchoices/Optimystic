import { expect } from 'chai';
import { BlobGetSlots } from '../src/blob/blob-get-slots.js';

/** Whether `promise` has settled once queued microtasks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(() => { done = true; }, () => { done = true; });
	await new Promise<void>(resolve => setImmediate(resolve));
	return done;
}

describe('BlobGetSlots', () => {
	it('a waiter for a busy peer does not hold up a later waiter for another peer', async () => {
		const slots = new BlobGetSlots({ background: 2 });
		const releaseA = await slots.acquire('peer-a', 'background');
		const secondA = slots.acquire('peer-a', 'background');
		const firstB = slots.acquire('peer-b', 'background');

		expect(await settled(firstB), 'peer-b granted while peer-a is busy').to.equal(true);
		expect(await settled(secondA), 'one stream per peer and priority').to.equal(false);
		releaseA();
		expect(await settled(secondA), 'peer-a granted once its stream is released').to.equal(true);
	});

	it('an aborted waiter leaves the queue without taking the slot', async () => {
		const slots = new BlobGetSlots({ foreground: 1 });
		const releaseA = await slots.acquire('peer-a', 'foreground');
		const controller = new AbortController();
		const aborted = slots.acquire('peer-b', 'foreground', controller.signal);
		const next = slots.acquire('peer-c', 'foreground');

		const reason = new Error('stopped');
		controller.abort(reason);
		let rejection: unknown;
		await aborted.catch((error: unknown) => { rejection = error; });
		expect(rejection).to.equal(reason);
		releaseA();
		expect(await settled(next), 'the slot went to the waiter behind the aborted one').to.equal(true);
	});
});
