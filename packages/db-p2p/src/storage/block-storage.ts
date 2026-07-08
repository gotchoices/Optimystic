import type { BlockId, IBlock, Transform, ActionId, ActionRev, ActionTransform } from "@optimystic/db-core";
import { Latches, applyTransform, hashString } from "@optimystic/db-core";
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { mergeRanges } from "./helpers.js";
import type { IBlockStorage } from "./i-block-storage.js";
import { createLogger } from "../logger.js";

const log = createLogger('block-storage');

/**
 * Default checkpoint cadence: a full materialization is retained at every `CHECKPOINT_INTERVAL`th
 * revision (plus the tip and each range floor). This bounds the maximum replay depth for any read
 * to at most `CHECKPOINT_INTERVAL` forward transforms. See {@link BlockStorage.pruneSupersededMaterialization}.
 */
const CHECKPOINT_INTERVAL = 32;

export class BlockStorage implements IBlockStorage {
	constructor(
		private readonly blockId: BlockId,
		private readonly storage: IRawStorage,
		private readonly restoreCallback?: RestoreCallback,
		/**
		 * Revisions where `rev % checkpointInterval === 0` retain a full materialization even after they
		 * stop being the tip. Optional (default {@link CHECKPOINT_INTERVAL}); tests inject a small value
		 * to exercise sweeping without committing 32+ revisions.
		 */
		private readonly checkpointInterval: number = CHECKPOINT_INTERVAL
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
			// A freshly-pended block holds NO committed revision, so it can reconstruct
			// nothing yet: seed empty ranges. The first commit anchors an OPEN-ENDED span at
			// the earliest held rev E ([E, +inf)); later commits/recover merge into it via
			// setLatest/recover. Seeding open-ended `[[0]]` would falsely claim coverage of the
			// un-held revs below E and disable ensureRevision's restore path.
			meta = { latest: undefined, ranges: [] };
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

	async pruneSupersededMaterialization(prior: ActionRev): Promise<void> {
		const meta = await this.storage.getMetadata(this.blockId);
		// No metadata / no committed tip yet ⇒ nothing has superseded `prior`; leave it.
		if (!meta || meta.latest === undefined) {
			return;
		}
		// `prior` is the PRIOR latest, so it shares the (latest) range containing meta.latest.rev — its
		// floor is that span's start. Retain if it is the tip, that floor, or a checkpoint rev.
		const rangeFloor = this.rangeFloorOf(meta.latest.rev, meta.ranges);
		if (this.isRetainedRev(prior.rev, meta.latest.rev, rangeFloor)) {
			return;
		}
		// Redundant: `prior`'s forward transform is retained, so it stays reconstructible by replay from
		// the nearest retained materialization below it. Delete routes to the driver's deleteMaterialized;
		// a no-op at the driver when `prior.rev` carried no materialization (e.g. a tombstone rev).
		await this.storage.saveMaterializedBlock(this.blockId, prior.actionId, undefined);
		log('prune blockId=%s rev=%d actionId=%s', this.blockId, prior.rev, prior.actionId);
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
		// Capture the prior latest rev BEFORE overwriting: coverage anchors to the earliest held rev.
		const prevRev = meta.latest?.rev;
		meta.latest = latest;
		// NOTE: re-sorts (mergeRanges) the whole ranges array on every commit; if a block ever
		// accumulates many disjoint ranges and commits show as slow, keep a running merged structure.
		// `getBlock(r)` is served by materializeBlock's DESCENDING walk (highest committed rev <= r).
		// Once this node holds the chain from the block's earliest committed rev E, EVERY rev >= E is
		// serveable locally: a read at any r >= E resolves to the highest committed rev <= r (at worst
		// the latest, which is materialized), so coverage is the OPEN-ENDED span [E, +inf) — not the
		// single point [L, L+1) (which wrongly missed reads above L, e.g. a block read at the collection
		// tip after a later commit touched only its siblings) and not [0, +inf) (which wrongly claimed
		// the un-held revs below E). Claim open-ended from the prior latest (>= E via merge); the first
		// commit (prevRev undefined) anchors the span at E = L. mergeRanges folds it into the existing
		// [E, +inf). Only revs BELOW E miss inRanges, which is exactly the genuine-gap/restore case.
		// Range + latest advance in one saveMetadata write (atomic under the commit latch), so a crash
		// before this call advances neither.
		meta.ranges.unshift([prevRev ?? latest.rev]);
		meta.ranges = mergeRanges(meta.ranges);
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
			// The lost setLatest would have merged each recovered revision's range; redo that
			// here. Open-ended from currentRev+1 (see setLatest): every rev in (currentRev, maxRev]
			// was verified present in the committed log above, and any rev > maxRev resolves via the
			// descending walk to maxRev's materialization — so [currentRev+1, +inf) is honest. It joins
			// the prior [E, currentRev+1) (from the earlier setLatest) into one open-ended [E, +inf).
			meta.ranges.unshift([currentRev + 1]);
			meta.ranges = mergeRanges(meta.ranges);
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

		// Replica revision carries the materialized block. `{ insert: block }` satisfies saveRestored's
		// write invariants; on the serving path materializeBlock returns the materialized block directly
		// (single rev), so this transform is never applied — see ticket notes.
		return await this.saveForwardRevision(
			rev,
			actionId,
			{ action: { actionId, rev, transform: { insert: block } }, block },
			'replica'
		);
	}

	async saveDeletion(source: ActionRev): Promise<ActionRev> {
		const { rev, actionId } = source;

		// Forward tombstone: a `{ delete: true }` transform and NO materialized block. saveRestored
		// skips materialization when `block` is absent, so the reverse-apply in materializeBlock
		// resolves this revision to an absent block (read-back as undefined).
		return await this.saveForwardRevision(
			rev,
			actionId,
			{ action: { actionId, rev, transform: { delete: true } } },
			'deletion'
		);
	}

	/**
	 * Shared forward-write path for saveReplica and saveDeletion. Both append a single new revision
	 * that ADVANCES `latest` (never rewrites history): acquire the block's metadata latch, apply the
	 * monotonic guard, saveRestored a one-revision archive, then seed/advance/merge metadata.
	 *
	 * The only per-caller difference is the revision `body`: a replica carries `{ insert: block }`
	 * plus the materialized `block`; a deletion carries `{ delete: true }` and no block. `rev` and
	 * `actionId` are passed alongside `body` because the guard and the `latest` advance need them
	 * independently of the archive body.
	 */
	private async saveForwardRevision(
		rev: number,
		actionId: ActionId,
		body: { action: ActionTransform; block?: IBlock },
		logLabel: 'replica' | 'deletion'
	): Promise<ActionRev> {
		// Serialize the read-modify-write on this block's metadata (mirrors ensureRevision). saveReplica
		// and saveDeletion deliberately SHARE this one lock id (keyed `saveReplica`, NOT per-method):
		// both do a read-modify-write of `meta.latest`, so they must be mutually exclusive on this block
		// to keep the monotonic guard sound against a concurrent replica+deletion.
		const lockId = `BlockStorage.saveReplica:${this.blockId}`;
		const release = await Latches.acquire(lockId);
		try {
			let meta = await this.storage.getMetadata(this.blockId);

			// Monotonic guard: an equal-or-newer revision is already held. The block (or tombstone) is
			// durably present; do not downgrade `latest` or rewrite the metadata.
			if (meta?.latest && meta.latest.rev >= rev) {
				log('%s:skip blockId=%s rev=%d held=%d', logLabel, this.blockId, rev, meta.latest.rev);
				return meta.latest;
			}

			// One-revision archive. A replica's body carries the materialized block; a deletion's body
			// omits it (forward tombstone). saveRestored skips materialization when `block` is absent,
			// so a tombstone reverse-applies to an absent block (read back as undefined).
			const archive: BlockArchive = {
				blockId: this.blockId,
				revisions: {
					[rev]: body
				},
				range: [rev, rev + 1]
			};
			await this.saveRestored(archive);

			// Seed metadata when absent, advance latest, and merge the covered range.
			const prevRev = meta?.latest?.rev;
			if (!meta) {
				meta = { latest: undefined, ranges: [] };
			}
			meta.latest = { rev, actionId };
			// Open-ended coverage from the earliest held rev (see setLatest): the descending walk serves
			// any rev >= the anchor. A prior latest at prevRev (< rev per the monotonic guard) is a
			// materialized point, so anchor at prevRev; the first write (prevRev undefined) anchors at
			// rev. Freshness of a stale replica is a separate (replication-lag) concern from what this
			// node can locally reconstruct, which is exactly what ranges records.
			meta.ranges.unshift([prevRev ?? rev]);
			meta.ranges = mergeRanges(meta.ranges);
			await this.storage.saveMetadata(this.blockId, meta);

			log('%s:save blockId=%s rev=%d actionId=%s', logLabel, this.blockId, rev, actionId);
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

	private async materializeBlock(meta: BlockMetadata, targetRev: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined> {
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
			// Re-cache the recomputed materialization ONLY at a retained rev (checkpoint / range floor /
			// tip). Caching unconditionally would let a cold read at a non-checkpoint historical rev
			// re-add a materialization the checkpoint sweep is designed to remove — storage would regrow
			// via reads. Skipping it means a repeated cold read re-replays each time, bounded by
			// `checkpointInterval` transforms.
			// NOTE: cold non-checkpoint historical reads re-replay every time (up to `checkpointInterval`
			// forward transforms). Acceptable — historical reads are rare and replay is depth-bounded. If
			// they ever show as hot, cache at the nearest checkpoint below the target instead of skipping.
			// Read metadata FRESH for the retention decision: the `meta` passed in was captured by getBlock
			// BEFORE ensureRevision, which may have restored the containing range during this same read
			// (ensureRevision mutates its own re-read, not this snapshot). A stale `meta.ranges` would send
			// rangeFloorOf into its fallback (treats the target as its own floor ⇒ wrongly "retained"),
			// re-caching a rev the sweep means to prune — regrowing storage via reads of restored ranges.
			const retentionMeta = (await this.storage.getMetadata(this.blockId)) ?? meta;
			const cacheRev = actions[0]!.rev;
			const latestRev = retentionMeta.latest?.rev ?? cacheRev;
			const rangeFloor = this.rangeFloorOf(cacheRev, retentionMeta.ranges);
			if (this.isRetainedRev(cacheRev, latestRev, rangeFloor)) {
				await this.storage.saveMaterializedBlock(this.blockId, actions[0]!.actionId, block);
			}
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

	/**
	 * Checkpoint retention predicate. A materialization at `rev` must be kept iff it is the tip
	 * (`latestRev` — the common read target and the replay base for the next commit), the floor of its
	 * contiguous range (`rangeFloor` — the descending walk in {@link materializeBlock} has nothing below
	 * the floor to fall back to), or a periodic checkpoint (`rev % checkpointInterval === 0`, which bounds
	 * replay depth). Otherwise the materialization is prunable — its forward transform is retained, so the
	 * rev stays reconstructible by replay from the nearest retained materialization below it. The floor
	 * clause is SEPARATE and mandatory: absolute `rev % K` checkpoints do not automatically land on the
	 * floor (e.g. floor `E = 1`, `K = 32`).
	 */
	private isRetainedRev(rev: number, latestRev: number, rangeFloor: number): boolean {
		return rev === latestRev
			|| rev === rangeFloor
			|| rev % this.checkpointInterval === 0;
	}

	/** Start of the contiguous `ranges` span containing `rev`. Falls back to `rev` itself when no span
	 * contains it — unreachable for a committed rev (setLatest always merges the containing span before a
	 * prune/read runs), and the conservative direction (treats `rev` as its own floor ⇒ retained). */
	private rangeFloorOf(rev: number, ranges: RevisionRange[]): number {
		for (const range of ranges) {
			const [start, end] = range;
			if (rev >= start && (end === undefined || rev < end)) {
				return start;
			}
		}
		return rev;
	}
}
