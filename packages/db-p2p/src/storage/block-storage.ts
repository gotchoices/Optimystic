import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import { Latches, applyTransform } from "@optimystic/db-core";
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { mergeRanges } from "./helpers.js";
import type { IBlockStorage } from "./i-block-storage.js";

export class BlockStorage implements IBlockStorage {
	constructor(
		private readonly blockId: BlockId,
		private readonly storage: IRawStorage,
		private readonly restoreCallback?: RestoreCallback
	) { }

	async getLatest(): Promise<ActionRev | undefined> {
		const meta = await this.storage.getMetadata(this.blockId);
		return meta?.latest;
	}

	async getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined> {
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			return undefined;
		}

		const targetRev = rev ?? meta.latest?.rev;
		if (targetRev === undefined) {
			throw new Error(`No revision specified and no latest revision exists for block ${this.blockId}`);
		}

		await this.ensureRevision(meta, targetRev);
		return await this.materializeBlock(meta, targetRev);
	}

	async getTransaction(actionId: ActionId): Promise<Transform | undefined> {
		return await this.storage.getTransaction(this.blockId, actionId);
	}

	async getPendingTransaction(actionId: ActionId): Promise<Transform | undefined> {
		return await this.storage.getPendingTransaction(this.blockId, actionId);
	}

	async *listPendingTransactions(): AsyncIterable<ActionId> {
		yield* this.storage.listPendingTransactions(this.blockId);
	}

	async savePendingTransaction(actionId: ActionId, transform: Transform): Promise<void> {
		let meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			meta = { latest: undefined, ranges: [[0]] };
			await this.storage.saveMetadata(this.blockId, meta);
		}
		await this.storage.savePendingTransaction(this.blockId, actionId, transform);
	}

	async deletePendingTransaction(actionId: ActionId): Promise<void> {
		await this.storage.deletePendingTransaction(this.blockId, actionId);
	}

	async *listRevisions(startRev: number, endRev: number): AsyncIterable<ActionRev> {
		yield* this.storage.listRevisions(this.blockId, startRev, endRev);
	}

	async saveMaterializedBlock(actionId: ActionId, block: IBlock | undefined): Promise<void> {
		await this.storage.saveMaterializedBlock(this.blockId, actionId, block);
	}

	async saveRevision(rev: number, actionId: ActionId): Promise<void> {
		await this.storage.saveRevision(this.blockId, rev, actionId);
	}

	async promotePendingTransaction(actionId: ActionId): Promise<void> {
		await this.storage.promotePendingTransaction(this.blockId, actionId);
	}

	async setLatest(latest: ActionRev): Promise<void> {
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			throw new Error(`Block ${this.blockId} not found`);
		}
		meta.latest = latest;
		await this.storage.saveMetadata(this.blockId, meta);
	}

	private async ensureRevision(meta: BlockMetadata, rev: number): Promise<void> {
		if (this.inRanges(rev, meta.ranges)) {
			return;
		}

		const lockId = `BlockStorage.ensureRevision:${this.blockId}`;
		const release = await Latches.acquire(lockId);
		try {
			const currentMeta = await this.storage.getMetadata(this.blockId);
			if (!currentMeta) {
				throw new Error(`Block ${this.blockId} metadata disappeared unexpectedly.`);
			}
			if (this.inRanges(rev, currentMeta.ranges)) {
				return;
			}

			const restored = await this.restoreBlock(rev);
			if (!restored) {
				throw new Error(`Block ${this.blockId} revision ${rev} not found during restore attempt.`);
			}
			await this.saveRestored(restored);

			currentMeta.ranges.unshift(restored.range);
			currentMeta.ranges = mergeRanges(currentMeta.ranges);
			await this.storage.saveMetadata(this.blockId, currentMeta);

		} finally {
			release();
		}
	}

	private async materializeBlock(_meta: BlockMetadata, targetRev: number): Promise<{ block: IBlock, actionRev: ActionRev }> {
		let block: IBlock | undefined;
		let materializedActionRev: ActionRev | undefined;
		const actions: ActionRev[] = [];

		// Find the materialized block
		for await (const actionRev of this.storage.listRevisions(this.blockId, targetRev, 1)) {
			const materializedBlock = await this.storage.getMaterializedBlock(this.blockId, actionRev.actionId);
			if (materializedBlock) {
				block = materializedBlock;
				materializedActionRev = actionRev;
				break;
			} else {
				actions.push(actionRev);
			}
		}

		if (!block || !materializedActionRev) {
			// There is an implicit requirement that there must be a materialization of the block somewhere in it's history.  If the log is truncated, a materialization must be made at the truncation point..
			throw new Error(`Failed to find materialized block ${this.blockId} for revision ${targetRev}`);
		}

		// Apply transforms in reverse order
		for (let i = actions.length - 1; i >= 0; --i) {
			const { actionId } = actions[i]!;
			const transform = await this.storage.getTransaction(this.blockId, actionId);
			if (!transform) {
				throw new Error(`Missing action ${actionId} for block ${this.blockId}`);
			}
			block = applyTransform(block, transform);
		}

		if (!block) {
			throw new Error(`Block ${this.blockId} has been deleted`);
		}
		if (actions.length) {
			await this.storage.saveMaterializedBlock(this.blockId, actions[0]!.actionId, block);
			return { block, actionRev: actions[0]! };
		}
		return { block, actionRev: materializedActionRev };
	}

	private async restoreBlock(rev: number): Promise<BlockArchive | undefined> {
		if (!this.restoreCallback) return undefined;
		return await this.restoreCallback(this.blockId, rev);
	}

	private async saveRestored(archive: BlockArchive) {
		const revisions = Object.entries(archive.revisions)
			.map(([rev, data]) => ({ rev: Number(rev), data }));

		// Save all revisions, actions, and materializations
		for (const { rev, data: { action, block } } of revisions) {
			await Promise.all([
				this.storage.saveRevision(this.blockId, rev, action.actionId),
				this.storage.saveTransaction(this.blockId, action.actionId, action.transform),
				block ? this.storage.saveMaterializedBlock(this.blockId, action.actionId, block) : Promise.resolve()
			]);
		}
	}

	private inRanges(rev: number, ranges: RevisionRange[]): boolean {
		return ranges.some(range =>
			rev >= range[0] && (range[1] === undefined || rev < range[1])
		);
	}
}
