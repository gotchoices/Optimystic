/**
 * Ticket: feat-blob-owed-ledger-and-durability-classes.
 *
 * `OwedBlobLedger` is the durable half of "whose copy of this blob is still owed": the copy drain
 * reads it on every pass and must find what a restart left. These specs pin the ledger's own rules
 * over the in-memory key-value store — what a second entry for one ref keeps, what a confirmed
 * holder adds, the scan's order, the lazily loaded size index, and what a key holding nonsense reads
 * as. The drain's use of it lives in the drain's own spec.
 */

import { expect } from 'chai';
import { BlobRefError, buildBlob, type BlobRef, type BlobScope } from '@optimystic/db-core';
import { OWED_BLOB_KEY_PREFIX, OwedBlobLedger } from '../src/blob/owed-blob-ledger.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { streamOf } from './support/blob-mesh.js';
import { captureLog, hasTag } from './support/capture-log.js';

const SCOPE: BlobScope = 'app/photos/blobrefs';
const OTHER_SCOPE: BlobScope = 'app/drafts/blobrefs';

/** A canonical reference, from bytes nothing stores: the ledger holds references, not pieces. */
async function refOf(seed: number): Promise<BlobRef> {
	const { ref } = await buildBlob(streamOf(new Uint8Array([seed, seed, seed])), { put: async () => undefined });
	return ref;
}

/** Answers `list` in the opposite order to insertion, so the scan's sort is what the order comes from. */
class ReversedListKVStore extends MemoryKVStore {
	override async list(prefix: string): Promise<string[]> {
		return (await super.list(prefix)).reverse();
	}
}

/** A ledger whose `recordedAt` steps by one per entry, so `list`'s order is checkable. */
function ledgerOver(kv: MemoryKVStore, firstAt = 1_000): OwedBlobLedger {
	let at = firstAt;
	return new OwedBlobLedger(kv, { now: () => at++ });
}

describe('OwedBlobLedger', () => {
	it('records an entry and reads it back', async () => {
		const ref = await refOf(1);
		const ledger = ledgerOver(new MemoryKVStore());
		const recorded = await ledger.record(ref, SCOPE);
		expect(recorded).to.deep.equal({ ref, scope: SCOPE, holders: [], recordedAt: 1_000 });
		expect(await ledger.get(ref)).to.deep.equal(recorded);
	});

	it('a second record replaces the scope and keeps the holders and the recorded time', async () => {
		const ref = await refOf(2);
		const ledger = ledgerOver(new MemoryKVStore());
		await ledger.record(ref, SCOPE);
		await ledger.addHolders(ref, ['peer-b']);
		const again = await ledger.record(ref, OTHER_SCOPE);
		expect(again).to.deep.equal({ ref, scope: OTHER_SCOPE, holders: ['peer-b'], recordedAt: 1_000 });
	});

	it('adds each holder once and answers the stored entry', async () => {
		const ref = await refOf(3);
		const ledger = ledgerOver(new MemoryKVStore());
		await ledger.record(ref, SCOPE);
		await ledger.addHolders(ref, ['peer-b', 'peer-c', 'peer-b']);
		const added = await ledger.addHolders(ref, ['peer-c', 'peer-d']);
		expect(added?.holders).to.deep.equal(['peer-b', 'peer-c', 'peer-d']);
		expect((await ledger.get(ref))?.holders).to.deep.equal(['peer-b', 'peer-c', 'peer-d']);
	});

	it('never creates an entry: a deleted entry stays deleted', async () => {
		const ref = await refOf(4);
		const ledger = ledgerOver(new MemoryKVStore());
		await ledger.record(ref, SCOPE);
		await ledger.delete(ref);
		expect(await ledger.addHolders(ref, ['peer-b'])).to.equal(undefined);
		expect(await ledger.get(ref)).to.equal(undefined);
		expect(await ledger.size()).to.equal(0);
	});

	it('lists oldest-recorded first, whatever order the store answers in', async () => {
		const [first, second, third] = [await refOf(5), await refOf(6), await refOf(7)];
		const ledger = ledgerOver(new ReversedListKVStore());
		await ledger.record(first, SCOPE);
		await ledger.record(second, SCOPE);
		await ledger.record(third, SCOPE);
		expect((await ledger.list()).map(entry => entry.ref)).to.deep.equal([first, second, third]);
	});

	it('sizes from the index, after a mutation and after a restart over the same store', async () => {
		const [a, b] = [await refOf(8), await refOf(9)];
		const kv = new MemoryKVStore();
		const ledger = ledgerOver(kv);
		await ledger.record(a, SCOPE);
		await ledger.record(b, SCOPE);
		expect(await ledger.size()).to.equal(2);
		await ledger.delete(a);
		expect(await ledger.size()).to.equal(1);
		// A second ledger over the same store is what a restart is: its index loads from the entries.
		const restarted = ledgerOver(kv);
		expect(await restarted.size()).to.equal(1);
		expect((await restarted.get(b))?.scope).to.equal(SCOPE);
	});

	it('reads a key holding non-entry text as absent and leaves it for the next record', async () => {
		const ref = await refOf(10);
		const kv = new MemoryKVStore();
		const key = `${OWED_BLOB_KEY_PREFIX}${ref}`;
		await kv.set(key, 'not an entry');
		const ledger = ledgerOver(kv);
		const captured = await captureLog('blob:store', async () => {
			expect(await ledger.get(ref)).to.equal(undefined);
			expect(await ledger.list()).to.deep.equal([]);
		});
		expect(hasTag(captured, 'read:malformed')).to.equal(true);
		expect(await kv.get(key)).to.equal('not an entry');
		await ledger.record(ref, SCOPE);
		expect((await ledger.get(ref))?.scope).to.equal(SCOPE);
	});

	it('serializes a record and a holder confirmation for one ref', async () => {
		const ref = await refOf(11);
		const ledger = ledgerOver(new MemoryKVStore());
		await ledger.record(ref, SCOPE);
		const [, added] = await Promise.all([
			ledger.record(ref, OTHER_SCOPE),
			ledger.addHolders(ref, ['peer-b']),
		]);
		// Whichever ran second, neither write lost the other's: one entry, one scope, one holder.
		expect(added?.holders).to.deep.equal(['peer-b']);
		expect(await ledger.get(ref)).to.deep.equal({ ref, scope: OTHER_SCOPE, holders: ['peer-b'], recordedAt: 1_000 });
	});

	it('refuses a reference it could not store under a listable key', async () => {
		const kv = new MemoryKVStore();
		const ledger = ledgerOver(kv);
		const refused = await ledger.record('not-a-reference' as BlobRef, SCOPE).catch((error: unknown) => error);
		expect(refused).to.be.instanceOf(BlobRefError);
		expect(await kv.list(OWED_BLOB_KEY_PREFIX)).to.deep.equal([]);
	});
});
