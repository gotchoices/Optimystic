import type { BlockId, IBlock, Transform, ActionId, ActionRev } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import { createLogger } from './logger.js';

const log = createLogger('storage:mmkv');

/** MMKV storage interface matching react-native-mmkv */
export interface MMKV {
	getString(key: string): string | undefined;
	set(key: string, value: string): void;
	delete(key: string): void;
	getAllKeys(): string[];
	contains(key: string): boolean;
}

export interface MMKVStorageOptions {
	/** The MMKV instance to use */
	mmkv: MMKV;
	/** Optional prefix for all keys to namespace this storage */
	prefix?: string;
}

export class MMKVRawStorage implements IRawStorage {
	private readonly mmkv: MMKV;
	private readonly prefix: string;

	constructor(options: MMKVStorageOptions) {
		this.mmkv = options.mmkv;
		this.prefix = options.prefix ?? 'optimystic:';
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.getJson<BlockMetadata>(this.metadataKey(blockId));
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		this.setJson(this.metadataKey(blockId), metadata);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return this.mmkv.getString(this.revisionKey(blockId, rev)) as ActionId | undefined;
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		this.mmkv.set(this.revisionKey(blockId, rev), actionId);
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.getJson<Transform>(this.pendingKey(blockId, actionId));
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		this.setJson(this.pendingKey(blockId, actionId), transform);
		this.addToPendingIndex(blockId, actionId);
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.mmkv.delete(this.pendingKey(blockId, actionId));
		this.removeFromPendingIndex(blockId, actionId);
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const index = this.getPendingIndex(blockId);
		for (const actionId of index) {
			if (this.mmkv.contains(this.pendingKey(blockId, actionId as ActionId))) {
				yield actionId as ActionId;
			}
		}
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.getJson<Transform>(this.transactionKey(blockId, actionId));
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		this.setJson(this.transactionKey(blockId, actionId), transform);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		const ascending = startRev <= endRev;
		for (let rev = startRev; ascending ? rev <= endRev : rev >= endRev; ascending ? ++rev : --rev) {
			const actionId = await this.getRevision(blockId, rev);
			if (actionId) {
				yield { actionId, rev };
			}
		}
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		return this.getJson<IBlock>(this.materializedKey(blockId, actionId));
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		const key = this.materializedKey(blockId, actionId);
		if (block) {
			this.setJson(key, block);
		} else {
			this.mmkv.delete(key);
		}
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const pendingKey = this.pendingKey(blockId, actionId);
		const content = this.mmkv.getString(pendingKey);
		if (!content) {
			throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
		}
		this.mmkv.set(this.transactionKey(blockId, actionId), content);
		this.mmkv.delete(pendingKey);
		this.removeFromPendingIndex(blockId, actionId);
	}

	private metadataKey(blockId: BlockId): string {
		return `${this.prefix}${blockId}:meta`;
	}

	private revisionKey(blockId: BlockId, rev: number): string {
		return `${this.prefix}${blockId}:rev:${rev}`;
	}

	private pendingKey(blockId: BlockId, actionId: ActionId): string {
		return `${this.prefix}${blockId}:pend:${actionId}`;
	}

	private transactionKey(blockId: BlockId, actionId: ActionId): string {
		return `${this.prefix}${blockId}:trx:${actionId}`;
	}

	private materializedKey(blockId: BlockId, actionId: ActionId): string {
		return `${this.prefix}${blockId}:block:${actionId}`;
	}

	private pendingIndexKey(blockId: BlockId): string {
		return `${this.prefix}${blockId}:pend-idx`;
	}

	private getJson<T>(key: string): T | undefined {
		const value = this.mmkv.getString(key);
		if (!value) return undefined;
		try {
			return JSON.parse(value) as T;
		} catch (err) {
			log('Failed to parse JSON for key %s: %o', key, err);
			return undefined;
		}
	}

	private setJson(key: string, value: unknown): void {
		this.mmkv.set(key, JSON.stringify(value));
	}

	private getPendingIndex(blockId: BlockId): string[] {
		return this.getJson<string[]>(this.pendingIndexKey(blockId)) ?? [];
	}

	private addToPendingIndex(blockId: BlockId, actionId: ActionId): void {
		const index = this.getPendingIndex(blockId);
		if (!index.includes(actionId)) {
			index.push(actionId);
			this.setJson(this.pendingIndexKey(blockId), index);
		}
	}

	private removeFromPendingIndex(blockId: BlockId, actionId: ActionId): void {
		const index = this.getPendingIndex(blockId);
		const filtered = index.filter(id => id !== actionId);
		if (filtered.length !== index.length) {
			this.setJson(this.pendingIndexKey(blockId), filtered);
		}
	}
}

