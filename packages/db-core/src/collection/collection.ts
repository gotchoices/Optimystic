import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, BlockStore, Transforms, ActionId } from "../index.js";
import { Log } from "../log/log.js";
import { Atomic } from "../transform/atomic.js";
import { Tracker } from "../transform/tracker.js";
import { CacheSource } from "../transform/cache-source.js";
import { copyTransforms, isTransformsEmpty } from "../transform/helpers.js";
import { TransactorSource } from "../transactor/transactor-source.js";
import { BlockUnavailableError, BlockPossiblyStaleError } from "../network/struct.js";
import type { CollectionHeaderBlock, CollectionId, ICollection, SyncOptions } from "./index.js";
import { CollectionHeaderVanishedError, SyncRetryExhaustedError } from "./struct.js";
import type { ActionContext } from "./action.js";
import type { ReadDependency } from "../transaction/transaction.js";
import { clampPriority } from "../transaction/transaction.js";
import { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";
import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { Latches } from "../utility/latches.js";
import { jitteredBackoffMs, abortableDelay, makeAbortError } from "../utility/backoff.js";
import { createLogger } from "../logger.js";

const log = createLogger('collection');

/** Default base backoff (and historical fixed delay) between sync retries, in ms. */
const PendingRetryDelayMs = 100;
/** Default max consecutive no-progress stale-failure retries before {@link Collection.sync} gives up. */
const DefaultMaxAttempts = 10;
/** Default ceiling on a single exponential-backoff sleep, in ms. */
const DefaultMaxBackoffMs = 5000;

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => IBlock;
	/** Called for each local action that is potentially in conflict with a remote action.
	 * @param action - The local action to check
	 * @param potential - The remote actions that are potentially in conflict
	 * @returns The original action (return the same instance to keep it as-is), a replacement
	 * 	action (return a new instance to apply instead of the original — it is re-staged via
	 * 	the conflict replay), or undefined to discard this action
	 */
	filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined
}

/** Options for building a committed read view (see {@link Collection.createReadTracker}
 * and `Tree.readView`). */
export interface ReadViewOptions {
	/** Record read dependencies into the collection's shared collector.
	 *  Default false — a pinned committed view is not part of any transaction's
	 *  conflict set, so its reads must not be able to fail the writer's commit
	 *  validation. Deferred-constraint safety does not depend on these reads:
	 *  validator peers re-execute the transaction's recorded statements against
	 *  their own committed state, so a constraint that no longer holds is caught
	 *  at validation regardless. */
	recordReads?: boolean;
	/** Pin the view to this committed boundary instead of the collection's CURRENT
	 *  action context. Pass a {@link CollectionSnapshot.context} so the view describes
	 *  the same committed moment the snapshot's transforms sat on — even when the
	 *  collection has committed further since (e.g. a multi-tree commit sweep that has
	 *  already flushed THIS tree but not its siblings). Blocks cached at revisions
	 *  newer than the pin are excluded from the view's warm seed and refetched from
	 *  the transactor at the pinned revision. Default: the current context. */
	pinContext?: ActionContext;
}

/** A point-in-time copy of a collection's staged (un-synced) state, produced by
 * {@link Collection.snapshotPending} and consumed by {@link Collection.restorePending}. */
export interface CollectionSnapshot<TAction> {
	/** Deep-cloned tracker transforms at snapshot time. */
	transforms: Transforms;
	/** Pending actions queued at snapshot time. */
	pending: Action<TAction>[];
	/** The committed boundary (action context) the staged state sat on when captured.
	 *  `undefined` for a collection with no committed revision yet (an invented
	 *  collection whose header/root still live in the tracker). A read view built
	 *  from this snapshot pins to this boundary (see {@link ReadViewOptions.pinContext}),
	 *  so the view stays coherent with the snapshot's transforms even if the
	 *  collection commits further before the view is built. */
	context?: ActionContext;
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

