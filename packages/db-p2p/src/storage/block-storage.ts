import type { BlockId, IBlock, Transform, ActionId, ActionRev, ActionTransform } from "@optimystic/db-core";
import { Latches, applyTransform, canonicalJson, hashString } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";
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

/**
 * One revision entry of a fetched archive, after {@link BlockStorage.vetRestoredArchive} has
 * established that its key really is a revision number and that it carries an action. The `rev` here
 * is the KEY the entry was filed under — the number `saveRestored` writes it as — not
 * `action.rev`, which is optional and is only cross-checked against this.
 */
type RestoredRevision = { rev: number; action: ActionTransform; block?: IBlock };

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
			// No metadata at all ⇒ this node has never seen the block, and reads report it absent
			// WITHOUT consulting `restoreCallback`. That is deliberate, not an oversight: `restoreCallback`
			// is reachable only from ensureRevision below, so a never-seen block is never fetched HERE.
			// Attempting a fetch at this layer would turn every read of a genuinely non-existent block —
			// the common case for an insert probing for a collision — into a network round trip, because
			// storage cannot tell "nobody has this" from "I don't have this".
			//
			// The layer that CAN tell them apart makes that call instead: `CoordinatorRepo` acquires the
			// block only once the cohort has corroborated a `(rev, actionId)` for it
			// (`restoreCorroborated` → `acquireBlockFromCohort`), so an id no peer claims still costs
			// nothing beyond the latest-query it already performed. Keep this early return as-is.
			return undefined;
		}

		// Pending-only state: metadata was seeded by savePendingTransaction but no revision has been
		// committed yet. "No committed base here" is an ABSENCE, not a fault — nothing is being
		// FAILED to reconstruct — so both arms below answer `undefined` rather than throwing, whether
		// or not the caller named a revision. StorageRepo.get then applies any pending overlay over
		// that absent base; a throw here would instead be caught into `unavailable: 'unmaterializable'`
		// and a writer reading back its own not-yet-committed insert would be told it is unreadable.
		// `unmaterializable` must keep its one meaning: records prove the block exists and this node
		// cannot reconstruct it.
		if (meta.latest === undefined) {
			if (rev === undefined) {
				return undefined;
			}
			// A named rev still ATTEMPTS the restore: `restoreCallback` may be able to supply that
			// revision even though nothing is committed locally, and a successful restore serves real
			// content with `latest` still undefined. That capability is pinned by the 'getBlock for an
			// absent revision fires restoreCallback (restore not short-circuited)' test in
			// test/block-storage.spec.ts — do not short-circuit it away.
			//
			// Only ensureRevision's FAILURE is swallowed (no callback wired, or restore could not
			// supply the rev): that is precisely the "no committed base here" absence. materializeBlock
			// below is deliberately OUTSIDE the try — a throw from there means revision records exist
			// with no materialization anywhere under them, which is genuine corruption and must keep
			// reading as `unmaterializable`.
			//
			// NOTE: a contextful read of a pending-only block still attempts a network restore before
			// falling back to absent (same cost as the pre-fix throw path); if pending-only read-backs
			// ever show as hot, short-circuit when ranges are empty.
			try {
				await this.ensureRevision(meta, rev);
			} catch (err) {
				log('getBlock:no-committed-base blockId=%s rev=%d error=%s', this.blockId, rev,
					err instanceof Error ? err.message : String(err));
				return undefined;
			}
			return await this.materializeBlock(meta, rev);
		}

		const targetRev = rev ?? meta.latest.rev;
		await this.ensureRevision(meta, targetRev);
		return await this.materializeBlock(meta, targetRev);
	}

	async getTransaction(actionId: ActionId): Promise<Transform | undefined> {
		return await this.storage.getTransaction(this.blockId, actionId);
	}

	async getBlockProof(rev: number): Promise<BlockCommitProof | undefined> {
		return await this.storage.getBlockProof(this.blockId, rev);
	}

	async saveBlockProof(rev: number, proof: BlockCommitProof): Promise<void> {
		await this.storage.saveBlockProof(this.blockId, rev, proof);
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

	async saveReplica(block: IBlock, source?: ActionRev, proof?: BlockCommitProof): Promise<ActionRev> {
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
			'replica',
			proof
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
	 *
	 * `verifiedProof` travels OUTSIDE `body` on purpose — see {@link saveRestored}: it is the one
	 * channel that persists a proof, and only {@link saveReplica} (whose caller verified the proof
	 * against `body.block`) supplies it.
	 */
	private async saveForwardRevision(
		rev: number,
		actionId: ActionId,
		body: { action: ActionTransform; block?: IBlock },
		logLabel: 'replica' | 'deletion',
		verifiedProof?: BlockCommitProof
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
			//
			// This skip returns before persisting anything, INCLUDING `verifiedProof` — deliberately.
			// The proof was verified against the PUSHED bytes; persisting it here would attach it to
			// this node's HELD materialization, whose bytes at the same `(rev, actionId)` may differ if
			// this holder diverged. A stored proof whose declared digest contradicts local content makes
			// this node serve content that fails its own proof, and `digest-mismatch` is ATTRIBUTABLE in
			// `cluster/certified-claims.ts` — every receiver would penalize it.
			//
			// Back-filling a proof onto an already-held revision therefore happens one layer up, in
			// `StorageRepo.saveReplicatedBlock`'s non-advancing branch, which routes it through
			// `backFillProof` → `persistProofIfContentMatches` — the rule that persists only when the
			// LOCAL materialization matches the digest the commit op declared. Keep this guard a true
			// no-op; the digest check is what makes the back-fill safe, and it does not belong here.
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
			await this.saveRestored(archive, verifiedProof ? { rev, proof: verifiedProof } : undefined);

			// INVARIANT P: a block never holds a pending record AND a committed record for the same
			// action id. On the commit path `promotePendingTransaction` maintains it by MOVING the
			// record atomically; this forward path writes the committed transform directly (via
			// saveRestored above), so it owes the deletion itself. Without it, a node that pended the
			// action but diverged before committing keeps a record nothing can ever promote — reported
			// as a phantom conflicting action by every later `pend` on the block, which under
			// `policy: 'f'` refuses that node's participation in the block's writes permanently.
			//
			// Deliberately on the WRITE path only: the monotonic guard above returns before here, and
			// that early return must stay a true no-op (the earlier call that wrote the revision is the
			// one that owed the deletion). Deliberately here rather than in `saveRestored`, which is
			// also reached from ensureRevision's historical restore under a different latch, where a
			// deletion could race a concurrent promotePendingTransaction; this path holds
			// `BlockStorage.saveReplica:<id>` and (via StorageRepo.saveReplicatedBlock) the per-block
			// commit latch, so it is already mutually exclusive with a live commit.
			//
			// NOTE: deletes only this revision's actionId, not every pending whose action is already
			// committed. A broader sweep would repair records orphaned by routes that do not carry the
			// committing actionId; if orphaned pendings ever show up in the field on blocks whose
			// committing action id differs, widen to a sweep over listPendingTransactions filtered by
			// getTransaction.
			await this.storage.deletePendingTransaction(this.blockId, actionId);

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
			// An archive off this wire is a peer's UNVERIFIED answer (see {@link saveRestored}), so it
			// is vetted before a byte of it reaches storage. A rejected archive is indistinguishable to
			// the caller from an absent one — same throw — because both mean the same thing: this node
			// still cannot serve `rev`. The specific reason is logged rather than thrown so that
			// `StorageRepo.readCommitBase`'s deliberately-unnarrowed catch keeps behaving as it does
			// for every other BlockStorage fault.
			const coverage = restored ? await this.vetRestoredArchive(restored, rev) : undefined;
			if (!restored || !coverage) {
				throw new Error(`Block ${this.blockId} revision ${rev} not found during restore attempt.`);
			}
			await this.saveRestored(restored);

			// The vetted coverage, NOT `restored.range`. The declared range is checked for internal
			// consistency above but is not what gets recorded — see {@link vetRestoredArchive} for why
			// the pin has to be folded in, or the same restore repeats on every read forever.
			currentMeta.ranges.unshift(coverage);
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

	/**
	 * Vet an archive fetched for a PINNED restore of `rev`, returning the revision coverage to record
	 * for it — or `undefined` when the archive must be refused, in which case nothing is written at
	 * all and the reason is logged.
	 *
	 * This is the whole trust boundary for the restore wire. `restoreBlock`'s
	 * `RestorationCoordinator` verifies nothing about a response (`queryPeer` returns
	 * `response.archive` straight through), so every field below is a remote peer's assertion, and
	 * `saveRestored` writes keyed by REVISION and by ACTION ID — meaning an archive naming a
	 * revision or action id this node already holds would otherwise overwrite content that was never
	 * in question. The checks, in order:
	 *
	 *  - **The archive is about this block.** `saveRestored` writes under `this.blockId` and ignores
	 *    `archive.blockId`, so an answer about a different block would land as this block's history.
	 *  - **Every revision key is a real revision.** Keys arrive as JSON strings; a non-numeric key
	 *    coerces to `NaN` and would be stored as a garbage revision number. Min/max are folded rather
	 *    than spread through `Math.min`/`Math.max`, which throws `RangeError` past ~125k arguments —
	 *    reachable inside the 8 MiB sync-response cap (see `maxArchiveRevision`, same hazard).
	 *  - **Each entry's own `rev`, when it declares one, agrees with the key it is filed under.**
	 *    That disagreement IS the mislabel this ticket's family of bugs is about, in miniature.
	 *  - **The archive answers the pin.** NOT "carries revision `rev`" — `ActionContext.rev` is a
	 *    COLLECTION-wide revision, so it routinely sits above the revision at which this particular
	 *    block last changed. A peer answering a pin at 9 for a block whose last commit was rev 2
	 *    correctly serves rev 2, labelled as rev 2 (pinned in `test/block-archive-proof.spec.ts`).
	 *    So the rule is that the archive's LOWEST revision is at or below the pin: `materializeBlock`
	 *    descends from `rev`, so an archive entirely above the pin answers a different question and
	 *    is exactly the "old bytes under a newer label" shape that overwrites good local data.
	 *  - **The declared `range` agrees with the revisions actually carried** — it starts at the
	 *    lowest (the floor must be present, or the descending walk has nothing to land on) and ends
	 *    past the highest. An OPEN-ENDED range is refused outright: it would claim infinite coverage
	 *    and permanently disable restore for this block on one unverified peer's say-so.
	 *    (`RestoreCallback` allows open-ended for the UNPINNED call; `ensureRevision` never makes one.)
	 *  - **Nothing already held is overwritten with different content** — see
	 *    {@link noDivergentRewrite}.
	 *
	 * ## What gets recorded, and the one thing taken on trust
	 *
	 * The coverage returned is `[lowest, max(highest + 1, rev + 1))` — the archive's own span,
	 * extended to include the pin. The extension is an INFERENCE, and the only one here: a peer
	 * answering a pinned fetch with revision M ≤ N means "M is my highest committed revision of this
	 * block at or below N", i.e. nothing changed in (M, N]. This node cannot verify that locally.
	 *
	 * It is recorded anyway because the alternative is worse. `meta.ranges` is what
	 * {@link ensureRevision} consults to decide whether to fetch at all, so recording only the
	 * archive's literal `[M, M+1)` leaves `inRanges(N)` false and re-runs the ENTIRE restore — network
	 * round trip plus a full `saveRestored` write — on every later read at that pin, forever, never
	 * converging. The inference is also unavoidable rather than merely convenient: having the peer
	 * state the claim on the wire instead would not make it verifiable, only explicit, while breaking
	 * repair against every peer running an older build.
	 *
	 * NOTE: accepted tradeoff — a lying peer's answer is therefore STICKY across the whole span it
	 * was asked about: reads between M and N are served locally from M's content and never re-ask, so
	 * a later honest peer is never consulted for them. Weighed against an unbounded re-fetch loop and
	 * kept; that is the same "ranges records what this node can locally reconstruct, freshness is a
	 * separate concern" position `setLatest` and `saveForwardRevision` already take. Revisit if a
	 * restore ever gains a way to verify an archive (a commit proof chain over the served revision
	 * would do it) — at that point record only what verifies.
	 */
	private async vetRestoredArchive(archive: BlockArchive, rev: number): Promise<RevisionRange | undefined> {
		const refuse = (why: string, ...args: unknown[]): undefined => {
			log(`restore:refused blockId=%s rev=%d ${why}`, this.blockId, rev, ...args);
			return undefined;
		};

		if (archive.blockId !== this.blockId) {
			return refuse('archive is for blockId=%s', archive.blockId);
		}

		const entries: RestoredRevision[] = [];
		let lowest: number | undefined;
		let highest: number | undefined;
		for (const [key, entry] of Object.entries(archive.revisions ?? {})) {
			const entryRev = Number(key);
			if (!Number.isInteger(entryRev) || entryRev < 1) {
				return refuse('revision key %s is not a revision', key);
			}
			const action = entry?.action;
			if (!action?.actionId) {
				return refuse('revision %d carries no action', entryRev);
			}
			if (action.rev !== undefined && action.rev !== entryRev) {
				return refuse('revision %d is filed under an action declaring rev=%d', entryRev, action.rev);
			}
			entries.push({ rev: entryRev, action, block: entry.block });
			if (lowest === undefined || entryRev < lowest) lowest = entryRev;
			if (highest === undefined || entryRev > highest) highest = entryRev;
		}
		if (lowest === undefined || highest === undefined) {
			return refuse('carries no revisions');
		}

		if (lowest > rev) {
			return refuse('lowest revision %d is above the pin', lowest);
		}

		const range = archive.range;
		if (!Array.isArray(range)) {
			return refuse('declares no range');
		}
		const [start, end] = range;
		if (start !== lowest) {
			return refuse('range starts at %o but revisions start at %d', start, lowest);
		}
		if (end === undefined || !Number.isInteger(end) || end <= highest) {
			return refuse('range ends at %o but revisions end at %d', end, highest);
		}

		if (!await this.noDivergentRewrite(entries, refuse)) {
			return undefined;
		}

		return [lowest, Math.max(highest + 1, rev + 1)];
	}

	/**
	 * True when none of `entries` would overwrite content this node ALREADY holds with different
	 * content. False (having logged which entry, via `refuse`) when any would.
	 *
	 * The refusal is all-or-nothing: one divergent entry rejects the WHOLE archive rather than
	 * landing the entries this node happens to lack. Two reasons. An archive that contradicts locally
	 * held content is evidence the peer is wrong or hostile about this block, which makes the rest of
	 * it no more trustworthy than the part that was caught; and a partial apply would leave
	 * {@link vetRestoredArchive}'s coverage claiming a span the applied subset may not support.
	 *
	 * Identical content is NOT a conflict — a re-restore of the same archive must stay idempotent,
	 * which it has to be for the pin-extended coverage above to converge.
	 *
	 * Comparison is by `canonicalJson`, db-core's one deterministic encoding, so key ORDER across a
	 * JSON round trip over the wire never reads as divergence.
	 *
	 * The three keys mirror {@link saveRestored}'s three writes exactly; an entry that carries no
	 * `block` writes no materialization, so it cannot clobber one and is not checked for it.
	 *
	 * NOTE: costs up to three raw-storage reads per revision entry, on the restore path only — which
	 * has already paid for a network round trip, so it is not the term that matters. If a restore
	 * ever carries thousands of revisions and this shows up, check `getRevision` first and skip the
	 * other two for a revision this node does not hold at all.
	 */
	private async noDivergentRewrite(
		entries: RestoredRevision[],
		refuse: (why: string, ...args: unknown[]) => undefined
	): Promise<boolean> {
		for (const { rev, action, block } of entries) {
			const heldActionId = await this.storage.getRevision(this.blockId, rev);
			if (heldActionId !== undefined && heldActionId !== action.actionId) {
				refuse('revision %d is already held as action %s, archive names %s',
					rev, heldActionId, action.actionId);
				return false;
			}

			const heldTransform = await this.storage.getTransaction(this.blockId, action.actionId);
			if (heldTransform !== undefined && canonicalJson(heldTransform) !== canonicalJson(action.transform)) {
				refuse('action %s (revision %d) is already held with a different transform', action.actionId, rev);
				return false;
			}

			if (block) {
				const heldBlock = await this.storage.getMaterializedBlock(this.blockId, action.actionId);
				if (heldBlock !== undefined && canonicalJson(heldBlock) !== canonicalJson(block)) {
					refuse('action %s (revision %d) is already materialized with different content', action.actionId, rev);
					return false;
				}
			}
		}
		return true;
	}

	/**
	 * Persist a fetched archive's revisions locally.
	 *
	 * A revision entry's own `proof` is deliberately IGNORED. An archive is remote wire data —
	 * {@link restoreBlock}'s `RestorationCoordinator` fetch verifies nothing, and a peer chooses
	 * what to attach — so persisting a proof read out of the archive body would re-serve a hostile
	 * peer's artifact as evidence this node retained itself. A proof reaches storage only through
	 * `verified`, passed out-of-band alongside the archive, which exactly one caller chain supplies:
	 * `cluster/reconcile-block.ts` → `StorageRepo.saveReplicatedBlock` → {@link saveReplica} →
	 * {@link saveForwardRevision}, where `certifyContent` had already bound the proof to these exact
	 * bytes. A separate parameter rather than a caller obligation to strip is what makes "an
	 * unverified proof reached `saveBlockProof`" unrepresentable instead of merely documented.
	 *
	 * This is a WRITER, not a gate: it trusts what it is handed, and each of its two callers is
	 * responsible for having earned that on its own terms.
	 *
	 *  - {@link ensureRevision} — the unverified restore wire — runs {@link vetRestoredArchive}
	 *    first. Those checks are ABOUT the pinned request (does the archive answer the revision that
	 *    was asked for?), and this function has no pin to check against, so they cannot live here.
	 *  - {@link saveForwardRevision} — reached by `saveReplica`/`saveDeletion` through
	 *    `StorageRepo.saveReplicatedBlock` — builds the archive it passes from local arguments, and
	 *    on the replica path `cluster/reconcile-block.ts` has already bound those bytes to a verified
	 *    proof. It writes strictly ABOVE its own `latest` (the monotonic guard returns first
	 *    otherwise), so it cannot rewrite held history, and it deliberately pays nothing for the
	 *    restore wire's checks.
	 *
	 * A THIRD caller would not inherit either argument. Any future one that takes an archive off a
	 * network must route through `vetRestoredArchive` (or an equivalent for its own trust model)
	 * before reaching here.
	 */
	private async saveRestored(archive: BlockArchive, verified?: { rev: number; proof: BlockCommitProof }) {
		const revisions = Object.entries(archive.revisions)
			.map(([rev, data]) => ({ rev: Number(rev), data }));

		// Save all revisions, actions, materializations, and the caller-verified proof (if any).
		for (const { rev, data: { action, block } } of revisions) {
			await Promise.all([
				this.storage.saveRevision(this.blockId, rev, action.actionId),
				this.storage.saveTransaction(this.blockId, action.actionId, action.transform),
				block ? this.storage.saveMaterializedBlock(this.blockId, action.actionId, block) : Promise.resolve(),
				verified?.rev === rev ? this.storage.saveBlockProof(this.blockId, rev, verified.proof) : Promise.resolve()
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
