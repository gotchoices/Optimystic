import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, BlockStore, Transforms, ActionId } from "../index.js";
import { Log } from "../log/log.js";
import type { ActionEntry } from "../log/struct.js";
import { Atomic } from "../transform/atomic.js";
import { Tracker } from "../transform/tracker.js";
import { CacheSource } from "../transform/cache-source.js";
import { computeBlockContentDigests } from "../transform/digest.js";
import { copyTransforms, isTransformsEmpty } from "../transform/helpers.js";
import { TransactorSource } from "../transactor/transactor-source.js";
import { BlockUnavailableError, BlockPossiblyStaleError } from "../network/struct.js";
import type { CollectionHeaderBlock, CollectionId, ICollection, SyncOptions } from "./index.js";
import { CollectionHeaderVanishedError, SyncRetryExhaustedError } from "./struct.js";
import type { ActionContext } from "./action.js";
import { actionIdAt } from "./action.js";
import type { ReadDependency } from "../transaction/transaction.js";
import { clampPriority } from "../transaction/transaction.js";
import { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";
import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { Latches } from "../utility/latches.js";
import { jitteredBackoffMs, abortableDelay, makeAbortError } from "../utility/backoff.js";
import { createLogger } from "../logger.js";

const log = createLogger('collection');

/** Which of {@link Collection.advanceContext}'s two callers is reporting — printed as `site=` on
 * every line it emits, because the two compare DIFFERENT pairs of things and a divergence means
 * something different in each:
 *
 * - `refresh` ({@link Collection.updateInternal}) — this instance's own copy against the stored
 *   log. A divergence here indicts a forked REPLICA: two copies of one collection id built
 *   separately, each internally consistent.
 * - `attach` ({@link Collection.attachToLog}, during open) — the log tail block's claim about
 *   which action produced the latest revision, against a walk of that same tail's own chain. Both
 *   sides come from storage, so a divergence here indicts STORAGE being self-inconsistent about
 *   one revision, not a replica.
 *
 * Without this field the two are indistinguishable in a log, and they lead an operator to
 * completely different places. */
type DivergenceSite = 'refresh' | 'attach';

/** The lowest revision two {@link ActionContext}s provably disagree at, and the action each names
 * there — what {@link Collection.earliestFork} reports and `collection:lineage-divergence` prints
 * as `forkRev=` / `heldAction=` / `readAction=`. */
type LineageFork = { rev: number, heldAction: ActionId, readAction: ActionId };

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

	/** The action id of a write currently in flight ON THIS INSTANCE'S BEHALF, or `undefined`
	 * outside a write. Read by {@link updateInternal}: if the committed log now carries an entry
	 * under this id, that action's work is already durable despite the failure answer that sent us
	 * back here — `NetworkTransactor.commit` commits the collection header and log tail BEFORE
	 * sweeping the remaining blocks, so a later sweep block confirming a conflict reports failure
	 * over an action whose log entry already landed. Such an entry is CONSUMED
	 * ({@link consumeOwnEntry}) rather than replayed, because replaying re-appends content the
	 * committed tail already carries, producing a duplicate entry under one action id at two
	 * revisions.
	 *
	 * The collection owns this fact rather than taking it as a `updateInternal` argument so that no
	 * refresh path can forget to supply it — {@link update} and {@link updateAndSync} are refreshes
	 * on behalf of a READER, the field is unset for them, and the consume branch cannot fire. Before
	 * this was a field, `TransactionCoordinator.commit`'s inter-attempt refresh went through
	 * `update()` and was therefore indistinguishable from a reader refresh even though the
	 * coordinator held the very id it was retrying.
	 *
	 * LIFETIME is the whole attempt CYCLE, not the latched span: it must survive the refresh
	 * BETWEEN a failed attempt and its retry, which is the only moment it is ever read. In
	 * {@link syncInternal} that cycle is contained inside the collection latch `sync()` holds; in
	 * `TransactionCoordinator.commit` the inter-attempt `update()` runs OUTSIDE the commit latch
	 * span by design (`Latches` is non-reentrant), so the coordinator's clear necessarily runs
	 * latch-free. That is safe: this is a single field write, {@link beginInFlightAction}'s
	 * disposer only clears an id it still owns, and the only reader runs under the latch — so the
	 * worst a foreign concurrent refresh can see is a cleared field (it stops consuming), never a
	 * field it should not have consumed. */
	private inFlightActionId?: ActionId;

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
		/** Short random tag naming THIS instance (see {@link newInstanceTag}). Open paths generate
		 * it BEFORE construction (so pre-construction diagnostics such as attachToLog can carry it);
		 * the default covers direct construction in tests. */
		public readonly instanceTag: string = Collection.newInstanceTag(),
	) {
		// Instance-scoped, deliberately NOT shared across instances of one collection id. The
		// latch protects per-instance state only — the tracker, the pending queue, and
		// source.actionContext, none of which two instances over the same id share — while
		// cross-instance races are resolved by the transactor's optimistic concurrency (that is
		// the design; the old process-global `Collection:${id}` key serialized instances by
		// accident). Instance scope is also what lets TransactionCoordinator hold this latch
		// across its whole commit span: `Latches` is a non-reentrant FIFO mutex, and a rival
		// writer driving a SECOND instance of the same id from inside transactor.pend (see
		// CompetingWriterTransactor) would otherwise wait on the very latch the parked commit
		// holds — a deadlock, not contention.
		this.latchId = `Collection:${this.id}#${this.instanceTag}`;
	}

	/** A fresh instance tag: four random bytes rendered base64url — six characters, enough that
	 * two instances over one collection id do not collide by accident, short enough to ride on
	 * every trace line (same shape as the node tag in quereus-plugin-optimystic's
	 * collection-factory). Scopes {@link latchId} per instance and labels diagnostics. */
	private static newInstanceTag(): string {
		return uint8ArrayToString(randomBytes(4), 'base64url');
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
		// Generated BEFORE attachToLog so log-attach-time diagnostics can name the instance
		// the same way post-construction ones do.
		const instanceTag = Collection.newInstanceTag();
		await Collection.attachToLog<TAction>(source, transactor, tracker, id, instanceTag, header);
		return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict, instanceTag);
	}

	/** Open an existing collection, or stage a fresh empty one in the local tracker when the
	 * header is authoritatively absent. Nothing is written to storage until {@link sync}.
	 *
	 * Correct only where inventing a collection is genuinely intended — a first write, a
	 * bootstrap path. The create branch logs `collection:invented`; prefer {@link open} on
	 * any pure read path. */
	static async createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>): Promise<Collection<TAction>> {
		const { source, sourceCache, tracker, header } = await Collection.probeHeader(transactor, id);

		// Pre-construction for the same reason as in open(): see the comment there.
		const instanceTag = Collection.newInstanceTag();
		if (header) {	// Collection already exists
			await Collection.attachToLog<TAction>(source, transactor, tracker, id, instanceTag, header);
		} else {	// Collection does not exist
			log('collection:invented id=%s — no committed header found; staging a fresh empty collection', id);
			const headerBlock = init.createHeaderBlock(id, tracker);
			tracker.insert(headerBlock);
			source.actionContext = undefined;
			await Log.open<Action<TAction>>(tracker, id);
		}

		return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict, instanceTag);
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
		/** The tag the calling open path minted for the Collection it is ABOUT to construct, so a
		 * diagnostic emitted here carries the same instance name as every post-construction one. */
		instanceTag: string,
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
		Collection.advanceContext(source, id, instanceTag, 'attach', await collectionLog.getActionContext());
	}

	/** Adopt a freshly-read action context WITHOUT ever lowering the revision already held.
	 *
	 * The revision a collection last committed at is knowledge it earned; a read that found
	 * nothing — or found an older view of the log — cannot un-earn it. Silently accepting the
	 * lower value makes the next sync ask for a revision that is long gone, and every retry
	 * repeats the same doomed request because each retry re-runs the same losing read.
	 *
	 * Equal revisions still adopt `next`: the rev is unchanged but its `committed` list may be
	 * more complete than what we hold.
	 *
	 * This is also the one seam where lineage divergence is observable: at every revision BOTH
	 * sides name an action for, the two ids must agree. Revision
	 * numbers are per-collection counters, so two separately-built copies under one id can each
	 * occupy the same revision with DIFFERENT actions while each stays internally self-consistent
	 * — {@link reportShortfall} structurally cannot see that (its two numbers come from one
	 * chain), and this is the only place two `committed` lists meet. Naming different actions at
	 * one revision proves the two sides are different lineages (`collection:lineage-divergence`;
	 * see docs/debugging.md § "Did the refresh itself fail to close the gap?"). WHICH two sides
	 * depends on the caller, and the line says so in `site=` — see {@link DivergenceSite}, which
	 * defines the two values and what each one indicts.
	 *
	 * Every line from here also carries `tag=`, the {@link Collection.instanceTag} of the handle
	 * reporting. One process routinely holds several handles on one collection id; without the
	 * tag, two handles' lines interleave into what reads like one handle contradicting itself.
	 *
	 * Logs, does not throw — same reasoning as {@link reportShortfall}: `update()` runs
	 * blanket-style over every registered collection between commit retries, and aborting here
	 * would promote a diagnosis to production behaviour before the line has ever been seen to
	 * fire in the wild. Adoption then proceeds unchanged, which means the line is a PER-DISCOVERY
	 * report, not a per-refresh one: adopting `next` overwrites the held lineage marker with the
	 * log's, so the next refresh of this instance compares log-to-log and stays silent — even
	 * though block content materialized under the old lineage may still be in caches. The line
	 * marks the refresh that first observed the disagreement.
	 *
	 * NOTE: adoption resolves the CONTEXT disagreement, not the content one — the read caches on
	 * this instance still hold blocks materialized under the old lineage, and since the revision
	 * did not change nothing re-reads them. Conditional today: no fork has been reproduced (see
	 * the still-open upstream reproducer), so this instrument exists to find out whether one
	 * happens at all. If the line is ever seen firing in the field, decide then whether a
	 * divergence should also drop the read cache (and whether to keep re-reporting per refresh)
	 * — that is a behaviour change, and this seam deliberately makes none.
	 *
	 * The comparison is {@link earliestFork}, not a single lookup at the current revision: the
	 * two `committed` lists overlap across several revisions, and the LOWEST one they disagree at
	 * is where the lineages actually parted — a fork below the current revision was previously
	 * silent. `forkRev=` names it, `heldAction=`/`readAction=` are the two ids AT it, and
	 * `heldRev=`/`readRev=` are the two contexts' own revisions, so the line says both where the
	 * split began and how far each side has since travelled.
	 *
	 * The refusal line reports its two action ids at `readRev=` — the read's revision — on BOTH
	 * sides, because that is the only revision the two can be compared at: `next` never names an
	 * action above its own revision, so looking each side up at its own revision would compare
	 * different revisions and print two different ids for one honest lineage. Equal ids there mean
	 * the read is an older view of THIS lineage (ordinary lag, correctly refused); different ids
	 * mean a fork; `none` on the held side means this handle's own list does not reach back to the
	 * read's revision — the signature of a context bootstrapped from an over-claiming tail (see
	 * the NOTE in {@link bootstrapContext}), which is exactly the case {@link earliestFork} has no
	 * shared revision to report on.
	 *
	 * Gated on `log.enabled`, like every {@link actionIdAt} caller: the comparison buys nothing
	 * when the line has no sink, and the lists — one entry per commit between context reads,
	 * truncated at each checkpoint — are only walked on a run that has the namespace turned on.
	 * Silence proves nothing either way, because a revision is only comparable when BOTH sides
	 * name an action for it: an invented collection has no context at all, a revision slot the log
	 * gave to a checkpoint or invalidation entry names none, and a revision older than the read
	 * log's most recent checkpoint has already fallen off the read side's list. */
	private static advanceContext(
		source: TransactorSource<IBlock>,
		id: CollectionId,
		instanceTag: string,
		site: DivergenceSite,
		next: ActionContext | undefined,
	): void {
		const current = source.actionContext;
		if (next === undefined) {
			return;	// The read learned nothing — keep what we already know.
		}
		if (current !== undefined && log.enabled) {
			const fork = Collection.earliestFork(current, next);
			if (fork !== undefined) {
				log('collection:lineage-divergence id=%s tag=%s site=%s forkRev=%d heldAction=%s readAction=%s heldRev=%d readRev=%d',
					id, instanceTag, site, fork.rev, fork.heldAction, fork.readAction, current.rev, next.rev);
			}
		}
		if (current !== undefined && next.rev < current.rev) {
			// The refusal itself is unconditional; only the id lookups that explain it are gated.
			if (log.enabled) {
				log('collection:context-not-lowered id=%s tag=%s site=%s heldRev=%d readRev=%d heldAction=%s readAction=%s',
					id, instanceTag, site, current.rev, next.rev,
					actionIdAt(current, next.rev) ?? 'none', actionIdAt(next, next.rev) ?? 'none');
			}
			return;
		}
		source.actionContext = next;
	}

	/** The EARLIEST revision the two contexts provably disagree about: the lowest revision both
	 * `committed` lists name an action for, where the two ids differ.
	 *
	 * Comparing only at the holder's current revision — what this used to do — misses a fork that
	 * began earlier and has since been overtaken by same-numbered commits on both sides, which is
	 * the shape a replica that forked and kept writing actually has. Taking the lowest disagreeing
	 * revision instead names the split point rather than an arbitrary later symptom of it.
	 *
	 * Revisions only one side names are skipped, not treated as disagreement: {@link actionIdAt}'s
	 * `undefined` is legitimate (checkpoint/invalidation slots, and revisions that predate the
	 * other side's most recent checkpoint), so a one-sided entry is missing evidence, not evidence
	 * of a fork.
	 *
	 * NOTE: linear in the two lists, which hold one entry per commit between context reads and
	 * truncate at each checkpoint. Every caller is `log.enabled`-gated, so this does not run at
	 * all on a normal run; if a non-diagnostic caller ever appears, index by revision instead. */
	private static earliestFork(held: ActionContext, read: ActionContext): LineageFork | undefined {
		// NOTE: a `committed` list carrying TWO entries at one revision would be a defect in its own
		// right, and this keeps the last of them arbitrarily. Harmless while every caller is a
		// diagnostic; if such a list is ever seen, report the duplicate rather than silently
		// picking one.
		const readIds = new Map(read.committed.map(entry => [entry.rev, entry.actionId]));
		let earliest: LineageFork | undefined;
		for (const entry of held.committed) {
			const readAction = readIds.get(entry.rev);
			if (readAction === undefined || readAction === entry.actionId) {
				continue;
			}
			if (earliest === undefined || entry.rev < earliest.rev) {
				earliest = { rev: entry.rev, heldAction: entry.actionId, readAction };
			}
		}
		return earliest;
	}

	/** Report a refresh that failed to move FORWARDS past a revision it had already read for
	 * itself — the sibling of {@link advanceContext}'s `collection:context-not-lowered`, which
	 * reports a collection declining to move BACKWARDS.
	 *
	 * `tailRev` is what the committed log tail claimed is committed under this id; `after` is
	 * where a SEPARATE read path (the chain walk) actually landed. Landing below the claim means
	 * this refresh closed nothing, which from outside the class is otherwise indistinguishable
	 * from "there was nothing newer to adopt".
	 *
	 * This detects LAG, and only lag. It CANNOT see lineage divergence: both of its numbers
	 * come from the same chain — `tailRev` off the tail block this collection's own header
	 * names, `after` from a walk of that same chain — and a forked replica is internally
	 * self-consistent, its tail claiming exactly what its own walk reaches. Two copies of one
	 * collection id holding the same revision under different actions therefore keep this line
	 * silent forever. That case is `collection:lineage-divergence`, reported from
	 * {@link advanceContext}, which compares action ids — the one value comparable across
	 * copies — rather than revision counters.
	 *
	 * Carries the same `tag=` as {@link advanceContext}'s lines, and for the same reason: several
	 * handles on one collection id otherwise read as one self-contradicting handle.
	 *
	 * Logs, does not throw: `update()` is called blanket-style over every registered collection
	 * between commit retries, and a shortfall is not yet known to be illegitimate — an abort here
	 * would promote an unproven diagnosis to production behaviour. Deliberately does NOT adopt
	 * `tailRev` either: the two numbers come from different read paths, and papering over the
	 * disagreement destroys the evidence this line exists to produce. */
	private static reportShortfall(id: CollectionId, instanceTag: string, tailRev: number | undefined, before: number | undefined, after: number | undefined): void {
		if (tailRev === undefined || (after !== undefined && after >= tailRev)) {
			return;
		}
		log('collection:context-short-of-tail id=%s tag=%s before=%s after=%s tail=%d',
			id, instanceTag, before ?? 'none', after ?? 'none', tailRev);
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

	/** Drops the pending actions this sync's OWN committed entry already made durable, instead of
	 * replaying them into a duplicate entry (see {@link inFlightActionId}).
	 *
	 * `addActions` wrote exactly the snapshot pending list under this action id, and `act()` shares
	 * the collection latch with `syncInternal`, so `this.pending` cannot have grown mid-sync: the
	 * entry's actions are the leading `entry.actions.length` items of `this.pending`.
	 * NOTE: that correspondence rests on the shared latch, and `slice` fails SILENTLY if it ever
	 * breaks — an entry longer than `pending` would drop actions that were never committed. If a
	 * path is ever added that stages actions outside the collection latch, assert
	 * `entry.actions.length <= this.pending.length` here (and see the sibling note on
	 * `syncInternal`'s post-commit replay, which relies on the same invariant). */
	private consumeOwnEntry(entry: ActionEntry<Action<TAction>>) {
		// `mutated` is unconditional, even for a zero-action entry: the tracker still holds this
		// action's staged transforms, and only the replay at the end of `updateInternal` — which
		// resets the tracker and re-stages just what remains — drops them. That reset is what turns
		// `hasUnsyncedChanges()` false so the sync loop exits reporting the success the writer is
		// owed (the action IS durable).
		return { after: this.pending.slice(entry.actions.length), mutated: true };
	}

	/** Maps each pending action to its effective form against a remote entry: the original, a
	 * replacement, or dropped. A replacement or a discard changes the pending set; the tracker still
	 * holds the pre-filter transforms, so report it as mutated to force a replay that re-stages
	 * against the effective actions. Identity comparison per the contract: keep => same instance,
	 * replace => new instance.
	 * NOTE: a filterConflict hook that always allocates a fresh (but equal) instance instead of
	 * returning the same one forces a replay on every update — if that ever shows up as a hot path,
	 * compare by value/id here instead of by reference. */
	private filterAgainstEntry(entry: ActionEntry<Action<TAction>>) {
		const before = this.pending;
		const after = before
			.map(p => this.doFilterConflict(p, entry.actions))
			.filter((a): a is Action<TAction> => a !== undefined);
		return { after, mutated: after.length !== before.length || after.some((a, i) => a !== before[i]) };
	}

	/** Refresh this instance against the stored log: adopt the latest committed revision, resolve
	 * pending actions against everything that landed since, and replay them if anything conflicts.
	 *
	 * Takes no in-flight action id — it reads {@link inFlightActionId} off `this`, which is set for
	 * exactly the write attempt cycles that own one (see that field). Callers cannot get this wrong
	 * by omission. */
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

		// The revision the committed tail just claimed, captured before anything else can touch
		// the local source. This is the authoritative "latest committed under this id" number,
		// read straight off the tail block's state; the chain walk below arrives at its own
		// number by a different path, and the two disagreeing is worth saying out loud (see the
		// {@link reportShortfall} call after advanceContext). Stays undefined when there is no header, no
		// tail, or a tail with no `latest` — all legitimate "nothing committed yet" states.
		const tailRev = source.actionContext?.rev;

		// Get the latest entries from the log, starting from where we left off
		const actionContext = this.source.actionContext;
		const collectionLog = await Log.open<Action<TAction>>(tracker, this.id);
		const latest = collectionLog ? await collectionLog.getFrom(actionContext?.rev ?? 0) : undefined;

		// Process the entries and track the blocks they affect
		let anyConflicts = false;
		for (const entry of latest?.entries ?? []) {
			const isOwnEntry = this.inFlightActionId !== undefined && entry.actionId === this.inFlightActionId;
			const { after, mutated } = isOwnEntry
				? this.consumeOwnEntry(entry)
				: this.filterAgainstEntry(entry);
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
		Collection.advanceContext(this.source, this.id, this.instanceTag, 'refresh', latest?.context);

		Collection.reportShortfall(this.id, this.instanceTag, tailRev, actionContext?.rev, this.source.actionContext?.rev);

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
	 * `undefined` is legitimate, not an error: an INVENTED collection has no context at
	 * all, and otherwise {@link actionIdAt} resolves nothing at the current revision for
	 * the reasons listed there. A caller printing this must therefore carry a placeholder
	 * rather than invent an id. The contexts this class writes itself
	 * ({@link recordCommitted}, the inline bump in `syncInternal`,
	 * {@link bootstrapContext}) always do hold one.
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
		return context === undefined ? undefined : actionIdAt(context, context.rev);
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
	 *  in {@link syncInternal} — which needs no such rev check because it computes and
	 *  uses its `newRev` inside one latched span.
	 *
	 *  @param rev - the revision this action was PENDED at, captured once (at the log
	 *  append in `TransactionCoordinator.applyActionsToCollection`) and threaded through
	 *  the pend/commit round trips. Storage assigned the action THAT number; recording it
	 *  at any other would fork this instance's revision counter from storage permanently
	 *  (context adoption is one-way — see {@link advanceContext}). With the coordinator
	 *  holding this instance's latch across the whole commit span the mismatch cannot
	 *  happen; the throw is the tripwire for any path that still bypasses the latch. */
	recordCommitted(actionId: ActionId, rev: number): number {
		const expected = this.getNextRev();
		if (rev !== expected) {
			throw new Error(`Collection ${this.id}: action ${actionId} was pended at rev ${rev} ` +
				`but the collection now expects rev ${expected} — the collection was refreshed mid-commit`);
		}
		this.source.actionContext = {
			committed: [...(this.source.actionContext?.committed ?? []), { actionId, rev }],
			rev,
		};
		return rev;
	}

	/** Acquire this instance's latch — the same mutex {@link act}, {@link update},
	 * {@link sync}, and {@link updateAndSync} serialize behind — returning its release.
	 * Exists so a TransactionCoordinator can hold the latch across its WHOLE commit span
	 * (log append → pend → commit → local fold), keeping any refresh of this instance from
	 * interleaving with a mid-flight commit. `Latches` is non-reentrant: while holding this,
	 * the holder must not call any of those latched methods on this instance. The caller
	 * MUST call the release exactly once, in a `finally`. */
	acquireLatch(): Promise<() => void> {
		return Latches.acquire(this.latchId);
	}

	/** Bracket a write attempt cycle on this instance under `actionId`, so a refresh taken between
	 * a failed attempt and its retry recognises that action's own already-durable log entry (see
	 * {@link inFlightActionId} for why, and for the lifetime this must span).
	 *
	 * The returned disposer clears the mark and MUST be called in a `finally` covering every exit
	 * from the retry cycle — return, retry exhaustion, partial commit, hard error, abort. A mark
	 * left behind would let a LATER, unrelated refresh consume a foreign entry that happens to
	 * carry the same id. The clear is id-guarded, so a disposer whose mark has since been replaced
	 * by another attempt is a no-op rather than wiping the newer one; disposers may therefore be
	 * called out of order and more than once. Shaped like {@link acquireLatch} deliberately: a
	 * disposer is harder to forget than a paired `end…` call.
	 *
	 * NOTE: the mark deliberately outlives the latch (see {@link inFlightActionId}), so two writes
	 * overlapping on ONE instance can trample each other's: a second write that acquires the latch
	 * between the first's failed attempt and its retry-refresh replaces the id, and the first's
	 * refresh then reads the SECOND write's id — consuming that write's durable entry and dropping
	 * pending actions of its own that never landed. Not reachable today: a coordinator commit and a
	 * `sync()` both run on one session call path, which is the same assumption the participant
	 * selection in `TransactionCoordinator.commitOnce` and its `rollback` already rest on. If a
	 * second writer is ever allowed to drive the SAME instance concurrently, this must become a
	 * per-attempt token (a mark object compared by identity, refusing to replace a live one) rather
	 * than a bare id. */
	beginInFlightAction(actionId: ActionId): () => void {
		this.inFlightActionId = actionId;
		return () => {
			if (this.inFlightActionId === actionId) {
				this.inFlightActionId = undefined;
			}
		};
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

	/** Mints the one action id this sync reuses across all of its retry attempts, and owns it for
	 * the WHOLE cycle — including the inter-attempt refresh, which is the only thing that reads it
	 * (see {@link inFlightActionId}). `sync()`/`updateAndSync()` hold the collection latch across
	 * all of this, so the mark's lifetime is contained inside the latched span here; the disposer
	 * runs on every exit, including a throw out of retry exhaustion or an abort. */
	private async syncInternal(options?: SyncOptions) {
		const bytes = randomBytes(16);
		const actionId = uint8ArrayToString(bytes, 'base64url');

		const endInFlight = this.beginInFlightAction(actionId);
		try {
			await this.syncAttempts(actionId, options);
		} finally {
			endInFlight();
		}
	}

	/** The retry loop behind {@link syncInternal}, run with `actionId` already marked in flight. */
	private async syncAttempts(actionId: ActionId, options?: SyncOptions) {
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

			// Declare what each touched block will contain once committed, computed from this snapshot
			// tracker (which layers over `this.sourceCache`, so the peek/getCachedRevision probes are
			// live). Purely local — an id whose base is not already cached is simply omitted and falls
			// back to corroboration on the member side. Computed AFTER the log append so the log tail
			// and header transforms this attempt just staged are digested too.
			// NOTE: recomputed from scratch on every retry attempt (the snapshot tracker is rebuilt each
			// iteration), so a sync that loses N races pays N full hashing passes over its touched
			// blocks. Unmeasured and cheap relative to the round trips it is retrying; if a
			// high-contention sync ever shows digest hashing in a profile, memoize per (id, staged ops).
			const blockDigests = await computeBlockContentDigests(tracker, tracker.transformedBlockIds());

			// Commit the action to the transactor. Carry the aged retry priority derived from the
			// consecutive-failure count so a sync that keeps losing concurrent races out-ranks fresh
			// (priority-0) rivals in the cluster's resolveRace (fairness-only; capped at MaxPriority).
			// First attempt has consecutiveFailures == 0, so priority 0 — the common pend is unchanged.
			const staleFailure = await this.source.transact(tracker.transforms, actionId, newRev, this.id, addResult.tailPath.block.header.id, clampPriority(consecutiveFailures), blockDigests);
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
				// Fetch latest state - updateInternal() will call replayActions() if there are conflicts.
				// This sync's actionId is marked in flight for the whole cycle (see syncInternal), so
				// the refresh recognizes a log entry written by THIS action (a commit that landed
				// durably but answered stale — see the entry loop in updateInternal) and consumes it
				// rather than replaying it into a duplicate entry.
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
				// NOTE: this replay runs BEFORE the cache fold and the context bump below — the
				// inverse of the order `updateInternal` and `TransactionCoordinator.commitOnce`
				// both document as required, where the newly committed state must be visible
				// before anything re-reads. Dormant today: `act()` and `syncInternal` take the
				// same collection latch, so `this.pending` cannot grow during the transact above
				// and the slice always leaves it empty, making this replay a no-op reset. If a
				// path ever stages outside that latch, move the transformCache + actionContext
				// lines above this replay — otherwise the replay re-reads at the superseded
				// revision over a cache that has not yet seen the commit, and re-stages onto a
				// root the commit already replaced.
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
			// NOTE: this number is adopted on trust, and adoption is one-way (advanceContext never
			// lowers it). A tail that over-claims therefore pins the collection at a revision its
			// own log can never reach, permanently: every later refresh walks the log, reads the
			// real (lower) revision, and is refused — so the instance emits
			// `collection:context-not-lowered` forever while `collection:context-short-of-tail`
			// stays silent (the held revision is at or above what the tail claims). No condition
			// that makes a real tail over-claim has been demonstrated; this was seen only through a
			// test double built to lie (see collection.spec.ts, 'a refresh that lands short of the
			// tail it just read'). If an over-claiming tail is ever observed in the field, the fix
			// belongs here — validate the claim against the log before pinning — not in the refresh.
			if (tailState?.latest) {
				source.actionContext = {
					committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
					rev: tailState.latest.rev,
				};
			}
		}
	}
}
