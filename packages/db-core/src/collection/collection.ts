import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, BlockStore, Transforms } from "../index.js";
import { Log, Atomic, Tracker, copyTransforms, CacheSource, isTransformsEmpty, TransactorSource } from "../index.js";
import type { CollectionHeaderBlock, CollectionId, ICollection } from "./index.js";
import type { ReadDependency } from "../transaction/transaction.js";
import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { Latches } from "../utility/latches.js";

const PendingRetryDelayMs = 100;

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => IBlock;
	/** Called for each local action that is potentially in conflict with a remote action.
	 * @param action - The local action to check
	 * @param potential - The remote action that is potentially in conflict
	 * @returns The original action, a replacement action (return a new instance; will be
	 * 	applied through act()), or undefined to discard this action
	 */
	filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined
}

/** A point-in-time copy of a collection's staged (un-synced) state, produced by
 * {@link Collection.snapshotPending} and consumed by {@link Collection.restorePending}. */
export interface CollectionSnapshot<TAction> {
	/** Deep-cloned tracker transforms at snapshot time. */
	transforms: Transforms;
	/** Pending actions queued at snapshot time. */
	pending: Action<TAction>[];
}

export class Collection<TAction> implements ICollection<TAction> {
	private pending: Action<TAction>[] = [];
	private readonly latchId: string;

	protected constructor(
		public readonly id: CollectionId,
		public readonly transactor: ITransactor,
		private readonly handlers: Record<ActionType, ActionHandler<TAction>>,
		private readonly source: TransactorSource<IBlock>,
		/** Cache of unmodified blocks from the source */
		private readonly sourceCache: CacheSource<IBlock>,
		/** Tracked Changes */
		public readonly tracker: Tracker<IBlock>,
		private readonly filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined,
	) {
		this.latchId = `Collection:${this.id}`;
	}

