import { expect } from 'chai';
import { createColdQuorumWait, MAX_COLD_QUORUM_WAITERS } from '../../src/cohort-topic/cold-quorum-wait.js';

/** Resolves `'pending'` when `p` has not settled by the next macrotask. */
function settledOrPending<T>(p: Promise<T>): Promise<T | 'pending'> {
	return Promise.race([p, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))]);
}

describe('cohort-topic / cold-quorum wait', () => {
	it('opens no wait when the members could not be asked', async () => {
		let asked = 0;
		const wait = createColdQuorumWait({ waitMs: 60_000, solicit: () => { asked++; return false; } });

		expect(await settledOrPending(wait.until(() => false, 1_000)), 'resolves at once, at the caller\'s clock').to.equal(1_000);
		expect(await settledOrPending(wait.until(() => false, 2_000)), 'the next register asks again rather than joining a wait that never opened').to.equal(2_000);
		expect(asked).to.equal(2);
	});

	it('settles a waiter whose members never answer at the deadline, on the caller\'s clock', async () => {
		const wait = createColdQuorumWait({ waitMs: 30, solicit: () => true });

		const settledAt = await wait.until(() => false, 1_000);
		// Timers may fire a millisecond early against Date.now(); the bound only has to show the hold happened.
		expect(settledAt, 'the caller\'s clock advanced by the time spent waiting').to.be.within(1_025, 1_500);
	});

	it('shares one solicitation among waiters, settles on recheck only those that are ready, and declines past the cap', async () => {
		let asked = 0;
		const wait = createColdQuorumWait({ waitMs: 60_000, solicit: () => { asked++; return true; } });
		let firstReady = false;

		const first = wait.until(() => firstReady, 1_000);
		const second = wait.until(() => false, 1_000);
		for (let i = 2; i < MAX_COLD_QUORUM_WAITERS; i++) {
			void wait.until(() => false, 1_000);
		}
		expect(await settledOrPending(wait.until(() => false, 3_000)), 'a register past the cap is not held').to.equal(3_000);
		expect(asked, 'the members are asked once per wait, not once per register').to.equal(1);

		wait.recheck();
		expect(await settledOrPending(first), 'a recheck settles nothing that is not ready').to.equal('pending');

		firstReady = true;
		wait.recheck();
		expect(await settledOrPending(first)).to.be.a('number');
		expect(await settledOrPending(second), 'the others stay held').to.equal('pending');

		wait.close();
		expect(await settledOrPending(second), 'closing answers every held register').to.be.a('number');
	});
});
