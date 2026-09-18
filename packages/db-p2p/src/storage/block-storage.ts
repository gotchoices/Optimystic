import type { BlockId, IBlock, Transform, ActionId, ActionRev, ActionTransform, BlockLineage } from "@optimystic/db-core";
import { applyTransform, canonicalJson, hashString } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { mergeRanges } from "./helpers.js";
import { RevisionNotCoveredError, PendRevisionTakenError, type IBlockStorage } from "./i-block-storage.js";
import type { BlockWriteLatch } from "./block-latch.js";
import type { PendingClaim } from "./pending-claim.js";
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

	/**
	 * Guard every write: the token must have been minted for THIS block and must still be live. The
	 * type already proves the caller went through `acquireBlockWriteLatch`; this catches the two
	 * things the type cannot — a token for block A presented to block B's storage, and a token
	 * stashed by a callback and used after its scope released the latch.
	 */
	private assertLatch(latch: BlockWriteLatch): void {
		if (latch.blockId !== this.blockId) {
			throw new Error(`Block ${this.blockId}: write latch was acquired for block ${latch.blockId}`);
		}
		if (!latch.live) {
			throw new Error(`Block ${this.blockId}: write latch has already been released`);
		}
	}

	/**
	 * LOCAL-ONLY read — never fetches from a peer. A revision outside `meta.ranges` throws
	 * {@link RevisionNotCoveredError}; the one caller allowed to heal that (`StorageRepo.get`) does so
	 * with {@link restoreRevision} under the block's write latch and re-reads. Keeping the fetch out of
	 * here is what lets the commit path hold N block latches with no network I/O inside them.
	 */
	async getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined> {
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			// No metadata at all ⇒ this node has never seen the block, and reads report it absent
			// WITHOUT consulting `restoreCallback`. That is deliberate, not an oversight: `restoreCallback`
			// is reachable only from restoreRevision, which a caller invokes only after THIS method has
			// reported a coverage gap on a block that has metadata — so a never-seen block is never fetched.
			// Attempting a fetch for it would turn every read of a genuinely non-existent block —
			// the common case for an insert probing for a collision — into a network round trip, because
			// storage cannot tell "nobody has this" from "I don't have this".
			//
			// The layer that CAN tell them apart makes that call instead: `CoordinatorRepo` acquires the
			// block only once the cohort has corroborated a `(rev, actionId)` for it
			// (`restoreCorroborated` → `acquireBlockFromCohort`), so an id no peer claims still costs
			// nothing beyond the latest-query it already performed. Keep this early return as-is.
			return undefined;
		}

		// Pending-only state (metadata seeded by savePendingTransaction, nothing committed) with no
		// revision named: "no committed base here" is an ABSENCE, not a fault — answer `undefined`.
		// StorageRepo.get then applies any pending overlay over that absent base. A NAMED rev on a
		// pending-only block falls through: it is covered only if an earlier restore brought it in
		// (a restore can serve real content with `latest` still undefined), otherwise it reports the
		// gap below and StorageRepo.get decides whether the failed restore reads as absent.
		if (meta.latest === undefined && rev === undefined) {
			return undefined;
		}

		const targetRev = rev ?? meta.latest!.rev;
		if (!this.inRanges(targetRev, meta.ranges)) {
			throw new RevisionNotCoveredError(this.blockId, targetRev);
		}
		// A throw from here means revision records exist with no materialization anywhere under them —
		// genuine corruption, which StorageRepo.get reports as `unmaterializable`.
		return await this.materializeBlock(meta, targetRev);
	}

	async restoreRevision(rev: number, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		// One metadata read, under the held latch: the caller's earlier `getBlock` observed a gap, but
		// a queued-ahead restore or replica may have filled it before this latch was granted.
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			// Same reasoning as getBlock's early return: a never-seen block is not restored here.
			throw new Error(`Block ${this.blockId} has no metadata; a never-seen block is not restored here.`);
		}
		if (this.inRanges(rev, meta.ranges)) {
			return;
		}

		const restored = await this.restoreBlock(rev);
		// An archive off this wire is a peer's UNVERIFIED answer (see {@link saveRestored}), so it
		// is vetted before a byte of it reaches storage. A rejected archive is indistinguishable to
		// the caller from an absent one — same throw — because both mean the same thing: this node
		// still cannot serve `rev`. The specific reason is logged rather than thrown so that
		// `StorageRepo.get`'s healing helper keeps one rule for every restore failure.
		const coverage = restored ? await this.vetRestoredArchive(restored, rev) : undefined;
		if (!restored || !coverage) {
			throw new Error(`Block ${this.blockId} revision ${rev} not found during restore attempt.`);
		}
		await this.saveRestored(restored);

		// The vetted coverage, NOT `restored.range`. The declared range is checked for internal
		// consistency above but is not what gets recorded — see {@link vetRestoredArchive} for why
		// the pin has to be folded in, or the same restore repeats on every read forever.
		meta.ranges.unshift(coverage);
		meta.ranges = mergeRanges(meta.ranges);
		await this.storage.saveMetadata(this.blockId, meta);
	}

	async getTransaction(actionId: ActionId): Promise<Transform | undefined> {
		return await this.storage.getTransaction(this.blockId, actionId);
	}

	async getBlockProof(rev: number): Promise<BlockCommitProof | undefined> {
		return await this.storage.getBlockProof(this.blockId, rev);
	}

	async saveBlockProof(rev: number, proof: BlockCommitProof, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		await this.storage.saveBlockProof(this.blockId, rev, proof);
	}

	async getPendingTransaction(actionId: ActionId): Promise<Transform | undefined> {
		return await this.storage.getPendingTransaction(this.blockId, actionId);
	}

	async *listPendingTransactions(): AsyncIterable<ActionId> {
		yield* this.storage.listPendingTransactions(this.blockId);
	}

	async listPendingClaims(): Promise<PendingClaim[]> {
		const meta = await this.storage.getMetadata(this.blockId);
		const claims: PendingClaim[] = [];
		for await (const actionId of this.storage.listPendingTransactions(this.blockId)) {
			claims.push(BlockStorage.claimOf(meta, actionId));
		}
		return claims;
	}

	async pendingClaimOf(actionId: ActionId): Promise<PendingClaim | undefined> {
		// Joined against the record, exactly as the listing is: a metadata entry whose record is gone
		// is inert (see BlockMetadata.pendingRevs) and must not read as a live claim.
		if (await this.storage.getPendingTransaction(this.blockId, actionId) === undefined) {
			return undefined;
		}
		return BlockStorage.claimOf(await this.storage.getMetadata(this.blockId), actionId);
	}

	/** The claim `meta` describes for `actionId`'s (existing) record: its slot and its base, each
	 * present only when on file. */
	private static claimOf(meta: BlockMetadata | undefined, actionId: ActionId): PendingClaim {
		const rev = meta?.pendingRevs?.[actionId];
		const baseRev = meta?.pendingBases?.[actionId];
		return {
			actionId,
			...(rev === undefined ? {} : { rev }),
			...(baseRev === undefined ? {} : { baseRev })
		};
	}

	async savePendingTransaction(actionId: ActionId, transform: Transform, rev: number | undefined, baseRev: number | undefined, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		log('pend blockId=%s actionId=%s rev=%s baseRev=%s', this.blockId, actionId, rev, baseRev);
		let meta = await this.storage.getMetadata(this.blockId);
		// Refuse a record that could never be promoted (see IBlockStorage.savePendingTransaction).
		// The metadata read above is unconditional anyway, so this costs one comparison and no I/O.
		// `>=` deliberately covers BOTH unpromotable cases at once — our own already-committed
		// revision (commit partitions it as already-done) and a rival's win (commit refuses it as
		// stale) — so this is not an `isOwnRevision` check.
		if (rev !== undefined && meta?.latest !== undefined && meta.latest.rev >= rev) {
			throw new PendRevisionTakenError(this.blockId, actionId, rev, meta.latest);
		}
		if (!meta) {
			// A freshly-pended block holds NO committed revision, so it can reconstruct
			// nothing yet: seed empty ranges. The first commit anchors an OPEN-ENDED span at
			// the earliest held rev E ([E, +inf)); later commits/recover merge into it via
			// setLatest/recover. Seeding open-ended `[[0]]` would falsely claim coverage of the
			// un-held revs below E and disable restoreRevision's restore path.
			//
			// This read-then-seed is exactly the window a concurrent replica used to land in (the
			// seed then erased its `latest`); the latch the caller holds is what closes it.
			meta = { latest: undefined, ranges: [] };
		}
		// Record the slot the record claims (see BlockMetadata.pendingRevs) and the base it was computed
		// against (`pendingBases`) in the same metadata write that seeds a fresh block, BEFORE the record
		// itself: a crash between the two leaves an inert entry with no record, whereas the other order
		// would leave a record with no claim — which every reader treats as the strongest kind and would
		// refuse rivals on more than it should — and with no base, which the read-driven promotion
		// would then decline to apply. A redelivered pend for the same action overwrites all three.
		BlockStorage.recordClaim(meta, actionId, { rev, baseRev });
		await this.storage.saveMetadata(this.blockId, meta);
		await this.storage.savePendingTransaction(this.blockId, actionId, transform);
	}

	async deletePendingTransaction(actionId: ActionId, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		log('cancel blockId=%s actionId=%s', this.blockId, actionId);
		await this.storage.deletePendingTransaction(this.blockId, actionId);
		// Metadata is written only when the record had a claim to drop: a cancel of an absent or
		// claim-less record (the common torn-cancel retry) stays a pure no-op on the metadata blob.
		const meta = await this.storage.getMetadata(this.blockId);
		if (meta && (meta.pendingRevs?.[actionId] !== undefined || meta.pendingBases?.[actionId] !== undefined)) {
			BlockStorage.recordClaim(meta, actionId, undefined);
			await this.storage.saveMetadata(this.blockId, meta);
		}
	}

	/**
	 * Set (`claim` given) or clear (`undefined`) what `meta` says about `actionId`'s pending record —
	 * the slot it claims and the base it was computed against — keeping each map absent while it is
	 * empty. The two are always written together, so no path can drop a record's slot and leave its
	 * base behind, or the reverse: clearing is what every drop site calls — a delete, a promotion
	 * (`setLatest`), a same-action forward write (`saveForwardRevision`) and the dead-claim sweep.
	 */
	private static recordClaim(meta: BlockMetadata, actionId: ActionId, claim: { rev?: number; baseRev?: number } | undefined): void {
		BlockStorage.setEntry(meta, 'pendingRevs', actionId, claim?.rev);
		BlockStorage.setEntry(meta, 'pendingBases', actionId, claim?.baseRev);
	}

	/** `meta[map][actionId] = value`, or removes the entry when `value` is undefined; the map itself
	 * is dropped from `meta` once empty, so an idle block's metadata carries neither key. */
	private static setEntry(meta: BlockMetadata, map: 'pendingRevs' | 'pendingBases', actionId: ActionId, value: number | undefined): void {
		const entries = { ...meta[map] };
		if (value === undefined) delete entries[actionId];
		else entries[actionId] = value;
		if (Object.keys(entries).length === 0) delete meta[map];
		else meta[map] = entries;
	}

	/**
	 * Every pending record claiming a revision at or below `latestRev` can never be promoted here:
	 * promotion needs `latest.rev < rev`, and `latest` only advances. Such a record is DEAD — a rival
	 * that lost the slot, or a torn write's leftover on a block a later commit has since moved past —
	 * and left in place it is reported as a live conflicting action to every reader of the block.
	 * Delete those records and drop their claims from `meta`, which the caller then saves; a record
	 * with no claim on file is left alone (its slot is unknown, so its death is unprovable here).
	 *
	 * Runs under the block's write latch on every path that advances `latest`, which is the one moment
	 * a record's death becomes provable. This is the locally decidable half of what backlog
	 * `debt-unpromotable-pending-records-need-a-sweep` asks for; the other half — a record whose slot
	 * the block has NOT reached, whose writer simply never came back — is not decidable from local
	 * state and is not touched here.
	 */
	private async sweepDeadClaims(meta: BlockMetadata, latestRev: number): Promise<void> {
		for (const [actionId, rev] of Object.entries(meta.pendingRevs ?? {}) as [ActionId, number][]) {
			if (rev > latestRev) continue;
			await this.storage.deletePendingTransaction(this.blockId, actionId);
			BlockStorage.recordClaim(meta, actionId, undefined);
			log('sweep-dead-claim blockId=%s actionId=%s claimedRev=%d latestRev=%d', this.blockId, actionId, rev, latestRev);
		}
	}

	async *listRevisions(startRev: number, endRev: number): AsyncIterable<ActionRev> {
		yield* this.storage.listRevisions(this.blockId, startRev, endRev);
	}

	async saveMaterializedBlock(actionId: ActionId, block: IBlock | undefined, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		await this.storage.saveMaterializedBlock(this.blockId, actionId, block);
	}

	async pruneSupersededMaterialization(prior: ActionRev, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
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

	async saveRevision(rev: number, actionId: ActionId, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		await this.storage.saveRevision(this.blockId, rev, actionId);
	}

	async promotePendingTransaction(actionId: ActionId, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		log('commit blockId=%s actionId=%s', this.blockId, actionId);
		await this.storage.promotePendingTransaction(this.blockId, actionId);
	}

	async lineageOf({ actionId, rev }: ActionRev): Promise<BlockLineage> {
		const meta = await this.storage.getMetadata(this.blockId);
		const latest = meta?.latest;
		if (!latest || latest.rev < rev) {
			return 'behind';
		}
		if (latest.rev === rev) {
			return latest.actionId === actionId ? 'contains' : 'excludes';
		}
		const heldBy = await this.storage.getRevision(this.blockId, rev);
		if (heldBy !== undefined && heldBy !== actionId) {
			return 'excludes';
		}
		// Past the revision. The index alone cannot answer from here: holding the action at `rev`
		// does not prove `latest` was built from it (a replica taken since may descend from a base
		// below `rev`), and holding nothing at `rev` does not prove it was not (a replica taken since
		// may descend from it). Only a history derived HERE across `rev` settles it either way.
		const floor = meta.lineageFloor;
		if (floor === undefined || floor > rev) {
			return 'unknown';
		}
		return heldBy === actionId ? 'contains' : 'excludes';
	}

	async setLatest(latest: ActionRev, builtOnPrior: boolean, latch: BlockWriteLatch): Promise<void> {
		this.assertLatch(latch);
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			throw new Error(`Block ${this.blockId} not found`);
		}
		// Capture the prior latest rev BEFORE overwriting: coverage anchors to the earliest held rev.
		const prevRev = meta.latest?.rev;
		meta.latest = latest;
		meta.lineageFloor = BlockStorage.nextLineageFloor(meta.lineageFloor, prevRev, latest.rev, builtOnPrior);
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
		// Range + latest advance in one saveMetadata write (atomic under the block write latch), so a crash
		// before this call advances neither.
		meta.ranges.unshift([prevRev ?? latest.rev]);
		meta.ranges = mergeRanges(meta.ranges);
		// The committing action's own record was just MOVED by `promotePendingTransaction`: drop its
		// claim without a delete, so the sweep does not pay a raw-storage op on a record that is already
		// gone. Any other record claiming a slot at or below the new latest is dead and swept.
		BlockStorage.recordClaim(meta, latest.actionId, undefined);
		await this.sweepDeadClaims(meta, latest.rev);
		await this.storage.saveMetadata(this.blockId, meta);
	}

	async recover(latch: BlockWriteLatch): Promise<{ reconciled: boolean; latest?: ActionRev }> {
		this.assertLatch(latch);
		const meta = await this.storage.getMetadata(this.blockId);
		if (!meta) {
			return { reconciled: false };
		}

		const currentRev = meta.latest?.rev ?? 0;
		let maxRev = currentRev;
		let maxActionId = meta.latest?.actionId;
		let lineageFloor = meta.lineageFloor;

		// Probe forward until we hit a gap or a revision whose action is not yet
		// in the committed log (Crash-D2 state — retry-commit owns that advance).
		for (let next = currentRev + 1; ; next++) {
			const actionId = await this.storage.getRevision(this.blockId, next);
			if (actionId === undefined) break;
			const promoted = await this.storage.getTransaction(this.blockId, actionId);
			if (promoted === undefined) break;
			// Each recovered revision is a commit whose `setLatest` was lost, so it owes the floor
			// exactly what that `setLatest` would have recorded.
			lineageFloor = BlockStorage.nextLineageFloor(lineageFloor, maxRev === 0 ? undefined : maxRev, next, promoted.insert === undefined);
			maxRev = next;
			maxActionId = actionId;
		}

		if (maxRev > currentRev && maxActionId !== undefined) {
			const advanced: ActionRev = { rev: maxRev, actionId: maxActionId };
			meta.latest = advanced;
			meta.lineageFloor = lineageFloor;
			// The lost setLatest would have merged each recovered revision's range; redo that
			// here. Open-ended from currentRev+1 (see setLatest): every rev in (currentRev, maxRev]
			// was verified present in the committed log above, and any rev > maxRev resolves via the
			// descending walk to maxRev's materialization — so [currentRev+1, +inf) is honest. It joins
			// the prior [E, currentRev+1) (from the earlier setLatest) into one open-ended [E, +inf).
			meta.ranges.unshift([currentRev + 1]);
			meta.ranges = mergeRanges(meta.ranges);
			// Each recovered revision's lost `setLatest` also owed this sweep. Unlike `setLatest`, it
			// DELETES each recovered action's record rather than just dropping its claim: a pend checks
			// only `latest`, so a same-action retry re-pended while the `setLatest` was owed leaves a
			// pending record beside the committed one (reachable through `StorageRepo.recoverBlock`).
			// Dropping only its claim would leave a claim-less record, the strongest kind of reservation,
			// that nothing ever removes. Recover runs only after a crash, so the extra op costs nothing.
			await this.sweepDeadClaims(meta, maxRev);
			await this.storage.saveMetadata(this.blockId, meta);
			log('recover blockId=%s advanced latest from rev=%d to rev=%d', this.blockId, currentRev, maxRev);
			return { reconciled: true, latest: advanced };
		}

		return { reconciled: false, latest: meta.latest };
	}

	async saveReplica(block: IBlock, source: ActionRev | undefined, proof: BlockCommitProof | undefined, latch: BlockWriteLatch): Promise<ActionRev> {
		this.assertLatch(latch);
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

	async saveDeletion(source: ActionRev, latch: BlockWriteLatch): Promise<ActionRev> {
		this.assertLatch(latch);
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
		// The read-modify-write of this block's metadata below is serialized by the write latch the
		// caller already holds (asserted in saveReplica / saveDeletion) — the same latch every other
		// writer of this block holds, so a concurrent replica, deletion, restore, commit, or pend
		// cannot land inside the window between the read and the saveMetadata.
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
		// also reached from restoreRevision's historical restore, where a held revision's pending
		// record is not this writer's to delete. Both paths run under the block's write latch, so
		// this deletion is already mutually exclusive with a live commit.
		//
		// This same-action delete stays explicit even though the sweep below would usually cover it:
		// Invariant P must hold for a record that has no claim on file (pended before claims were
		// recorded), which the sweep — which reasons from claims — cannot see.
		await this.storage.deletePendingTransaction(this.blockId, actionId);

		// Seed metadata when absent, advance latest, and merge the covered range.
		const prevRev = meta?.latest?.rev;
		if (!meta) {
			meta = { latest: undefined, ranges: [] };
		}
		// Every OTHER record claiming a slot at or below the landing revision is dead too: the
		// orphaned records a route that does not carry the committing action id used to leave behind
		// (the cohort reconcile of a block a member fell behind on lands a later revision under a
		// later action, and the missed action's record would otherwise stand forever).
		BlockStorage.recordClaim(meta, actionId, undefined);
		await this.sweepDeadClaims(meta, rev);
		meta.latest = { rev, actionId };
		// Content this node did not derive: nothing here says what it was built from, so the known
		// lineage starts over at this revision (see BlockMetadata.lineageFloor).
		meta.lineageFloor = rev;
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
			// NOTE: this `saveMaterializedBlock` is the ONE named exclusion from the storage invariant that
			// every write to a block holds `blockWriteLatchKey(blockId)` (see block-latch.ts). It runs on the
			// READ path, unlatched, and that is safe for CONTENT because it is not a read-modify-write of
			// anything: the key is `(blockId, actionId)` and the value is a deterministic replay of
			// transforms this node has already retained, so a concurrent SAVE of the same key writes the
			// same bytes. It touches neither the metadata blob nor any revision record, so it cannot
			// clobber `latest`. Taking the latch here would put a lock acquisition on every cold historical
			// read and would deadlock the callers that already hold it. Dropping the re-cache entirely is
			// the other way to close the exclusion, and is out of scope until someone measures the cold
			// historical-read cost of doing without it.
			//
			// NOTE: the one racer that does NOT write the same bytes at this key is
			// `pruneSupersededMaterialization`, which DELETES it (saveMaterializedBlock(..., undefined)).
			// Losing that race resurrects a materialization the sweep just removed — a bounded storage
			// leak, never wrong content, since the resurrected bytes are a correct materialization of that
			// rev. The fresh `retentionMeta` read below narrows the window but cannot close it: a commit
			// can land and prune between that read and this save. If materialization storage is ever seen
			// to grow under read load, close it by having the prune win — e.g. re-check retention inside
			// the raw driver's save, or have the sweep re-run after the read.
			//
			// Read metadata FRESH for the retention decision: because this runs outside the block's write
			// latch, a concurrent restore or commit may have moved `ranges` since `meta` was captured. A stale
			// `meta.ranges` would send rangeFloorOf into its fallback (treats the target as its own floor
			// ⇒ wrongly "retained"), re-caching a rev the sweep means to prune — regrowing storage via reads.
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
	 *    (`RestoreCallback` allows open-ended for the UNPINNED call; `restoreRevision` never makes one.)
	 *  - **Nothing already held is overwritten with different content** — see
	 *    {@link noDivergentRewrite}.
	 *
	 * ## What gets recorded, and the one thing taken on trust
	 *
	 * The coverage returned is `[lowest, rev + 1)` — the archive's floor, up to the PIN and no
	 * further. Both halves of that are deliberate.
	 *
	 * Extending UP to the pin is an INFERENCE, and the only one here: a peer
	 * answering a pinned fetch with revision M ≤ N means "M is my highest committed revision of this
	 * block at or below N", i.e. nothing changed in (M, N]. This node cannot verify that locally.
	 *
	 * It is recorded anyway because the alternative is worse. `meta.ranges` is what
	 * {@link restoreRevision} consults to decide whether to fetch at all, so recording only the
	 * archive's literal `[M, M+1)` leaves `inRanges(N)` false and re-runs the ENTIRE restore — network
	 * round trip plus a full `saveRestored` write — on every later read at that pin, forever, never
	 * converging. The inference is also unavoidable rather than merely convenient: having the peer
	 * state the claim on the wire instead would not make it verifiable, only explicit, while breaking
	 * repair against every peer running an older build.
	 *
	 * Stopping AT the pin, on the other hand, discards coverage for any revision the archive
	 * volunteered ABOVE it. Those entries are still WRITTEN — an honest peer serves a contiguous
	 * span, so an archive of `{2, 3, 4}` answering a pin at 3 is normal, not hostile — they are
	 * merely not CLAIMED. `rev` is the one number in the exchange this node chose, so it is as far as
	 * its trust in the answer should reach; recording `highest + 1` instead would let the peer set
	 * the width of its own credibility by padding the archive with fabricated high revisions, and
	 * reads across that padded span would then be served from local content without ever re-asking.
	 * The cost is one redundant fetch the first time a revision above the pin is read; that fetch is
	 * idempotent (identical content is not a conflict, see {@link noDivergentRewrite}) and the
	 * coverage converges.
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
			// `String(entryRev) === key`, not merely "parses as an integer". `saveRestored` re-derives
			// the number with its own `Number(key)`, so any key with a second spelling (`"02"`, `" 2"`,
			// `"2e1"`) lets ONE archive file two entries under one revision: the vet checks both, the
			// write keeps whichever `Object.entries` yields last, and which one that is was never the
			// question either check answered.
			if (!Number.isInteger(entryRev) || entryRev < 1 || String(entryRev) !== key) {
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

		return [lowest, rev + 1];
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
	 * NOTE: accepted tradeoff — first writer wins, permanently. Once a revision record is held, no
	 * later archive can replace it, so a lying peer that answers a gap FIRST makes every honest
	 * archive restating that revision refuse forever: the revision becomes unreadable rather than
	 * wrong. That is the deliberate direction — this guard exists precisely so a peer cannot rewrite
	 * held history, and it cannot tell "the held copy is the lie" from "the incoming copy is". Repair
	 * from that state is an operator action (drop the block's local records and re-fetch). Revisit
	 * only alongside a way to verify an archive, which would let the guard prefer the provable copy
	 * instead of the earlier one.
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
	 *  - {@link restoreRevision} — the unverified restore wire — runs {@link vetRestoredArchive}
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

	/**
	 * The lineage floor after a COMMIT lands `rev` on top of `prevRev` (see
	 * {@link BlockMetadata.lineageFloor}). A revision built on the prior content extends the known
	 * lineage downwards as far as it already reached — or, for metadata that predates the field,
	 * to the revision it was just built on, which is all this commit can vouch for. A revision that
	 * stands on its own (an insert replaces the block wholesale), and a block's first revision,
	 * start the lineage at themselves.
	 */
	private static nextLineageFloor(floor: number | undefined, prevRev: number | undefined, rev: number, builtOnPrior: boolean): number {
		return builtOnPrior && prevRev !== undefined ? (floor ?? prevRev) : rev;
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
