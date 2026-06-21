import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import { Latches, applyTransform, hashString } from "@optimystic/db-core";
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { mergeRanges } from "./helpers.js";
import type { IBlockStorage } from "./i-block-storage.js";
import { createLogger } from "../logger.js";

const log = createLogger('block-storage');

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

		// Pending-only state: metadata was seeded by savePendingTransaction but no
		// revision has been committed yet. Treat as "doesn't exist" for the default
		// request path — matches StorageRepo.get()'s contract that undefined => empty.
		if (rev === undefined && meta.latest === undefined) {
			return undefined;
		}

		const targetRev = rev ?? meta.latest!.rev;
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
		log('pend blockId=%s actionId=%s', this.blockId, actionId);
		let meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			meta = { latest: undefined, ranges: [[0]] };
			await this.storage.saveMetadata(this.blockId, meta);
		}
		await this.storage.savePendingTransaction(this.blockId, actionId, transform);
	}

	async deletePendingTransaction(actionId: ActionId): Promise<void> {
		log('cancel blockId=%s actionId=%s', this.blockId, actionId);
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
		log('commit blockId=%s actionId=%s', this.blockId, actionId);
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

	async recover(): Promise<{ reconciled: boolean; latest?: ActionRev }> {
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			return { reconciled: false };
		}

		const currentRev = meta.latest?.rev ?? 0;
		let maxRev = currentRev;
		let maxActionId = meta.latest?.actionId;

		// Probe forward until we hit a gap or a revision whose action is not yet
		// in the committed log (Crash-D2 state — retry-commit owns that advance).
		for (let next = currentRev + 1; ; next++) {
			const actionId = await this.storage.getRevision(this.blockId, next);
			if (actionId === undefined) break;
			const promoted = await this.storage.getTransaction(this.blockId, actionId);
			if (promoted === undefined) break;
			maxRev = next;
			maxActionId = actionId;
		}

		if (maxRev > currentRev && maxActionId !== undefined) {
			const advanced: ActionRev = { rev: maxRev, actionId: maxActionId };
			meta.latest = advanced;
			await this.storage.saveMetadata(this.blockId, meta);
			log('recover blockId=%s advanced latest from rev=%d to rev=%d', this.blockId, currentRev, maxRev);
			return { reconciled: true, latest: advanced };
		}

		return { reconciled: false, latest: meta.latest };
	}

	async saveReplica(block: IBlock, source?: ActionRev): Promise<ActionRev> {
		const rev = source?.rev ?? 1;
		// Deterministic fallback id when the sender carried no revision metadata, so a
		// re-push of the same block resolves to the same (rev, actionId) and stays
		// idempotent. Never random/time-based — that would mint a new revision per retry.
		const actionId = source?.actionId ?? await hashString(`${this.blockId}:${JSON.stringify(block)}`);

		// Serialize the read-modify-write on this block's metadata (mirrors ensureRevision).
		const lockId = `BlockStorage.saveReplica:${this.blockId}`;
		const release = await Latches.acquire(lockId);
		try {
			let meta = await this.storage.getMetadata(this.blockId);

			// Monotonic guard: an equal-or-newer revision is already held. The block is
			// durably present; do not downgrade `latest` or rewrite the metadata.
			if (meta?.latest && meta.latest.rev >= rev) {
				log('replica:skip blockId=%s rev=%d held=%d', this.blockId, rev, meta.latest.rev);
				return meta.latest;
			}

			// Write rev → actionId, the action transform, and the materialized block.
			// `{ insert: block }` satisfies saveRestored's write invariants; on the serving
			// path materializeBlock returns the materialized block directly (single rev), so
			// this transform is never applied — see ticket notes.
			const archive: BlockArchive = {
				blockId: this.blockId,
				revisions: {
					[rev]: {
						action: { actionId, rev, transform: { insert: block } },
						block
					}
				},
				range: [rev, rev + 1]
			};
			await this.saveRestored(archive);

			// Seed metadata when absent, advance latest, and merge the covered range.
			if (!meta) {
				meta = { latest: undefined, ranges: [] };
			}
			meta.latest = { rev, actionId };
			meta.ranges.unshift([rev, rev + 1]);
			meta.ranges = mergeRanges(meta.ranges);
			await this.storage.saveMetadata(this.blockId, meta);

			log('replica:save blockId=%s rev=%d actionId=%s', this.blockId, rev, actionId);
			return meta.latest;
		} finally {
			release();
		}
	}

	async saveDeletion(source: ActionRev): Promise<ActionRev> {
		const { rev, actionId } = source;

		// Share the saveReplica latch: both do a read-modify-write of `meta.latest`, so they must be
		// mutually exclusive on this block to keep the monotonic guard sound.
		const lockId = `BlockStorage.saveReplica:${this.blockId}`;
		const release = await Latches.acquire(lockId);
		try {
			let meta = await this.storage.getMetadata(this.blockId);

			// Monotonic guard: an equal-or-newer revision is already held. Do not downgrade `latest`
			// or rewrite metadata — the tombstone (or a later revision) is already durable.
			if (meta?.latest && meta.latest.rev >= rev) {
				log('deletion:skip blockId=%s rev=%d held=%d', this.blockId, rev, meta.latest.rev);
				return meta.latest;
			}

			// Forward tombstone: a `{ delete: true }` transform and NO materialized block. saveRestored
			// skips materialization when `block` is absent, so the reverse-apply in materializeBlock
			// resolves this revision to an absent block (read-back as undefined).
			const archive: BlockArchive = {
				blockId: this.blockId,
				revisions: {
					[rev]: {
						action: { actionId, rev, transform: { delete: true } }
					}
				},
				range: [rev, rev + 1]
			};
			await this.saveRestored(archive);

			// Seed metadata when absent, advance latest, and merge the covered range.
			if (!meta) {
				meta = { latest: undefined, ranges: [] };
			}
			meta.latest = { rev, actionId };
			meta.ranges.unshift([rev, rev + 1]);
			meta.ranges = mergeRanges(meta.ranges);
			await this.storage.saveMetadata(this.blockId, meta);

			log('deletion:save blockId=%s rev=%d actionId=%s', this.blockId, rev, actionId);
			return meta.latest;
		} finally {
			release();
		}
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

	private async materializeBlock(_meta: BlockMetadata, targetRev: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined> {
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
			// The reverse-apply collapsed to a tombstone (a `{ delete: true }` revision) — the block
			// is absent at this revision, not corrupt. Read it back as undefined (matching getBlock's
			// "no materialized content" contract) rather than throwing. The genuine-truncation throw
			// ("Failed to find materialized block") above still fires when no materialization exists.
			return undefined;
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
