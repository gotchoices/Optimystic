import { randomBytes } from '@noble/hashes/utils.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, BlockId, BlockHeader, ITransactor, ActionId, CommitResult, ActionContext, BlockType, BlockSource, ReadPurpose, Transforms, BlockContentDigests, GetBlockResult } from "../index.js";
import { BlockUnavailableError, BlockPossiblyStaleError } from "../network/struct.js";
import type { ReadDependency } from "../transaction/transaction.js";
import { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";
import { blockDigestsField } from "../transform/digest.js";
import type { BlockFloorCheck } from "./block-floors.js";
import { createLogger } from "../logger.js";

const log = createLogger('transactor-source');

/** The block `entry` answers for `id`, for a read at `context` (`undefined` for an unpinned "give me
 * latest" read) — `undefined` when the block is absent — or a throw when the entry is not an answer
 * that read may use. Every read that consumes a raw {@link GetBlockResult} goes through here, so a
 * doubted answer cannot be treated differently depending on which path fetched it.
 *
 * An entry flagged `unavailable` with no block is the repo saying "I could not find out whether this
 * exists" — an answer that must not be read as absent. A repo that omits the flag stays authoritative.
 *
 * A read whose surviving answer is marked possibly-behind (`unconfirmedAheadRev` outlived the
 * transactor's retry round: every reachable coordinator served content it could not confirm current)
 * must not pose as an answer for a view that should CONTAIN the claimed revision. Two such views, the
 * same test the coordinator applies when it stamps: an UNPINNED read — the tail read is the one seam
 * where a lagging collection can learn the truth (Collection.checkedLogTail), and silently serving
 * doubted content there is exactly how a collection view freezes forever — and a read PINNED AT OR
 * ABOVE the claim, whose snapshot is missing a revision the cohort says exists inside it. A read pinned
 * strictly BELOW the claim keeps working: it legitimately asks for an older view, which is being
 * served correctly.
 *
 * NOTE: accepted tradeoff — this converts a silent wrong answer into a loud failure. A node partitioned
 * from every coordinator able to confirm currency used to read (stale) data indefinitely without any
 * signal; it now raises BlockPossiblyStaleError on the reads that should contain the claim, until the
 * partition heals or the claim is settled. Deliberate: the silent alternative is a collection view that
 * forks and freezes with no report (ticket coordinator-serves-stale-data-as-if-confirmed). Revisit only
 * if a degraded-read mode (serve-with-warning) becomes a product requirement. */
export function answeredBlock(id: BlockId, entry: GetBlockResult, context: ActionContext | undefined): IBlock | undefined {
	const { block, unavailable, unconfirmedAheadRev } = entry;
	if (!block && unavailable) {
		throw new BlockUnavailableError(id, unavailable);
	}
	if (unconfirmedAheadRev !== undefined && (context === undefined || context.rev >= unconfirmedAheadRev)) {
		throw new BlockPossiblyStaleError(id, unconfirmedAheadRev);
	}
	return block;
}

/** The revision a served block's content IS: its materialized revision, falling back to the repo's
 * latest for repos that omit the field (see {@link GetBlockResult.materialized} for why `state.latest`
 * alone is the wrong number). */
export function servedRevision(entry: GetBlockResult): number {
	return entry.materialized?.rev ?? entry.state.latest?.rev ?? 0;
}

/** What a source knows about one block it returned — see {@link TransactorSource.describeServed}. */
export type ServedBlock = {
	/** The revision the content is ({@link servedRevision} of the answer it came from). */
	rev: number;
	/** Whether a cache may keep the block and serve it again without re-asking. */
	mayRetain: boolean;
};

export class TransactorSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	/** Shared with this collection's CacheSource so cache hits also record dependencies.
	 *  Defaults to a private instance so internal log-walk sources (which never need a
	 *  transaction read set) work standalone. */
	private readonly collector: ReadDependencyCollector;
	/** Last revision observed per id, so CacheSource can learn the revision on a miss-load
	 *  (it calls {@link getReadRevision} right after this source serves the block). */
	private readRevisions = new Map<BlockId, number>();
	/** What this source knows about each block OBJECT it returned, for {@link describeServed}. Keyed
	 *  by the object rather than by id because a cache reads it after an `await`: with two reads of
	 *  one id in flight, a by-id record holds whichever answer was processed last, and would pair one
	 *  answer's content with the other's revision and verdict. Weak, so it holds nothing alive. */
	private served = new WeakMap<IBlock, ServedBlock>();

	constructor(
		private readonly collectionId: BlockId,
		private readonly transactor: ITransactor,
		public actionContext: ActionContext | undefined,
		collector?: ReadDependencyCollector,
		/** The owning collection's floors, shared with every other read source it builds. Omitted by
		 *  sources that walk the log or are built standalone: their answers are judged against nothing. */
		private readonly floors?: BlockFloorCheck,
	) {
		this.collector = collector ?? new ReadDependencyCollector();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return {
			type,
			id: newId ?? this.generateId(),
			collectionId: this.collectionId,
		};
	}

	generateId(): BlockId {
		// 256-bits to fully utilize DHT address space
		return uint8ArrayToString(randomBytes(32), 'base64url')
	}

	async tryGet(id: BlockId, purpose: ReadPurpose = 'value'): Promise<TBlock | undefined> {
		const result = await this.transactor.get({ blockIds: [id], context: this.actionContext });
		// Guard the per-key entry: some transactors return a sparse result that omits `id`
		// entirely (e.g. block genuinely not found), so `result` is a truthy object but
		// `result[id]` is undefined. Destructuring that would throw a TypeError.
		const entry = result?.[id];
		if (entry) {
			// A throw here records no read dependency: it means nothing was read.
			const block = answeredBlock(id, entry, this.actionContext);
			// Record a read dependency only for a block that actually exists. A transactor may return a
			// populated entry with `block: undefined` for a genuinely-missing block (TestTransactor does;
			// the Network transactor always populates the key); recording there would add a phantom
			// dependency for a nonexistent block. This makes the "absent reads nothing" contract uniform
			// with the sparse-result case (entry omitted) — see transactor-source.spec.ts sparse test.
			if (block) {
				// Record read dependency for optimistic concurrency control, carrying the caller's
				// read purpose (default `value`) so a purely-structural navigation read can later be
				// dropped from the conflict set (see ReadDependencyCollector / Theorem 5).
				// Record the revision the content was MATERIALIZED at, not the newest the repo holds.
				// Both sinks must take the SAME value: CacheSource learns it via getReadRevision on a
				// miss-load and re-emits it on every later hit, so a split would stamp the cache
				// differently from the collector.
				const rev = servedRevision(entry);
				this.collector.record(id, rev, purpose);
				this.readRevisions.set(id, rev);
				this.served.set(block, { rev, mayRetain: this.mayRetain(id, rev) });
			}
			// TODO: if the state reports that there is a pending action, record this so that we are sure to update before syncing
			//state.pendings
			return block as TBlock;
		}
	}

	/** The revision observed the last time this source served {@link id} (from its committed
	 *  state), or undefined if this source has never served it. CacheSource reads this on a
	 *  miss-load to learn the revision to record and store. */
	getReadRevision(id: BlockId): number | undefined {
		return this.readRevisions.get(id);
	}

	/** What this source knows about `block`, an object it returned from {@link tryGet}: the revision
	 *  its content is, and whether a cache may keep it. `undefined` for any other object. CacheSource
	 *  asks this on a miss-load, in preference to the by-id {@link getReadRevision}. */
	describeServed(block: IBlock): ServedBlock | undefined {
		return this.served.get(block);
	}

	/** Whether a cache may keep the block just served for `id` and serve it again without re-asking:
	 * `false` exactly for a below-floor answer — content older than a log entry the collection has
	 * already walked says the block is (see {@link BlockFloorCheck}). The block is handed to the
	 * reader either way.
	 *
	 * NOTE: accepted tradeoff — a below-floor answer is RETURNED (uncached, and reported through the
	 * floors as `collection:block-below-floor`), not refused with BlockPossiblyStaleError. A log entry
	 * is not proof its blocks landed: a refused write can leave its entry in the log while the blocks
	 * it names never take that revision on any machine
	 * (tickets/backlog/bug-a-refused-write-can-leave-its-log-entry-behind). For such an entry the
	 * below-floor content is the CORRECT content and no machine can ever meet the floor, so a throw
	 * would make the block unreadable through every handle that refreshed past the entry — until the
	 * block is next written, which cannot happen through a handle that cannot read it. A throw would
	 * also land inside `Collection.updateInternal`'s replay and leave the tracker half re-staged.
	 * Returning uncached instead restores the bound the storage layer already documents
	 * (docs/transactions.md § Lazy read-repair window): the next read re-asks, so a lagging replica is
	 * seen through within one read-repair window rather than never. Revisit if log entries ever become
	 * proof that their blocks landed (abandoned entries made distinguishable): then an answer still
	 * below its floor after every machine was asked should throw.
	 *
	 * NOTE: while a floor is unmet, every read of that block costs a transactor request instead of a
	 * memory hit — at most one read-repair window for a lagging replica, but until the block is next
	 * written (or the handle reopened) for an abandoned entry. Unmeasured. If it ever shows up, drop
	 * a floor after some number of consecutive below-floor answers from a coordinator other than this
	 * node (floors are otherwise never dropped — see `BlockFloors`). */
	private mayRetain(id: BlockId, servedRev: number): boolean {
		return !this.floors?.answeredBelowFloor(id, this.actionContext, servedRev);
	}

	getReadDependencies(): ReadDependency[] {
		return this.collector.getReadDependencies();
	}

	/** The collector this source records into — the one shared with the collection's
	 *  CacheSource. Exposed ONLY so a pinned read view built with `recordReads: true`
	 *  can feed the same per-transaction read set (see Collection.createReadTracker);
	 *  every other consumer should go through {@link getReadDependencies}. */
	getCollector(): ReadDependencyCollector {
		return this.collector;
	}

	clearReadDependencies(): void {
		this.collector.clear();
	}

	/**
	 * Attempts to apply the given transforms in a transactional manner.
	 * @param transform - The transforms to apply.
	 * @param actionId - The action id.
	 * @param rev - The revision number.
	 * @param headerId - The Id of the collection's header block. Forwarded to the commit only when the header is a
	 * fresh insert, so the collection-identifying metadata (see `CommitRequest.headerId`) is present on the commit
	 * that creates it.
	 * @param tailId - The Id of the collection's log tail block.  This block's transform is committed FIRST
	 * (prior to the rest of the block operations), to resolve the "winner" of a race to commit to the collection.
	 * @param priority - Aged, advisory retry priority (default 0). Rides on the pend so a repeatedly-losing
	 * single-collection sync out-ranks fresh rivals in a concurrent race (`resolveRace`); fairness-only, never
	 * affects validity. Omitted from the pend when 0 so the common first-attempt pend serializes exactly as before.
	 * @param blockDigests - Optional per-block content declarations for this commit (see {@link BlockContentDigests}),
	 * computed by the caller from the same tracker that produced `transform`. Omitted from the commit request when
	 * undefined, so a caller that declares nothing produces exactly the request shape as before — the field rides
	 * inside every cohort signature's hash preimage, so keeping the shape clean keeps those preimages clean.
	 * @returns The transactor's own verdict, unflattened: a {@link CommitSuccess} carrying the
	 * {@link WriteDurability} of the committed revision, or a {@link StaleFailure} if the pend or the commit
	 * was refused. Success is deliberately NOT collapsed to `undefined` — the durability is the only thing
	 * that tells a write every machine holds from one only this machine holds, and a caller that wants the
	 * old boolean reads `result.success`. Test "is this completely saved" through `isFullyDurable`, never
	 * by comparing `quorum` (see {@link WriteDurability}).
	 */
	async transact(transform: Transforms, actionId: ActionId, rev: number, headerId: BlockId, tailId: BlockId, priority = 0, blockDigests?: BlockContentDigests): Promise<CommitResult> {
		const pendResult = await this.transactor.pend({ transforms: transform, actionId, rev, policy: 'r', ...(priority > 0 ? { priority } : {}) });
		if (!pendResult.success) {
			return pendResult;
		}
		const isNew = transform.inserts && Object.hasOwn(transform.inserts, headerId);
		try {
			const commitResult = await this.transactor.commit({
				headerId: isNew ? headerId : undefined,
				tailId,
				blockIds: pendResult.blockIds,
				actionId,
				rev,
				...blockDigestsField(blockDigests)
			});
			if (!commitResult.success) {
				// A confirmed conflict has to be RETURNED as the StaleFailure, because `Collection.sync`
				// and the multi-collection pend phase read it via `isConflictFailure` to decide to
				// rebase — letting the cancel's own failure throw over it would turn a routine,
				// recoverable race into a hard failure. So the cancel fault is logged, not raised.
				await this.dischargePend(actionId, pendResult.blockIds);
			}
			return commitResult;
		} catch (e) {
			// `e` is the real cause — a transport fault, the thing the caller needs to see. A cancel
			// that also fails must not silently take its place, but it must not be lost either: the
			// pend was left undischarged and that is what wedges the block against the caller's own
			// retry. Attach it to `e` so one report names both.
			const cancelError = await this.dischargePend(actionId, pendResult.blockIds);
			if (cancelError !== undefined && e !== null && typeof e === 'object') {
				// A frozen or sealed error would make this assignment throw, and a throw here would
				// replace the cause the caller actually needs. The log above already named the cancel.
				try { (e as { cancelError?: unknown }).cancelError = cancelError; } catch { /* ignore */ }
			}
			throw e;
		}
	}

	/**
	 * Discharges the pending records this attempt left behind, on both of `transact`'s abort paths.
	 *
	 * `ITransactor.cancel` returns only when the records are gone and throws otherwise
	 * (`NetworkTransactor.cancel` retries and then verifies that some peer actually answered), so a
	 * throw here means the block stays wedged against every later writer. That has to be reported —
	 * but never by displacing the verdict the cancel is cleaning up after, so it comes back as a
	 * value rather than propagating.
	 *
	 * @returns the cancel's own failure, or `undefined` when it discharged.
	 */
	private async dischargePend(actionId: ActionId, blockIds: BlockId[]): Promise<unknown> {
		try {
			await this.transactor.cancel({ actionId, blockIds });
			return undefined;
		} catch (cancelError) {
			log('WARN: cancel after failed commit did not discharge actionId=%s blocks=%o: %o', actionId, blockIds, cancelError);
			return cancelError;
		}
	}
}

