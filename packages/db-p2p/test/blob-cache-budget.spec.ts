/**
 * Ticket: feat-blob-cached-copies-stay-within-a-budget (docs/blobs.md §Lifetime).
 *
 * The blobs a machine keeps only because it read them are evicted, least recently read first, once
 * they take more space than the budget allows — and never while one of them is being read. These two
 * specs run `BlobCacheBudget` over a real `LocalBlobService`, so what they pin is the whole path: the
 * enumeration of cache-only records, the ordering, the conditional hold removal, and the piece sweep
 * that follows it.
 */

import { expect } from 'chai';
import { buildBlob, rootPieceId, type BlobRef, type PieceId } from '@optimystic/db-core';
import { BlobCacheBudget } from '../src/blob/cache-budget.js';
import { DEFAULT_BLOB_OWNER, type BlobRecord } from '../src/blob/blob-record.js';
import { BlobRecordStore } from '../src/blob/blob-record-store.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import type { IPieceStore } from '../src/blob/piece-store.js';
import { createLogger } from '../src/logger.js';
import type { IKVStore } from '../src/storage/i-kv-store.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';

/** Larger than one 256 KiB piece, so each blob is a root list piece over two data pieces. */
const BLOB_BYTES = 300 * 1024;

/** A service whose scheduled sweeps never fire, so the only sweeps in a test are the budget's. */
function serviceOver(pieces: IPieceStore, kv: IKVStore): LocalBlobService {
	return new LocalBlobService({ pieces, kv, setTimer: () => () => undefined });
}

function budgetOver(service: LocalBlobService, budgetBytes: number): BlobCacheBudget {
	return new BlobCacheBudget({ records: service, budgetBytes, log: createLogger('blob:reclaim') });
}

/** Deterministic bytes that differ by `seed`, so no two blobs here share a piece. */
function bytesOf(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed * 2654435761 >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* chunks;
}

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const read: Uint8Array[] = [];
	for await (const chunk of chunks) {
		read.push(chunk);
	}
	const whole = new Uint8Array(read.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of read) {
		whole.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return whole;
}

async function recordOf(kv: IKVStore, ref: BlobRef): Promise<BlobRecord | undefined> {
	return new BlobRecordStore(kv).get(ref);
}

async function listed(pieces: IPieceStore): Promise<PieceId[]> {
	const ids: PieceId[] = [];
	for await (const id of pieces.list()) {
		ids.push(id);
	}
	return ids;
}

/** Every piece id of the blob `content` would build, without storing any of them. */
async function pieceIdsOf(content: Uint8Array): Promise<PieceId[]> {
	const ids: PieceId[] = [];
	await buildBlob(streamOf(content), { put: async id => { ids.push(id); } });
	return ids;
}

/**
 * Adds the `cached` hold a fetch for a read would take, with `lastReadAt` as if that read happened
 * then. Through a `BlobRecordStore` over the same key-value store, as `local-blob-service.spec.ts`
 * reads records back: the service takes this hold only from inside a fetch.
 */
async function holdCachedAt(kv: IKVStore, ref: BlobRef, lastReadAt: number): Promise<void> {
	await new BlobRecordStore(kv).update(ref, current => {
		if (current === undefined) {
			throw new Error(`no record for ${ref}`);
		}
		return { ...current, lastReadAt, holds: [...current.holds, { kind: 'cached', at: lastReadAt }] };
	});
}

/** A blob held by a `cached` hold alone, the way a read that had to fetch leaves one. */
async function cacheOnlyBlob(service: LocalBlobService, kv: IKVStore, seed: number, lastReadAt: number): Promise<{ ref: BlobRef; content: Uint8Array }> {
	const content = bytesOf(BLOB_BYTES, seed);
	const { ref } = await service.put(streamOf(content));
	await holdCachedAt(kv, ref, lastReadAt);
	await service.unpin(ref, DEFAULT_BLOB_OWNER);
	return { ref, content };
}

describe('BlobCacheBudget', () => {
	it('evicts the least recently read cache-only blobs until the cache is within budget', async () => {
		const pieces = new MemoryPieceStore();
		const kv = new MemoryKVStore();
		const service = serviceOver(pieces, kv);
		// Read at 1, 2, 3 and 4 ms past the epoch: four cache-only blobs, oldest first.
		const cacheOnly = [
			await cacheOnlyBlob(service, kv, 1, 1),
			await cacheOnlyBlob(service, kv, 2, 2),
			await cacheOnlyBlob(service, kv, 3, 3),
			await cacheOnlyBlob(service, kv, 4, 4),
		];
		// The least recently read blob of all, and the one the budget may not touch: it is cached AND pinned.
		const pinnedContent = bytesOf(BLOB_BYTES, 5);
		const { ref: pinnedRef } = await service.put(streamOf(pinnedContent));
		await holdCachedAt(kv, pinnedRef, 0);

		// 700 KiB holds two of the four 300 KiB blobs, so the two oldest go.
		const enforcement = await budgetOver(service, 700 * 1024).enforce();

		expect(enforcement.cachedBytes).to.equal(4 * BLOB_BYTES);
		expect(enforcement.skippedInUse).to.equal(0);
		expect(enforcement.evicted).to.deep.equal([cacheOnly[0]!.ref, cacheOnly[1]!.ref]);

		for (const evicted of cacheOnly.slice(0, 2)) {
			expect(await recordOf(kv, evicted.ref), `record of ${evicted.ref}`).to.equal(undefined);
			expect(await service.stat(evicted.ref)).to.deep.include({ locality: 'unknown', heldBytes: 0 });
			for (const id of await pieceIdsOf(evicted.content)) {
				expect(await pieces.has(id), `piece ${id} of the evicted ${evicted.ref}`).to.equal(false);
			}
		}
		// The two newer cache-only blobs and the pinned one — which is cached, and the least recently
		// read of all — still read back whole from this machine alone.
		for (const kept of [...cacheOnly.slice(2), { ref: pinnedRef, content: pinnedContent }]) {
			expect(await readAll(service.read(kept.ref, { from: 'here' })), `kept ${kept.ref}`).to.deep.equal(kept.content);
		}
	});

	it('does not evict a blob being read, and evicts it once the read ends', async () => {
		const pieces = new MemoryPieceStore();
		const kv = new MemoryKVStore();
		const service = serviceOver(pieces, kv);
		const reading = await cacheOnlyBlob(service, kv, 1, 1);
		const other = await cacheOnlyBlob(service, kv, 2, 2);
		// Budget 0: every cache-only blob not in use goes, so what is under test is the skip alone.
		const budget = budgetOver(service, 0);

		const chunks = service.read(reading.ref, { from: 'here' })[Symbol.asyncIterator]();
		expect((await chunks.next()).done).to.equal(false);

		const held = await budget.enforce();

		expect(held.evicted).to.deep.equal([other.ref]);
		expect(held.skippedInUse).to.equal(1);
		expect(await recordOf(kv, reading.ref)).to.not.equal(undefined);
		expect(await pieces.has(rootPieceId(reading.ref))).to.equal(true);

		while (!(await chunks.next()).done) {
			// Drain the rest, which runs the read's `finally` and releases its use.
		}
		const released = await budget.enforce();

		expect(released.evicted).to.deep.equal([reading.ref]);
		expect(released.skippedInUse).to.equal(0);
		expect(await recordOf(kv, reading.ref)).to.equal(undefined);
		expect(await listed(pieces)).to.deep.equal([]);
	});
});
