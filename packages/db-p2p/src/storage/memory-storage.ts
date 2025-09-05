import type { BlockId, IBlock, Transform, TrxId, TrxRev } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";

export class MemoryRawStorage implements IRawStorage {
	private metadata = new Map<BlockId, BlockMetadata>();
	private revisions = new Map<string, TrxId>(); // blockId:rev -> trxId
	private pendingTransactions = new Map<string, Transform>(); // blockId:trxId -> transform
	private transactions = new Map<string, Transform>(); // blockId:trxId -> transform
	private materializedBlocks = new Map<string, IBlock>(); // blockId:trxId -> block

	private getRevisionKey(blockId: BlockId, rev: number): string {
		return `${blockId}:${rev}`;
	}

	private getTransactionKey(blockId: BlockId, trxId: TrxId): string {
		return `${blockId}:${trxId}`;
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.metadata.get(blockId);
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		this.metadata.set(blockId, metadata);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<TrxId | undefined> {
		return this.revisions.get(this.getRevisionKey(blockId, rev));
	}

	async saveRevision(blockId: BlockId, rev: number, trxId: TrxId): Promise<void> {
		this.revisions.set(this.getRevisionKey(blockId, rev), trxId);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<TrxRev> {
		const ascending = startRev <= endRev;
		const actualStart = ascending ? startRev : endRev;
		const actualEnd = ascending ? endRev : startRev;

		const results: TrxRev[] = [];
		for (let rev = actualStart; rev <= actualEnd; rev++) {
			const trxId = this.revisions.get(this.getRevisionKey(blockId, rev));
			if (trxId) {
				results.push({ rev, trxId });
			}
		}

		if (!ascending) {
			results.reverse();
		}

		for (const result of results) {
			yield result;
		}
	}

	async getPendingTransaction(blockId: BlockId, trxId: TrxId): Promise<Transform | undefined> {
		return this.pendingTransactions.get(this.getTransactionKey(blockId, trxId));
	}

	async savePendingTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void> {
		this.pendingTransactions.set(this.getTransactionKey(blockId, trxId), transform);
	}

	async deletePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void> {
		this.pendingTransactions.delete(this.getTransactionKey(blockId, trxId));
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<TrxId> {
		const prefix = `${blockId}:`;
		for (const [key, _] of Array.from(this.pendingTransactions.entries())) {
			if (key.startsWith(prefix)) {
				yield key.substring(prefix.length);
			}
		}
	}

	async getTransaction(blockId: BlockId, trxId: TrxId): Promise<Transform | undefined> {
		return this.transactions.get(this.getTransactionKey(blockId, trxId));
	}

	async saveTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void> {
		this.transactions.set(this.getTransactionKey(blockId, trxId), transform);
	}

	async getMaterializedBlock(blockId: BlockId, trxId: TrxId): Promise<IBlock | undefined> {
		return this.materializedBlocks.get(this.getTransactionKey(blockId, trxId));
	}

	async saveMaterializedBlock(blockId: BlockId, trxId: TrxId, block?: IBlock): Promise<void> {
		const key = this.getTransactionKey(blockId, trxId);
		if (block) {
			this.materializedBlocks.set(key, block);
		} else {
			this.materializedBlocks.delete(key);
		}
	}

	async promotePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void> {
		const key = this.getTransactionKey(blockId, trxId);
		const transform = this.pendingTransactions.get(key);
		if (transform) {
			this.transactions.set(key, transform);
			this.pendingTransactions.delete(key);
		}
	}
}
