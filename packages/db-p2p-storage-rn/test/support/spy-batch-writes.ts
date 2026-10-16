import type { LevelDBLike, LevelDBWriteBatchLike, LevelDBWriteOptions } from '../../src/leveldb-like.js';

/** One `batch().write(...)` the handle was asked for: whether it was synced, and the tag byte of every key it touched, ascending and distinct. */
export interface BatchWrite {
	readonly sync: boolean;
	readonly tags: readonly number[];
}

export interface SpyBatchWritesOptions {
	/** What the spied handle reports for `canSync`; the real handle's by default. `false` presents the phone case over a binding that can sync. */
	canSync?: boolean;
}

/**
 * The handle with every batch write recorded, which is all a test can say about syncing:
 * `classic-level` passes the flag to LevelDB and nothing here cuts the power. The tags say which
 * stores a write covered — the journal's alone for an append, the data tags and the journal for an
 * apply. Reads and iterators go straight to the real handle. A write asked to sync on a handle
 * presented as unable throws, as the `rn-leveldb` adapter does, so a caller that forgot to check
 * `canSync` is caught here too.
 */
export function spyBatchWrites(db: LevelDBLike, options: SpyBatchWritesOptions = {}): { db: LevelDBLike; writes: BatchWrite[] } {
	const writes: BatchWrite[] = [];
	const canSync = options.canSync ?? db.canSync;
	const spied: LevelDBLike = {
		canSync,
		get: key => db.get(key),
		iterator: iteratorOptions => db.iterator(iteratorOptions),
		close: () => db.close(),
		batch: () => {
			const inner = db.batch();
			const tags = new Set<number>();
			const batch: LevelDBWriteBatchLike = {
				put(key, value) {
					tags.add(key[0]!);
					inner.put(key, value);
					return batch;
				},
				delete(key) {
					tags.add(key[0]!);
					inner.delete(key);
					return batch;
				},
				async write(writeOptions?: LevelDBWriteOptions) {
					const sync = writeOptions?.sync === true;
					writes.push({ sync, tags: [...tags].sort((a, b) => a - b) });
					if (sync && !canSync) throw new Error('a sync was asked of a handle that cannot sync');
					await inner.write(writeOptions);
				},
			};
			return batch;
		},
	};
	return { db: spied, writes };
}
