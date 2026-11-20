import { expect } from 'chai';
import type { BlobDurabilityEvent, BlobRef } from '@optimystic/db-core';
import type { BlobRecord } from '../src/blob/blob-record.js';
import { BlobRecordStore } from '../src/blob/blob-record-store.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { SingleMachineBlobService } from '../src/blob/single-machine-blob-service.js';
import type { IKVStore } from '../src/storage/i-kv-store.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';

/** The construction `local-blob-service.spec.ts` uses, over the records `kv` the test then reads. */
function serviceOver(kv: IKVStore): SingleMachineBlobService {
	return new SingleMachineBlobService({ pieces: new MemoryPieceStore(), kv });
}

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* chunks;
}

async function recordOf(kv: IKVStore, ref: BlobRef): Promise<BlobRecord | undefined> {
	return new BlobRecordStore(kv).get(ref);
}

const LOCAL_AND_WHOLE = { quorum: 'local', confirmed: 1, accepting: 1, unconfirmed: [] };

describe('SingleMachineBlobService', () => {
	it('an announce holds the blob at `local` durability, reports it once, and keeps it past its last pin', async () => {
		const kv = new MemoryKVStore();
		const blobs = serviceOver(kv);
		const events: BlobDurabilityEvent[] = [];
		blobs.onDurability(event => events.push(event));
		const { ref } = await blobs.put(streamOf(new Uint8Array([1, 2, 3])), { owner: 'tx-1' });

		await blobs.announce(ref, 'Attachment/blobrefs');

		expect(events.map(event => event.ref)).to.deep.equal([ref]);
		expect(events[0]?.durability).to.deep.equal(LOCAL_AND_WHOLE);
		expect((await blobs.stat(ref)).durability).to.deep.equal(LOCAL_AND_WHOLE);

		// A re-announce finds the stored class and reports nothing further.
		await blobs.announce(ref, 'Attachment/blobrefs');
		expect(events).to.have.length(1);

		// The `owed` hold alone keeps the blob once the pin of the committing transaction goes.
		await blobs.unpin(ref, 'tx-1');
		expect((await recordOf(kv, ref))?.holds.map(hold => hold.kind)).to.deep.equal(['owed']);
		expect(await blobs.stat(ref)).to.deep.include({ locality: 'here', durability: LOCAL_AND_WHOLE });
	});

	it('a scope the wire would refuse takes no hold', async () => {
		const kv = new MemoryKVStore();
		const blobs = serviceOver(kv);
		const { ref } = await blobs.put(streamOf(new Uint8Array([4, 5, 6])), { owner: 'tx-1' });

		const refused = await blobs.announce(ref, '').catch((error: unknown) => error);

		expect(refused).to.be.instanceOf(RangeError);
		expect((await recordOf(kv, ref))?.holds.map(hold => hold.kind)).to.deep.equal(['pin']);
		expect((await blobs.stat(ref)).durability).to.equal(undefined);
	});
});