	static async createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>) {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information
		const source = new TransactorSource(id, transactor, undefined);
		const sourceCache = new CacheSource(source);
		const tracker = new Tracker(sourceCache);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;

		if (header) {	// Collection already exists
			// Bootstrap ActionContext from the committed tail before walking the chain.
			// This allows the transactor to serve pending non-tail blocks during Log.open.
			await Collection.bootstrapContext(source, transactor, header);

			const log = (await Log.open<Action<TAction>>(tracker, id))!;
			source.actionContext = await log.getActionContext();
		} else {	// Collection does not exist
			const headerBlock = init.createHeaderBlock(id, tracker);
			tracker.insert(headerBlock);
			source.actionContext = undefined;
			await Log.open<Action<TAction>>(tracker, id);
		}

		return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict);
	}

	async act(...actions: Action<TAction>[]) {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.actInternal(...actions);
		} finally {
			release();
		}
	}

	private async actInternal(...actions: Action<TAction>[]) {
		await this.internalTransact(...actions);
		this.pending.push(...actions);
	}

	private async internalTransact(...actions: Action<TAction>[]) {
		const atomic = new Atomic(this.tracker);

		for (const action of actions) {
			const handler = this.handlers[action.type];
			if (!handler) {
				throw new Error(`No handler for action type ${action.type}`);
			}
			await handler(action, atomic);
		}

		atomic.commit();
	}

	/** Load external changes and update our context to the latest log revision - resolve any conflicts with our pending actions. */
	async update() {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.updateInternal();
		} finally {
			release();
		}
	}

	private async updateInternal() {
		// Start with a context that can see to the end of the log
		const source = new TransactorSource(this.id, this.transactor, undefined);
		const tracker = new Tracker(source);

		// Bootstrap context from committed tail so pending blocks are accessible.
		// Read through tracker so Chain.open inside Log.open reuses the cached header.
		const header = await tracker.tryGet(this.id) as CollectionHeaderBlock | undefined;
		if (header) {
			await Collection.bootstrapContext(source, this.transactor, header);
		}

		// Get the latest entries from the log, starting from where we left off
		const actionContext = this.source.actionContext;
		const log = await Log.open<Action<TAction>>(tracker, this.id);
		const latest = log ? await log.getFrom(actionContext?.rev ?? 0) : undefined;

		// Process the entries and track the blocks they affect
		let anyConflicts = false;
		for (const entry of latest?.entries ?? []) {
			// Filter any pending actions that conflict with the remote actions. Each pending
			// action maps to its effective form: the original, a replacement, or dropped.
			const before = this.pending;
			const after = before
				.map(p => this.doFilterConflict(p, entry.actions))
				.filter((a): a is Action<TAction> => a !== undefined);
			// A replacement or a discard changes the pending set; the tracker still holds the
			// pre-filter transforms, so force a replay to re-stage against the effective actions.
			// Identity comparison per the contract: keep => same instance, replace => new instance.
			// NOTE: a filterConflict hook that always allocates a fresh (but equal) instance instead
			// of returning the same one forces a replay on every update — if that ever shows up as a
			// hot path, compare by value/id here instead of by reference.
			const mutated = after.length !== before.length || after.some((a, i) => a !== before[i]);
			this.pending = after;
			this.sourceCache.clear(entry.blockIds);
			anyConflicts = anyConflicts || mutated || this.tracker.conflicts(new Set(entry.blockIds)).length > 0;
		}

		// React to durable invalidations that landed since we last synced. getFrom intentionally skips
		// invalidation entries (they are not pending/committed actions), so surface them separately: an
		// invalidation reverted committed content this client may have read, so treat it like a stale
		// read — drop the reverted blocks from the read cache and replay pending work against the reverted
		// base (docs/right-is-right.md §Client notification). De-duped across cascade children by reverted
		// block; over-inclusive by design (over-invalidation just resubmits — it never wrongly retains).
		const invalidations = log ? await log.getInvalidationsFrom(actionContext?.rev ?? 0) : [];
		if (invalidations.length > 0) {
			const revertedBlockIds = [...new Set(invalidations.flatMap(inv => inv.reverted.map(r => r.blockId)))];
			this.sourceCache.clear(revertedBlockIds);
			if (this.pending.length > 0) {
				anyConflicts = true;
			}
		}

		// On conflicts, clear related caching and block-tracking and replay logical operations
		if (anyConflicts) {
			await this.replayActions();
		}

		// Update our context to the latest
		this.source.actionContext = latest?.context;
	}

	/** Capture the current staged state — tracker transforms plus the pending
	 * action queue — so it can be restored later via {@link restorePending}.
	 *
	 * Use to bracket a unit of staged DML that may need to be rolled back. Unlike
	 * a blanket "reset to empty", restoring this snapshot preserves any structural
	 * baseline that predates the staged DML — most importantly a brand-new
	 * collection's header/root blocks, which live in the tracker (uncommitted)
	 * until the first sync. Resetting such a collection to empty would leave it
	 * unreadable; restoring the snapshot returns it to its prior (readable) state.
	 *
	 * The returned snapshot is deep-cloned and independent of subsequent mutations.
	 * Synchronous and latch-free: intended to bracket transaction-scoped staging,
	 * when no concurrent act/sync is in flight. */
	snapshotPending(): CollectionSnapshot<TAction> {
		return { transforms: copyTransforms(this.tracker.transforms), pending: [...this.pending] };
	}

	/** Restore the staged state captured by {@link snapshotPending}, discarding any
	 * mutations staged since. Reads through the collection then observe exactly the
	 * snapshot state again; storage is untouched because nothing was ever synced. */
	restorePending(snapshot: CollectionSnapshot<TAction>): void {
		this.tracker.reset(copyTransforms(snapshot.transforms));
		this.pending = [...snapshot.pending];
	}

	/** A read-only {@link Tracker} over this collection's committed source cache,
	 * seeded with a (deep-copied) set of pre-transaction transforms. Reads through it
	 * observe committed state plus exactly those transforms — and crucially NOT the
	 * mutations staged into this collection's live tracker afterward. Used to build a
	 * committed read view (see {@link Tree.readView}) that excludes a transaction's
	 * own in-flight rows. The returned tracker shares the source cache (committed
	 * blocks) but has its own independent transform set; it is never sync()'d. */
	createReadTracker(transforms: Transforms): Tracker<IBlock> {
		return new Tracker(this.sourceCache, copyTransforms(transforms));
	}

	/** The staged (not-yet-synced) actions queued by {@link act}.
	 *
	 * Exposed so a {@link TransactionCoordinator} can append them to the log at
	 * commit time — mirroring what {@link sync} does internally — when the actions
	 * were staged directly into this collection (e.g. through a Tree's stage())
	 * rather than applied via the coordinator's own action path. */
	getPendingActions(): Action<TAction>[] {
		return this.pending;
	}

	/** Drop the staged actions after they have been committed through a
	 * coordinator. Counterpart to {@link getPendingActions}; {@link sync} clears
	 * its own pending inline, so this is only needed when commit was orchestrated
	 * externally. */
	clearPendingActions(): void {
		this.pending = [];
	}

	/** Fold a just-committed set of transforms into this collection's read cache
	 * so subsequent reads (and stages) through THIS instance observe the committed
	 * state, mirroring what {@link sync} does inline after a successful transact.
	 *
	 * Needed when commit was orchestrated externally (a coordinator): the tracker
	 * is reset to empty, but the cache still holds the pre-commit blocks. Without
	 * this, a collection that already had committed state (e.g. a pre-synced index
	 * tree, or any collection on its second commit) keeps serving the stale prior
	 * revision because {@link update} sees its rev is already current and refetches
	 * nothing. Call BEFORE resetting the tracker (the transforms are read live). */
	applyCommittedToCache(transforms: Transforms): void {
		this.sourceCache.transformCache(transforms);
	}

	/** Push our pending actions to the transactor */
	async sync() {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.syncInternal();
		} finally {
			release();
		}
	}

	private async syncInternal() {
		const bytes = randomBytes(16);
		const actionId = uint8ArrayToString(bytes, 'base64url');

		while (this.pending.length || !isTransformsEmpty(this.tracker.transforms)) {
			// Snapshot the pending actions so that any new actions aren't assumed to be part of this action
			const pending = [...this.pending];

			// Create a snapshot tracker for the action, so that we can ditch the log changes if we have to retry the action
			const snapshot = copyTransforms(this.tracker.transforms);
			const tracker = new Tracker(this.sourceCache, snapshot);

			// Add the action to the log (in local tracking space)
			const log = await Log.open<Action<TAction>>(tracker, this.id);
			if (!log) {
				throw new Error(`Log not found for collection ${this.id}`);
			}
			const newRev = (this.source.actionContext?.rev ?? 0) + 1;
			const addResult = await log.addActions(pending, actionId, newRev, () => tracker.transformedBlockIds());

			// Commit the action to the transactor
			const staleFailure = await this.source.transact(tracker.transforms, actionId, newRev, this.id, addResult.tailPath.block.header.id);
			if (staleFailure) {
				if (staleFailure.pending) {
					// Wait for short time to allow the pending actions to commit (bounded backoff)
					await new Promise(resolve => setTimeout(resolve, PendingRetryDelayMs));
				}
				// Fetch latest state - updateInternal() will call replayActions() if there are conflicts
				await this.updateInternal();
			} else {
				// Clear the pending actions that were part of this action
				this.pending = this.pending.slice(pending.length);
				// Reset cache and replay any actions that were added during the action
				const transforms = tracker.reset();
				await this.replayActions();
				this.sourceCache.transformCache(transforms);
				this.source.actionContext = this.source.actionContext
					? { committed: [...this.source.actionContext.committed, { actionId, rev: newRev }], rev: newRev }
					: { committed: [{ actionId, rev: newRev }], rev: newRev };
			}
		}
	}

	async updateAndSync() {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.updateInternal();
			await this.syncInternal();
		} finally {
			release();
		}
	}

	async *selectLog(forward = true): AsyncIterableIterator<Action<TAction>> {
		const log = await Log.open<Action<TAction>>(this.tracker, this.id);
		if (!log) {
			throw new Error(`Log not found for collection ${this.id}`);
		}
		for await (const entry of log.select(undefined, forward)) {
			if (entry.action) {
				yield* forward ? entry.action.actions : entry.action.actions.reverse();
			}
		}
	}

	private async replayActions() {
		this.tracker.reset();
		// Replay pending actions against the fresh tracker state (always called under latch)
		for (const action of this.pending) {
			await this.internalTransact(action);
		}
	}

	getReadDependencies(): ReadDependency[] {
		return this.source.getReadDependencies();
	}

	clearReadDependencies(): void {
		this.source.clearReadDependencies();
	}

	/** Called for each local action that may be in conflict with a remote action (always called under latch).
	 * @param action - The local action to check
	 * @param potential - The remote actions that are potentially in conflict
	 * @returns The effective action to keep: the original (unchanged), a replacement
	 * 	instance (applied instead of the original), or undefined to discard it.
	 */
	protected doFilterConflict(action: Action<TAction>, potential: Action<TAction>[]): Action<TAction> | undefined {
		return this.filterConflict ? this.filterConflict(action, potential) : action;
	}

	/** Bootstrap ActionContext from the committed tail block's state.
	 * The tail is always committed first (commit protocol guarantee), so it's readable
	 * with context=undefined. Its state.latest contains the ActionRev of the most recent
	 * committed action — exactly the proof needed for the transactor to serve pending
	 * non-tail blocks during chain walks.
	 */
	private static async bootstrapContext(
		source: TransactorSource<IBlock>,
		transactor: ITransactor,
		header: CollectionHeaderBlock,
	): Promise<void> {
		const tailId = header.tailId;
		if (tailId) {
			const tailResult = await transactor.get({ blockIds: [tailId] });
			const tailState = tailResult?.[tailId]?.state;
			if (tailState?.latest) {
				source.actionContext = {
					committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
					rev: tailState.latest.rev,
				};
			}
		}
	}
}
