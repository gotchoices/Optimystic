import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";

export class MemoryRawStorage implements IRawStorage {
	private metadata = new Map<BlockId, BlockMetadata>();
	private revisions = new Map<string, ActionId>(); // blockId:rev -> actionId
	private pendingActions = new Map<string, Transform>(); // blockId:actionId -> transform
	private actions = new Map<string, Transform>(); // blockId:actionId -> transform
	private materializedBlocks = new Map<string, IBlock>(); // blockId:actionId -> block

	private getRevisionKey(blockId: BlockId, rev: number): string {
		return `${blockId}:${rev}`;
	}

	private getActionKey(blockId: BlockId, actionId: ActionId): string {
		return `${blockId}:${actionId}`;
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.metadata.get(blockId);
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		this.metadata.set(blockId, metadata);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return this.revisions.get(this.getRevisionKey(blockId, rev));
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		this.revisions.set(this.getRevisionKey(blockId, rev), actionId);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		const ascending = startRev <= endRev;
		const actualStart = ascending ? startRev : endRev;
		const actualEnd = ascending ? endRev : startRev;

		const results: ActionRev[] = [];
		for (let rev = actualStart; rev <= actualEnd; rev++) {
			const actionId = this.revisions.get(this.getRevisionKey(blockId, rev));
			if (actionId) {
				results.push({ rev, actionId });
			}
		}

		if (!ascending) {
			results.reverse();
		}

		for (const result of results) {
			yield result;
		}
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.pendingActions.get(this.getActionKey(blockId, actionId));
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		// Clone transform to prevent external modifications from affecting stored data
		this.pendingActions.set(this.getActionKey(blockId, actionId), structuredClone(transform));
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.pendingActions.delete(this.getActionKey(blockId, actionId));
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const prefix = `${blockId}:`;
		for (const [key] of Array.from(this.pendingActions.entries())) {
			if (key.startsWith(prefix)) {
				yield key.substring(prefix.length);
			}
		}
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.actions.get(this.getActionKey(blockId, actionId));
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		this.actions.set(this.getActionKey(blockId, actionId), transform);
	}

	/**
	 * Retrieves a materialized block at a specific revision.
	 *
	 * @pitfall **MUST return a clone** - `applyTransform()` mutates blocks in place.
	 * If we return the stored reference, mutations corrupt ALL revisions that share
	 * the same underlying object.
	 * @see docs/internals.md "Storage Returns References" pitfall
	 */
	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		const block = this.materializedBlocks.get(this.getActionKey(blockId, actionId));
		// Clone to prevent external mutations from affecting stored data
		return block ? structuredClone(block) : undefined;
	}

	/**
	 * Stores a materialized block at a specific revision.
	 *
	 * @pitfall **MUST store a clone** - callers may continue mutating the block after saving.
	 * If we store the reference, those mutations corrupt the stored data.
	 * @see docs/internals.md "Storage Returns References" pitfall
	 */
	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		const key = this.getActionKey(blockId, actionId);
		if (block) {
			// Clone to prevent external mutations from affecting stored data
			this.materializedBlocks.set(key, structuredClone(block));
		} else {
			this.materializedBlocks.delete(key);
		}
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		const key = this.getActionKey(blockId, actionId);
		const transform = this.pendingActions.get(key);
		if (transform) {
			this.actions.set(key, transform);
			this.pendingActions.delete(key);
		}
	}
}