	/** Open an EXISTING collection.
	 *
	 * Resolves to `undefined` when the header block probe comes back empty — an
	 * authoritatively absent header, meaning nothing has ever been committed under this id.
	 * A header the storage layer could not RETRIEVE (a revision this node cannot
	 * reconstruct, an unreachable cohort) is not absent: the probe throws
	 * {@link BlockUnavailableError} instead of resolving `undefined`, so an unreachable
	 * collection can never be mistaken for a nonexistent one.
	 *
	 * Use this wherever reading — not creating — is what was meant. {@link createOrOpen}
	 * would instead stage a fresh empty collection, and reads through it would report an
	 * absent dataset as a legitimately empty one. */
	static async open<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>): Promise<Collection<TAction> | undefined> {
		const { source, sourceCache, tracker, header } = await Collection.probeHeader(transactor, id);
		if (!header) {
			// Return before anything is staged: the tracker's transforms stay empty, so a caller
			// that ignores the undefined cannot later sync a phantom collection into existence.
			return undefined;
		}
		await Collection.attachToLog<TAction>(source, transactor, tracker, id, header);
		return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict);
	}

	/** Open an existing collection, or stage a fresh empty one in the local tracker when the
	 * header is authoritatively absent. Nothing is written to storage until {@link sync}.
	 *
	 * Correct only where inventing a collection is genuinely intended — a first write, a
	 * bootstrap path. The create branch logs `collection:invented`; prefer {@link open} on
	 * any pure read path. */
	static async createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>): Promise<Collection<TAction>> {
		const { source, sourceCache, tracker, header } = await Collection.probeHeader(transactor, id);

		if (header) {	// Collection already exists
			await Collection.attachToLog<TAction>(source, transactor, tracker, id, header);
		} else {	// Collection does not exist
			log('collection:invented id=%s — no committed header found; staging a fresh empty collection', id);
			const headerBlock = init.createHeaderBlock(id, tracker);
			tracker.insert(headerBlock);
			source.actionContext = undefined;
			await Log.open<Action<TAction>>(tracker, id);
		}

		return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict);
	}

	/** The per-instance read wiring every open path needs, plus the header probe result.
	 * Shared by {@link open} and {@link createOrOpen} so the two cannot drift. */
	private static async probeHeader(transactor: ITransactor, id: CollectionId): Promise<{
		source: TransactorSource<IBlock>,
		sourceCache: CacheSource<IBlock>,
		tracker: Tracker<IBlock>,
		header: CollectionHeaderBlock | undefined,
	}> {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information.
		// One shared read-dependency collector feeds both the source (direct structural reads) and the cache (every
		// cache hit/miss), so a block read from either layer records a dependency — cache hits included.
		const collector = new ReadDependencyCollector();
		const source = new TransactorSource(id, transactor, undefined, collector);
		const sourceCache = new CacheSource(source, undefined, collector);
		const tracker = new Tracker(sourceCache);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
		return { source, sourceCache, tracker, header };
	}

	/** Walk an existing collection's log and point the source at its latest action context.
	 * A header we just probed successfully but whose log will not open is a fault, not an
	 * absence — throw rather than let the collection read as empty. (The re-read goes through
	 * the tracker/cache, so it can disagree with the probe when storage is flaky mid-open.) */
	private static async attachToLog<TAction>(
		source: TransactorSource<IBlock>,
		transactor: ITransactor,
		tracker: Tracker<IBlock>,
		id: CollectionId,
		header: CollectionHeaderBlock,
	): Promise<void> {
		// Bootstrap ActionContext from the committed tail before walking the chain.
		// This allows the transactor to serve pending non-tail blocks during Log.open.
		await Collection.bootstrapContext(source, transactor, header);

		const collectionLog = await Log.open<Action<TAction>>(tracker, id);
		if (!collectionLog) {
			throw new Error(`Log not found for collection ${id}`);
		}
		// Monotonic, not an overwrite: getActionContext resolves undefined when the chain has no
		// tail or the tail block carries zero entries, and that must not erase the revision
		// bootstrapContext just read off the committed tail.
		Collection.advanceContext(source, id, await collectionLog.getActionContext());
	}

	/** Adopt a freshly-read action context WITHOUT ever lowering the revision already held.
	 *
	 * The revision a collection last committed at is knowledge it earned; a read that found
	 * nothing — or found an older view of the log — cannot un-earn it. Silently accepting the
	 * lower value makes the next sync ask for a revision that is long gone, and every retry
	 * repeats the same doomed request because each retry re-runs the same losing read.
	 *
	 * Equal revisions still adopt `next`: the rev is unchanged but its `committed` list may be
	 * more complete than what we hold. */
	private static advanceContext(source: TransactorSource<IBlock>, id: CollectionId, next: ActionContext | undefined): void {
		const current = source.actionContext;
		if (next === undefined) {
			return;	// The read learned nothing — keep what we already know.
		}
		if (current !== undefined && next.rev < current.rev) {
			log('collection:context-not-lowered id=%s held=%d read=%d', id, current.rev, next.rev);
			return;
		}
		source.actionContext = next;
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
		// A header the storage layer could not retrieve throws BlockUnavailableError out of
		// this read (it is not a StaleFailure, so sync's retry loop does not absorb it).
		const header = await tracker.tryGet(this.id) as CollectionHeaderBlock | undefined;
		if (header) {
			await Collection.bootstrapContext(source, this.transactor, header);
		} else if (this.source.actionContext) {
			// An absent header is only believable for a collection that has never committed.
			// We hold a committed revision, so the two answers contradict each other — surface it
			// as a fault instead of no-opping into a forgotten revision and a rev-1 retry spin.
			// NOTE: this aborts every caller of update(), including TransactionCoordinator's
			// blanket refresh of ALL registered collections between commit retries — a
			// non-participant with a momentarily-absent header now fails the whole retry rather
			// than being skipped. That is the intended loud failure; if it ever shows up as
			// otherwise-healthy transactions aborting, narrow that refresh to the transaction's
			// participants (see the note at coordinator.ts's update loop) rather than softening
			// this throw.
			throw new CollectionHeaderVanishedError(this.id, this.source.actionContext.rev);
		}
		// Falling through means the header is genuinely absent AND we hold no revision: nothing
		// was ever committed under this id. Log.open reads the same block id, so it too resolves
		// undefined and everything below no-ops — correct here, rather than a masked failure.

		// Get the latest entries from the log, starting from where we left off
		const actionContext = this.source.actionContext;
		const collectionLog = await Log.open<Action<TAction>>(tracker, this.id);
		const latest = collectionLog ? await collectionLog.getFrom(actionContext?.rev ?? 0) : undefined;

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
		const invalidations = collectionLog ? await collectionLog.getInvalidationsFrom(actionContext?.rev ?? 0) : [];
		if (invalidations.length > 0) {
			const revertedBlockIds = [...new Set(invalidations.flatMap(inv => inv.reverted.map(r => r.blockId)))];
			this.sourceCache.clear(revertedBlockIds);
			if (this.pending.length > 0) {
				anyConflicts = true;
			}
		}

		// Update our context to the latest — monotonically. An empty/unopenable log yields no
		// context at all, and a log read that lags what we already committed yields an older one;
		// neither is grounds for forgetting the revision we hold. This must happen BEFORE
		// replayActions below: replay re-reads blocks through this.source, which materializes
		// content at this.actionContext.rev — if the cursor hasn't advanced yet, replay re-reads
		// at the revision we're leaving and refills the cache with stale content that nothing
		// will invalidate again (the log entry that would have cleared it was already consumed).
		Collection.advanceContext(this.source, this.id, latest?.context);

		// On conflicts, re-stage the pending actions against the adopted revision. The affected
		// blocks were already dropped from sourceCache above (per log entry / per invalidation),
		// so the replay's reads re-materialize from the transactor.
		// NOTE: a throw out of replayActions leaves the tracker holding only the transforms
		// replayed so far while `pending` still lists them all; the caller's error handling is
		// expected to abort/reset the collection rather than keep staging. If replay ever gains a
		// routinely-throwing read path, rebuild into a scratch tracker and swap on success.
		if (anyConflicts) {
			await this.replayActions();
		}
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
		return {
			transforms: copyTransforms(this.tracker.transforms),
			pending: [...this.pending],
			context: structuredClone(this.source.actionContext),
		};
	}

	/** Restore the staged state captured by {@link snapshotPending}, discarding any
	 * mutations staged since. Reads through the collection then observe exactly the
	 * snapshot state again; storage is untouched because nothing was ever synced. */
	restorePending(snapshot: CollectionSnapshot<TAction>): void {
		this.tracker.reset(copyTransforms(snapshot.transforms));
		this.pending = [...snapshot.pending];
	}

	/** A read-only {@link Tracker} pinned to this collection's committed state AS OF the
	 * moment of this call, seeded with a (deep-copied) set of pre-transaction transforms.
	 * Reads through it observe exactly that revision plus exactly those transforms — NOT
	 * the mutations staged into this collection's live tracker afterward, and NOT commits
	 * that fold into (or clear) the live read cache while the view is being walked. Used
	 * to build a committed read view (see {@link Tree.readView}) that a scan can trust
	 * from first row to last.
	 *
	 * The pinning has three legs, built in ONE synchronous block so they all describe the
	 * same instant (do not introduce an await between them):
	 *  - a private {@link TransactorSource} whose action context is a deep copy FROZEN at
	 *    view-creation time, so a block first read after a later commit still materializes
	 *    at the pinned revision (the transactor honours `context.rev` on get);
	 *  - a private {@link CacheSource} nothing else references, so the live collection's
	 *    `transformCache`/`clear` cannot reach it;
	 *  - that private cache is seeded from the shared cache's current entries, so the
	 *    common committed read (deferred CHECK over a warm cache) stays warm instead of
	 *    refetching every block over the network.
	 *
	 * By default the view records NO read dependencies — it is not part of any
	 * transaction's conflict set (see {@link ReadViewOptions.recordReads}).
	 *
	 * NOTE: each view holds up to the cache LRU budget (128) of cloned blocks plus
	 * whatever it faults in. Views are per-scan and dropped when the scan ends; a very
	 * long-lived committed scan pins that much memory.
	 *
	 * NOTE: an INVENTED collection (createOrOpen found no header, so `actionContext` is
	 * undefined) pins to no revision — its private source asks the transactor for the
	 * latest. Harmless today because such a collection's blocks all live in the tracker
	 * transforms, so a view never reaches storage; if invented collections ever gain
	 * committed blocks not covered by their transforms, this view would follow storage
	 * forward instead of staying pinned.
	 *
	 * When {@link ReadViewOptions.pinContext} is supplied, the view pins to THAT
	 * boundary instead of the current context, and cache entries committed at a newer
	 * revision are dropped from the seed (they would otherwise be served blindly — the
	 * cache never checks a hit against the requested context). Dropped entries are
	 * refetched from the transactor, which resolves the highest committed revision at
	 * or below the pin. This is what lets a snapshot captured BEFORE a commit still
	 * yield a coherent pre-commit view AFTER that commit folded into the shared cache
	 * (a mid-sweep multi-tree commit being the motivating case). */
	createReadTracker(transforms: Transforms, options?: ReadViewOptions): Tracker<IBlock> {
		const collector = options?.recordReads ? this.source.getCollector() : undefined;
		const pinContext = options?.pinContext ?? this.source.actionContext;
		const pinRev = options?.pinContext?.rev;
		let seed = this.sourceCache.snapshotEntries();
		if (pinRev !== undefined) {
			// NOTE: entries whose revision the cache never learned read as 0 and pass this
			// filter. Committed blocks always carry a real revision (the transactor reports
			// it on load; transformCache stamps it on fold), so a rev-0 entry newer than the
			// pin does not occur on the paths that reach here.
			seed = seed.filter(([, , revision]) => revision <= pinRev);
		}
		const pinnedSource = new TransactorSource<IBlock>(
			this.id, this.transactor, structuredClone(pinContext), collector);
		const pinnedCache = new CacheSource<IBlock>(
			pinnedSource, undefined, collector, seed);
		return new Tracker(pinnedCache, copyTransforms(transforms));
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

	/** Whether {@link sync} has anything to push: staged actions, or tracker transforms
	 * that were never committed (an INVENTED collection's header/root blocks live there
	 * until its first sync, with no pending action to name them).
	 *
	 * This is the exact predicate {@link syncInternal} loops on, so `false` means a sync
	 * would commit nothing. Exposed so a caller that would otherwise flush
	 * unconditionally can skip the round trip — note that {@link Tree.sync} routes
	 * through {@link updateAndSync}, so an unnecessary flush still pays a full,
	 * cache-bypassing {@link update} before discovering it has nothing to do. */
	hasUnsyncedChanges(): boolean {
		return this.pending.length > 0 || !isTransformsEmpty(this.tracker.transforms);
	}

	/** The committed revision this collection currently READS at, or `undefined` for an
	 * INVENTED collection that has never adopted a committed revision
	 * ({@link createOrOpen} found no header and staged a fresh empty one).
	 *
	 * Not the revision a pending write will land at: {@link getNextRev} is this plus one
	 * (`undefined` counting as 0), so a diagnostic that prints this value BEFORE a commit
	 * is naming the revision the commit will supersede, not the one it produces.
	 *
	 * DIAGNOSTIC ONLY — do not branch on this. Every block this collection reads is
	 * materialized at this revision ({@link TransactorSource.tryGet} passes it as the
	 * read context), and the revision advances ONLY through an explicit call on THIS
	 * instance — {@link update} or {@link sync} on the single-node path, or
	 * {@link recordCommitted} when a {@link TransactionCoordinator} commits this
	 * collection (the session/consensus path, where no `update()` is involved at all).
	 * Nothing moves it passively — not time, not another collection's
	 * commit, not a peer's notification. So a collection sitting here at a lagging
	 * revision silently serves an old root with no error, and two collections in one
	 * process can be at different revisions at the same instant. That gap is invisible
	 * from outside the class without this accessor, which is the whole reason it
	 * exists: `docs/debugging.md` (§ "Which revision did a read descend?") explains
	 * how an operator reads the difference. */
	committedRevision(): number | undefined {
		return this.source.actionContext?.rev;
	}

	/** The id of the action that PRODUCED the revision {@link committedRevision} reports —
	 * this collection's lineage marker at that revision — or `undefined` when the action
	 * context holds no entry at the current revision.
	 *
	 * `undefined` is legitimate, not an error, and has exactly two causes. An INVENTED
	 * collection has no context at all. Otherwise the current revision's slot in the log
	 * belongs to an entry that carries no action — a CHECKPOINT or an INVALIDATION entry
	 * takes a revision of its own — so a context freshly read off such a log
	 * ({@link Log.getActionContext}, {@link Log.getFrom}) holds no `ActionRev` at its own
	 * `rev`. A caller printing this must therefore carry a placeholder rather than invent
	 * an id. The contexts this class writes itself ({@link recordCommitted}, the inline
	 * bump in `syncInternal`, {@link bootstrapContext}) always do hold one.
	 *
	 * NOTE: linear in `committed`, which grows one entry per commit between context reads;
	 * fine now — every caller is a `debug`-gated diagnostic behind `log.enabled`, so this
	 * does not run on a normal path at all. If a non-diagnostic caller ever appears, index
	 * the lookup or search from the end (the entry at `rev` is normally the last one).
	 *
	 * DIAGNOSTIC ONLY — do not branch on this. Its value is the one thing about a revision
	 * that IS comparable across collections and across nodes: a revision number is
	 * per-collection and says nothing on its own, so two nodes reporting the same
	 * collection id at the same revision are indistinguishable between "one collection,
	 * one node lagging" and "two separately-built collections each counting from 1". Equal
	 * action ids mean one lineage; different action ids at the same revision mean two.
	 * `docs/debugging.md` (§ "Which revision did a read descend?") spells out how an
	 * operator reads the pair. */
	committedActionId(): ActionId | undefined {
		const context = this.source.actionContext;
		if (context === undefined) return undefined;
		return context.committed.find(entry => entry.rev === context.rev)?.actionId;
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
	 * nothing. Call BEFORE resetting the tracker (the transforms are read live).
	 *
	 * @param revision - the committed revision these transforms land at (from
	 * {@link recordCommitted}), so cached read-dependency revisions advance to it. */
	applyCommittedToCache(transforms: Transforms, revision: number): void {
		this.sourceCache.transformCache(transforms, revision);
	}

	/** Next revision this collection would commit at (current committed rev + 1). */
	getNextRev(): number {
		return (this.source.actionContext?.rev ?? 0) + 1;
	}

	/** Record a just-committed action: append its ActionRev to the committed list
	 *  and advance the revision. Returns the new revision. Mirrors the inline bump
	 *  in {@link syncInternal}. */
	recordCommitted(actionId: ActionId): number {
		const rev = this.getNextRev();
		this.source.actionContext = {
			committed: [...(this.source.actionContext?.committed ?? []), { actionId, rev }],
			rev,
		};
		return rev;
	}

	/** Push our pending actions to the transactor */
	async sync(options?: SyncOptions) {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.syncInternal(options);
		} finally {
			release();
		}
	}

	private async syncInternal(options?: SyncOptions) {
		const bytes = randomBytes(16);
		const actionId = uint8ArrayToString(bytes, 'base64url');

		const maxAttempts = options?.maxAttempts ?? DefaultMaxAttempts;
		const baseBackoffMs = options?.baseBackoffMs ?? PendingRetryDelayMs;
		const maxBackoffMs = options?.maxBackoffMs ?? DefaultMaxBackoffMs;
		const deadlineMs = options?.deadlineMs;
		const signal = options?.signal;
		const startedAt = Date.now();

		// Count of consecutive stale failures that made no forward progress. Reset to 0 on every
		// successful transact, so the cap bounds only a persistently-failing sync — a legitimate
		// large multi-batch sync (which iterates many times committing progress) never trips it.
		let consecutiveFailures = 0;
		let lastReason: string | undefined;
		// Last confirmed revision a responder reported holding. Purely diagnostic — it is reported
		// in the exhaustion error and never consulted to decide whether to keep retrying.
		let lastStaleAt: { blockId: BlockId; rev: number } | undefined;

		while (this.hasUnsyncedChanges()) {
			if (signal?.aborted) {
				throw makeAbortError(signal);
			}
			// Progress-agnostic ceiling: give up if the wall-clock deadline passed.
			if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
				throw new SyncRetryExhaustedError(this.id, consecutiveFailures, lastReason ?? 'deadline exceeded', lastStaleAt);
			}

			// Snapshot the pending actions so that any new actions aren't assumed to be part of this action
			const pending = [...this.pending];

			// Create a snapshot tracker for the action, so that we can ditch the log changes if we have to retry the action
			const snapshot = copyTransforms(this.tracker.transforms);
			const tracker = new Tracker(this.sourceCache, snapshot);

			// Add the action to the log (in local tracking space)
			const collectionLog = await Log.open<Action<TAction>>(tracker, this.id);
			if (!collectionLog) {
				throw new Error(`Log not found for collection ${this.id}`);
			}
			const newRev = (this.source.actionContext?.rev ?? 0) + 1;
			const addResult = await collectionLog.addActions(pending, actionId, newRev, () => tracker.transformedBlockIds());

			// Commit the action to the transactor. Carry the aged retry priority derived from the
			// consecutive-failure count so a sync that keeps losing concurrent races out-ranks fresh
			// (priority-0) rivals in the cluster's resolveRace (fairness-only; capped at MaxPriority).
			// First attempt has consecutiveFailures == 0, so priority 0 — the common pend is unchanged.
			const staleFailure = await this.source.transact(tracker.transforms, actionId, newRev, this.id, addResult.tailPath.block.header.id, clampPriority(consecutiveFailures));
			if (staleFailure) {
				consecutiveFailures++;
				lastReason = staleFailure.reason ?? lastReason;
				lastStaleAt = staleFailure.staleAt ?? lastStaleAt;
				// Give up once the consecutive no-progress budget is exhausted, so a transactor that
				// persistently rejects the sync can no longer hold the collection latch forever.
				// NOTE: this also bounds the legitimate `pending`-wait case (retrying the same action
				// while another commit is in flight), which used to retry indefinitely. Default 10
				// attempts ≈ 21s of exponential backoff. If a high-contention workload legitimately
				// needs to wait longer for a pending commit to clear, raise maxAttempts for that caller.
				if (consecutiveFailures >= maxAttempts) {
					throw new SyncRetryExhaustedError(this.id, consecutiveFailures, lastReason, lastStaleAt);
				}
				// Back off before every retry (any stale failure — reason/missing/pending), growing
				// exponentially from the base delay up to the cap, with proportional random jitter so a
				// herd of clients that lost the same race does not re-collide on the next tick (see
				// utility/backoff.ts). The abortable sleep lets an aborted sync reject promptly instead
				// of finishing the sleep.
				// NOTE: the `missing`/`reason` conflict paths now pay this backoff too (they previously
				// retried with zero delay); that is what stops the persistent-`reason` hot spin. If a
				// high-contention workload ever shows this base delay as recovery latency, lower
				// baseBackoffMs for that caller rather than reintroducing the zero-delay retry.
				const delay = jitteredBackoffMs(consecutiveFailures - 1, { baseMs: baseBackoffMs, capMs: maxBackoffMs }, options?.rand);
				await abortableDelay(delay, signal);
				// Fetch latest state - updateInternal() will call replayActions() if there are conflicts
				await this.updateInternal();
			} else {
				// Forward progress: reset the no-progress budget.
				consecutiveFailures = 0;
				lastReason = undefined;
				lastStaleAt = undefined;
				// Clear the pending actions that were part of this action
				this.pending = this.pending.slice(pending.length);
				// Reset cache and replay any actions that were added during the action
				const transforms = tracker.reset();
				await this.replayActions();
				this.sourceCache.transformCache(transforms, newRev);
				this.source.actionContext = this.source.actionContext
					? { committed: [...this.source.actionContext.committed, { actionId, rev: newRev }], rev: newRev }
					: { committed: [{ actionId, rev: newRev }], rev: newRev };
			}
		}
	}

	async updateAndSync(options?: SyncOptions) {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.updateInternal();
			await this.syncInternal(options);
		} finally {
			release();
		}
	}

	async *selectLog(forward = true): AsyncIterableIterator<Action<TAction>> {
		const collectionLog = await Log.open<Action<TAction>>(this.tracker, this.id);
		if (!collectionLog) {
			throw new Error(`Log not found for collection ${this.id}`);
		}
		for await (const entry of collectionLog.select(undefined, forward)) {
			if (entry.action) {
				// NOTE: copy-then-reverse to avoid mutating the stored log entry array.
				// Once tsconfig targets ES2023, `entry.action.actions.toReversed()` is cleaner.
				yield* forward ? entry.action.actions : [...entry.action.actions].reverse();
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
	 *
	 * This read goes to the transactor directly rather than through {@link TransactorSource},
	 * so it has to honour the `unavailable` flag itself: a tail the repo could not retrieve
	 * must not degrade into "no context", which would leave the chain walk unable to see
	 * pending non-tail blocks and the collection reading as if they did not exist. A tail
	 * with no `state.latest` and NO flag is a real answer (nothing committed yet) and still
	 * no-ops.
	 *
	 * The same goes for `unconfirmedAheadRev`: this unpinned tail read is the ONE seam where a
	 * lagging collection can learn a newer revision exists — every later data read is pinned to
	 * the context seeded here. Silently seeding from a tail the repo could not confirm is
	 * current would freeze the collection at the stale revision with nothing ever reporting a
	 * problem, so it throws the same way TransactorSource.tryGet does for its unpinned reads
	 * (see the tradeoff NOTE there).
	 */
	private static async bootstrapContext(
		source: TransactorSource<IBlock>,
		transactor: ITransactor,
		header: CollectionHeaderBlock,
	): Promise<void> {
		const tailId = header.tailId;
		if (tailId) {
			const tailResult = await transactor.get({ blockIds: [tailId] });
			const tailEntry = tailResult?.[tailId];
			if (tailEntry?.unavailable !== undefined && tailEntry.block == null) {
				throw new BlockUnavailableError(tailId, tailEntry.unavailable);
			}
			if (tailEntry?.unconfirmedAheadRev !== undefined) {
				throw new BlockPossiblyStaleError(tailId, tailEntry.unconfirmedAheadRev);
			}
			const tailState = tailEntry?.state;
			if (tailState?.latest) {
				source.actionContext = {
					committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
					rev: tailState.latest.rev,
				};
			}
		}
	}
}
