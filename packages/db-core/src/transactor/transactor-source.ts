import { randomBytes } from '@noble/hashes/utils.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, BlockId, BlockHeader, ITransactor, ActionId, StaleFailure, ActionContext, BlockType, BlockSource, ReadPurpose, Transforms } from "../index.js";
import type { ReadDependency } from "../transaction/transaction.js";
import { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";

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
			const { block, state } = entry;
			// Record a read dependency only for a block that actually exists. A transactor may return a
			// populated entry with `block: undefined` for a genuinely-missing block (TestTransactor does;
			// the Network transactor always populates the key); recording there would add a phantom
			// dependency for a nonexistent block. This makes the "absent reads nothing" contract uniform
			// with the sparse-result case (entry omitted) — see transactor-source.spec.ts sparse test.
			if (block) {
				// Record read dependency for optimistic concurrency control, carrying the caller's
				// read purpose (default `value`) so a purely-structural navigation read can later be
				// dropped from the conflict set (see ReadDependencyCollector / Theorem 5).
				const rev = state.latest?.rev ?? 0;
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

	clearReadDependencies(): void {
		this.collector.clear();
	}

	/**
	 * Attempts to apply the given transforms in a transactional manner.
	 * @param transform - The transforms to apply.
	 * @param actionId - The action id.
	 * @param rev - The revision number.
	 * @param headerId - The Id of the collection's header block.  If specified, this block's transform is performed first,
	 * in the event that there is a race to create the collection itself, or in the event that the tail block is full and
	 * is transitioning to a new block.  Ignored if the given headerId is not present in the transforms.
	 * @param tailId - The Id of the collection's log tail block.  If specified, this block's transform is performed next
	 * (prior to the rest of the block operations), to resolve the "winner" of a race to commit to the collection.
	 * @param priority - Aged, advisory retry priority (default 0). Rides on the pend so a repeatedly-losing
	 * single-collection sync out-ranks fresh rivals in a concurrent race (`resolveRace`); fairness-only, never
	 * affects validity. Omitted from the pend when 0 so the common first-attempt pend serializes exactly as before.
	 * @returns A promise that resolves to undefined if the action is successful, or a StaleFailure if the action is stale.
	 */
	async transact(transform: Transforms, actionId: ActionId, rev: number, headerId: BlockId, tailId: BlockId, priority = 0): Promise<undefined | StaleFailure> {
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
				rev
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

