import { randomBytes } from '@noble/hashes/utils.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, BlockId, BlockHeader, ITransactor, ActionId, StaleFailure, ActionContext, BlockType, BlockSource, ReadPurpose, Transforms, BlockContentDigests } from "../index.js";
import { BlockUnavailableError, BlockPossiblyStaleError } from "../network/struct.js";
import type { ReadDependency } from "../transaction/transaction.js";
import { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";
import { blockDigestsField } from "../transform/digest.js";

export class TransactorSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	/** Shared with this collection's CacheSource so cache hits also record dependencies.
	 *  Defaults to a private instance so internal log-walk sources (which never need a
	 *  transaction read set) work standalone. */
	private readonly collector: ReadDependencyCollector;
	/** Last revision observed per id, so CacheSource can learn the revision on a miss-load
	 *  (it calls {@link getReadRevision} right after this source serves the block). */
	private readRevisions = new Map<BlockId, number>();

	constructor(
		private readonly collectionId: BlockId,
		private readonly transactor: ITransactor,
		public actionContext: ActionContext | undefined,
		collector?: ReadDependencyCollector,
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
			const { block, state, materialized, unavailable, unconfirmedAheadRev } = entry;
			// An entry flagged `unavailable` with no block is the repo saying "I could not find
			// out whether this exists" — an answer that must not be read as absent. Throw rather
			// than return undefined, and record no read dependency (dependencies are recorded
			// only for blocks that actually exist). A repo that omits the flag stays authoritative.
			if (!block && unavailable) {
				throw new BlockUnavailableError(id, unavailable);
			}
			// A read whose surviving answer is marked possibly-behind (`unconfirmedAheadRev`
			// outlived the transactor's retry round: every reachable coordinator served content it
			// could not confirm current) must not pose as an answer for a view that should CONTAIN
			// the claimed revision. Two such views, the same test the coordinator applies when it
			// stamps: an UNPINNED "give me latest" read — the tail read is the one seam where a
			// lagging collection can learn the truth (Collection.bootstrapContext), and silently
			// serving doubted content there is exactly how a collection view freezes forever — and
			// a read PINNED AT OR ABOVE the claim, whose snapshot is missing a revision the cohort
			// says exists inside it. A read pinned strictly BELOW the claim keeps working: it
			// legitimately asks for an older view, which is being served correctly.
			// No read dependency is recorded: the throw means nothing was read.
			// NOTE: accepted tradeoff — this converts a silent wrong answer into a loud failure. A
			// node partitioned from every coordinator able to confirm currency used to read (stale)
			// data indefinitely without any signal; it now raises BlockPossiblyStaleError on the
			// reads that should contain the claim, until the partition heals or the claim is
			// settled. Deliberate: the
			// silent alternative is a collection view that forks and freezes with no report
			// (ticket coordinator-serves-stale-data-as-if-confirmed). Revisit only if a
			// degraded-read mode (serve-with-warning) becomes a product requirement.
			if (unconfirmedAheadRev !== undefined
				&& (this.actionContext === undefined || this.actionContext.rev >= unconfirmedAheadRev)) {
				throw new BlockPossiblyStaleError(id, unconfirmedAheadRev);
			}
			// Record a read dependency only for a block that actually exists. A transactor may return a
			// populated entry with `block: undefined` for a genuinely-missing block (TestTransactor does;
			// the Network transactor always populates the key); recording there would add a phantom
			// dependency for a nonexistent block. This makes the "absent reads nothing" contract uniform
			// with the sparse-result case (entry omitted) — see transactor-source.spec.ts sparse test.
			if (block) {
				// Record read dependency for optimistic concurrency control, carrying the caller's
				// read purpose (default `value`) so a purely-structural navigation read can later be
				// dropped from the conflict set (see ReadDependencyCollector / Theorem 5).
				// Record the revision the content was MATERIALIZED at, not the newest the repo holds —
				// see {@link GetBlockResult.materialized} for why `state.latest` is the wrong number
				// and why the fallback preserves today's behaviour for repos that omit the field.
				// Both sinks must take the SAME value: CacheSource learns it via getReadRevision on a
				// miss-load and re-emits it on every later hit, so a split would stamp the cache
				// differently from the collector.
				const rev = materialized?.rev ?? state.latest?.rev ?? 0;
				this.collector.record(id, rev, purpose);
				this.readRevisions.set(id, rev);
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
	 * @param tailId - The Id of the collection's log tail block.  If specified, this block's transform is performed next
	 * (prior to the rest of the block operations), to resolve the "winner" of a race to commit to the collection.
	 * @param priority - Aged, advisory retry priority (default 0). Rides on the pend so a repeatedly-losing
	 * single-collection sync out-ranks fresh rivals in a concurrent race (`resolveRace`); fairness-only, never
	 * affects validity. Omitted from the pend when 0 so the common first-attempt pend serializes exactly as before.
	 * @param blockDigests - Optional per-block content declarations for this commit (see {@link BlockContentDigests}),
	 * computed by the caller from the same tracker that produced `transform`. Omitted from the commit request when
	 * undefined, so a caller that declares nothing produces exactly the request shape as before — the field rides
	 * inside every cohort signature's hash preimage, so keeping the shape clean keeps those preimages clean.
	 * @returns A promise that resolves to undefined if the action is successful, or a StaleFailure if the action is stale.
	 */
	async transact(transform: Transforms, actionId: ActionId, rev: number, headerId: BlockId, tailId: BlockId, priority = 0, blockDigests?: BlockContentDigests): Promise<undefined | StaleFailure> {
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
				await this.transactor.cancel({ actionId, blockIds: pendResult.blockIds });
				return commitResult;
			}
		} catch (e) {
			await this.transactor.cancel({ actionId, blockIds: pendResult.blockIds });
			throw e;
		}
	}
}

