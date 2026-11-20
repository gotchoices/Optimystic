import { isBlobRef, parseBlobRef, type BlobRef } from '@optimystic/db-core';
import { KeyedSerialQueue } from '../keyed-serial-queue.js';
import { createLogger } from '../logger.js';
import type { IKVStore } from '../storage/i-kv-store.js';
import { BLOB_RECORD_KEY_PREFIX, blobRecordKey, decodeBlobRecord, encodeBlobRecord, type BlobRecord } from './blob-record.js';

const log = createLogger('blob:store');

/** What one `update` did. Both absent: there was no record and none was written. */
export interface BlobRecordChange {
	readonly before?: BlobRecord;
	readonly after?: BlobRecord;
}

/**
 * The node's blob records (docs/blobs.md §The local store), one JSON value per blob in the node's
 * key-value store under `BLOB_RECORD_KEY_PREFIX`.
 */
export class BlobRecordStore {
	/** Its own per-ref promise chain rather than db-core's `Latches`: `block-latch.ts` documents that
	 *  `Latches.acquire(` has exactly one call site in this package, and one node's one service needs
	 *  no more than a per-instance chain. An entry is removed when its chain drains. */
	private readonly queue = new KeyedSerialQueue();

	constructor(private readonly kv: IKVStore) {}

	/** The record of `ref`, or undefined. Throws BlobRecordFormatError for a malformed value. */
	async get(ref: BlobRef): Promise<BlobRecord | undefined> {
		const text = await this.kv.get(keyOf(ref));
		return text === undefined ? undefined : decodeBlobRecord(ref, text);
	}

	/** Every ref with a record. A key under the prefix whose suffix is not a reference (`isBlobRef`) is logged (`record:bad-key`) and skipped. */
	async listRefs(): Promise<BlobRef[]> {
		const refs: BlobRef[] = [];
		for (const key of await this.kv.list(BLOB_RECORD_KEY_PREFIX)) {
			const suffix = key.slice(BLOB_RECORD_KEY_PREFIX.length);
			if (isBlobRef(suffix)) {
				refs.push(suffix);
			} else {
				log('record:bad-key key=%s', key);
			}
		}
		return refs;
	}

	/**
	 * Read, apply `change`, write: serialized per ref, so concurrent changes to one blob never lose
	 * one another. `change` returns the next record, or `undefined` to delete it; a record with no
	 * holds is deleted. Nothing is written when the encoding is unchanged, and nothing is deleted
	 * when there was no record. `change` must not modify the record it is given. A `change` that
	 * throws rejects this update and leaves the chain usable for the next one; so does a next record
	 * the decoder would refuse, which is never written, since a record nothing can read stops every
	 * sweep.
	 */
	update(ref: BlobRef, change: (current: BlobRecord | undefined) => BlobRecord | undefined): Promise<BlobRecordChange> {
		return this.queue.run(ref, () => this.apply(ref, keyOf(ref), change));
	}

	/** `kv.flush?.()`; a store without `flush` is durable when its writes resolve. */
	async flush(): Promise<void> {
		await this.kv.flush?.();
	}

	private async apply(ref: BlobRef, key: string, change: (current: BlobRecord | undefined) => BlobRecord | undefined): Promise<BlobRecordChange> {
		const text = await this.kv.get(key);
		const before = text === undefined ? undefined : decodeBlobRecord(ref, text);
		const next = change(before);
		if (next === undefined || next.holds.length === 0) {
			if (before !== undefined) {
				await this.kv.delete(key);
			}
			return { before };
		}
		const encoded = encodeBlobRecord(next);
		if (encoded !== text) {
			decodeBlobRecord(ref, encoded);
			await this.kv.set(key, encoded);
		}
		return { before, after: next };
	}
}

/** The record key of `ref`, refusing a string that is not a reference: a record under such a key is one `listRefs` skips, so no sweep would see its holds. */
function keyOf(ref: BlobRef): string {
	return blobRecordKey(parseBlobRef(ref));
}
