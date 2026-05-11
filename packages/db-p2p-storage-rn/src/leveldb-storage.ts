import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import { drain, type LevelDBLike } from './leveldb-like.js';
import {
	TAG_PENDING,
	actionIdFromKey,
	blockEnvelopeRange,
	materializedKey,
	metadataKey,
	pendingKey,
	revisionFromKey,
	revisionKey,
	transactionKey,
} from './keys.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:leveldb');

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * LevelDB-backed `IRawStorage` implementation for React Native peers.
 *
 * All data lives in a single LevelDB database; per-store partitioning is by a
 * leading tag byte (see `./keys.ts`). `listRevisions` and
 * `listPendingTransactions` use range iterators with explicit bounds, drained
 * into an array before yielding (same rationale as the IndexedDB / SQLite
 * backends — a native iterator must not stay open across consumer awaits).
 *
 * `promotePendingTransaction` runs as a single `WriteBatch`, making the
 * pending → committed move atomic against crashes — unlike the prior MMKV
 * adapter, which had to issue a separate `set` and `remove` plus update a
 * JSON-encoded pending index.
 */
export class LevelDBRawStorage implements IRawStorage {
	constructor(private readonly db: LevelDBLike) {}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		const bytes = await this.db.get(metadataKey(blockId));
		if (!bytes) return undefined;
		return JSON.parse(textDecoder.decode(bytes)) as BlockMetadata;
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.db.put(metadataKey(blockId), textEncoder.encode(JSON.stringify(metadata)));
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		const bytes = await this.db.get(revisionKey(blockId, rev));
		if (!bytes) return undefined;
		return textDecoder.decode(bytes) as ActionId;
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.db.put(revisionKey(blockId, rev), textEncoder.encode(actionId));
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		const ascending = startRev <= endRev;
		const lo = ascending ? startRev : endRev;
		const hi = ascending ? endRev : startRev;
		// `revisionKey(blockId, hi)` is exactly the inclusive upper bound; LevelDB
		// uses exclusive `lt`, so request `lte` via `lt = key(hi)+0x01` would
		// require an extra byte. Easier: use `lt = revisionKey(blockId, hi+1)`.
		const gte = revisionKey(blockId, lo);
		const lt = revisionKey(blockId, hi + 1);
		const entries = await drain(this.db.iterator({ gte, lt, reverse: !ascending }));
		for (const [key, value] of entries) {
			yield {
				rev: revisionFromKey(key),
				actionId: textDecoder.decode(value) as ActionId,
			};
		}
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const bytes = await this.db.get(pendingKey(blockId, actionId));
		if (!bytes) return undefined;
		return JSON.parse(textDecoder.decode(bytes)) as Transform;
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.db.put(pendingKey(blockId, actionId), textEncoder.encode(JSON.stringify(transform)));
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.delete(pendingKey(blockId, actionId));
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const range = blockEnvelopeRange(TAG_PENDING, blockId);
		const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
		for (const [key] of entries) {
			yield actionIdFromKey(key, blockId) as ActionId;
		}
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const bytes = await this.db.get(transactionKey(blockId, actionId));
		if (!bytes) return undefined;
		return JSON.parse(textDecoder.decode(bytes)) as Transform;
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.db.put(transactionKey(blockId, actionId), textEncoder.encode(JSON.stringify(transform)));
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		const bytes = await this.db.get(materializedKey(blockId, actionId));
		if (!bytes) return undefined;
		return JSON.parse(textDecoder.decode(bytes)) as IBlock;
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		const key = materializedKey(blockId, actionId);
		if (block) {
			await this.db.put(key, textEncoder.encode(JSON.stringify(block)));
		} else {
			await this.db.delete(key);
		}
	}

	async getApproximateBytesUsed(): Promise<number> {
		try {
			let total = 0;
			const iter = this.db.iterator();
			try {
				while (true) {
					const entry = await iter.next();
					if (!entry) break;
					total += entry[0].byteLength + entry[1].byteLength;
				}
			} finally {
				await iter.close();
			}
			return total;
		} catch (err) {
			log('getApproximateBytesUsed iterator failed: %o', err);
			return 0;
		}
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pKey = pendingKey(blockId, actionId);
		const value = await this.db.get(pKey);
		if (!value) {
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		const tKey = transactionKey(blockId, actionId);
		await this.db
			.batch()
			.put(tKey, value)
			.delete(pKey)
			.write();
	}
}
