import { expect } from 'chai';
import { acquireBlockWriteLatches, acquireBlockWriteLatch, withBlockWriteLatch } from '../src/storage/block-latch.js';
import type { BlockId } from '@optimystic/db-core';
import { delay } from '@optimystic/db-core/test';

/**
 * The multi-latch entry point owns a property none of its callers can own alone.
 *
 * `StorageRepo.pend`, `StorageRepo.commit` and `applyInvalidation` each hold several block write
 * latches at once, and what keeps them from deadlocking against each other is that ALL of them
 * acquire through here, in one global order. That argument lives in this module, so it is tested
 * here rather than re-tested through each caller — a fourth caller, or a refactor that drops the
 * sort or the dedup, breaks the property at this seam, not at theirs.
 *
 * A regression in the ordering arm HANGS rather than failing, so those cases race an explicit
 * timeout instead of awaiting directly.
 */
describe('acquireBlockWriteLatches', () => {
	const settles = async (work: Promise<unknown>, ms = 3000) =>
		await Promise.race([work.then(() => 'settled' as const), delay(ms).then(() => 'timeout' as const)]);

	it('dedups repeated ids, so a set naming one block twice does not deadlock against itself', async () => {
		const X = 'latch-dedup-x' as BlockId;
		const Y = 'latch-dedup-y' as BlockId;

		const held = acquireBlockWriteLatches([X, Y, X, X]);
		expect(await settles(held), 'a repeated id must not be acquired twice').to.equal('settled');

		const { latches, release } = await held;
		expect([...latches.keys()].sort(), 'one token per DISTINCT id').to.deep.equal([X, Y].sort());
		release();
	});

	it('acquires in one global order, so opposite request orders cannot build a cycle', async () => {
		const X = 'latch-order-x' as BlockId;
		const Y = 'latch-order-y' as BlockId;

		// The classic cycle, started CONCURRENTLY so it can actually form: unsorted, one holder takes
		// X and the other takes Y, and each then waits forever on the latch the other holds. Sorting
		// makes both want X first, so one completes its whole hold before the other starts.
		const both = Promise.all([
			acquireBlockWriteLatches([X, Y]).then(async (h) => { await delay(5); h.release(); }),
			acquireBlockWriteLatches([Y, X]).then(async (h) => { await delay(5); h.release(); })
		]);
		expect(await settles(both), 'opposite request orders must not deadlock').to.equal('settled');
	});

	it('holds the WHOLE set — a single-block acquirer waits for the multi-hold to release', async () => {
		// The mutual exclusion the callers rely on: `pend` classifying block Y is not interruptible by
		// a writer that only wants Y.
		const X = 'latch-whole-x' as BlockId;
		const Y = 'latch-whole-y' as BlockId;

		const { release } = await acquireBlockWriteLatches([X, Y]);
		let granted = false;
		void acquireBlockWriteLatch(Y).then(h => { granted = true; h.release(); });
		await delay(20);
		expect(granted, 'a member of the held set must not be handed out mid-hold').to.equal(false);
		release();
		await delay(20);
		expect(granted, 'and must be granted once the hold ends').to.equal(true);
	});

	it('interleaves with the single-latch form without deadlocking, in either arrival order', async () => {
		// `withBlockWriteLatch` takes one latch at a time, so it can never be the cycle's second edge.
		const X = 'latch-mixed-x' as BlockId;
		const Y = 'latch-mixed-y' as BlockId;

		const multi = acquireBlockWriteLatches([X, Y]).then(async (h) => { await delay(5); h.release(); });
		const single = withBlockWriteLatch(Y, async () => { await delay(5); });
		expect(await settles(Promise.all([multi, single]))).to.equal('settled');
	});

	it('release frees every latch and expires every token', async () => {
		const X = 'latch-release-x' as BlockId;
		const Y = 'latch-release-y' as BlockId;

		const { latches, release } = await acquireBlockWriteLatches([X, Y]);
		expect(latches.get(X)!.live).to.equal(true);
		expect(latches.get(Y)!.live).to.equal(true);
		release();

		// Expired: a token stashed past its scope is refused by the storage seam rather than
		// silently writing unlatched.
		expect(latches.get(X)!.live, 'token expired on release').to.equal(false);
		expect(latches.get(Y)!.live, 'token expired on release').to.equal(false);

		// Freed: every id is immediately re-acquirable, singly and as a set.
		expect(await settles(acquireBlockWriteLatch(X).then(h => h.release())), 'X freed').to.equal('settled');
		expect(await settles(acquireBlockWriteLatches([X, Y]).then(h => h.release())), 'both freed').to.equal('settled');
	});

	it('an empty set is a valid, immediately-released hold', async () => {
		// `pend` and `commit` both reach here with whatever block set the request carried, including
		// none — that must be a no-op hold, not a hang or a throw.
		const { latches, release } = await acquireBlockWriteLatches([]);
		expect(latches.size).to.equal(0);
		expect(() => release()).to.not.throw();
	});

	it('release is idempotent, so a `finally` that runs twice does not free a later holder’s latch', async () => {
		const X = 'latch-double-release-x' as BlockId;

		const first = await acquireBlockWriteLatches([X]);
		first.release();

		const second = await acquireBlockWriteLatches([X]);
		first.release();	// the stale hold's second release must not touch `second`
		let third = false;
		void acquireBlockWriteLatches([X]).then(h => { third = true; h.release(); });
		await delay(20);
		expect(third, 'a third acquirer must still be waiting behind the live hold').to.equal(false);
		second.release();
		await delay(20);
		expect(third, 'and be granted once the live hold really releases').to.equal(true);
	});
});
