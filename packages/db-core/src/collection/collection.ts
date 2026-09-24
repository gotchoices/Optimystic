import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, BlockStore, Transforms, ActionId, ActionLineage, BlockContentDigests, GetBlockResult } from "../index.js";
import { Log } from "../log/log.js";
import type { LogBlock } from "../log/log.js";
import type { ActionEntry, GetFromResult, LogEntry } from "../log/struct.js";
import { Atomic } from "../transform/atomic.js";
import { Tracker } from "../transform/tracker.js";
import type { BasePins } from "../transform/base-pins.js";
import { CacheSource } from "../transform/cache-source.js";
import { computeBlockContentDigests, baseRevsField } from "../transform/digest.js";
import type { BlockBaseRevs } from "../network/struct.js";
import { copyTransforms, isTransformsEmpty } from "../transform/helpers.js";
import { TransactorSource, answeredBlock, servedRevision } from "../transactor/transactor-source.js";
import { BlockFloors } from "../transactor/block-floors.js";
import type { WriteDurability } from "../network/struct.js";
import { mergeDurability } from "../network/durability.js";
import { highestStaleAt } from "../network/stale-failure.js";
import type { CollectionHeaderBlock, CollectionId, ICollection, SyncOptions, TornActionReason } from "./index.js";
import { CollectionHeaderVanishedError, SyncRetryExhaustedError, SyncRevisionStalledError, TornActionError } from "./struct.js";
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

/** Exactly what one failed write attempt sent to the transactor — enough to send the same thing
 * again. Retained by {@link Collection.retainInFlightAttempt} so that a refresh which then finds
 * this attempt's own log entry can land the blocks the attempt left behind, at the same action id
 * and revision (see {@link Collection.completeOwnEntry}). */
export type InFlightAttempt = {
	/** The revision the attempt's log entry was stamped with, and pended and committed at. */
	rev: number;
	/** Every transform the attempt pended — the log blocks included. The caller hands over a copy
	 * it will not mutate; the collection keeps it as given. */
	transforms: Transforms;
	/** The attempt's log tail block, committed first. */
	tailId: BlockId;
	/** The per-block content declarations the attempt's commit carried, if any. */
	blockDigests?: BlockContentDigests;
	/** The per-block bases the attempt's pend carried, if any (see `PendRequest.baseRevs`). Kept
	 * with the transforms because they describe them: a re-send of these operations must name the
	 * same bases they were computed against. */
	baseRevs?: BlockBaseRevs;
};

/** What one refresh ({@link Collection.refreshInFlight}, and the refresh inside a sync) found out
 * about the write in flight on the instance's behalf. The caller hands in an empty report and the
 * refresh fills it in AS IT GOES, rather than returning it at the end, so a refresh that throws
 * after it saved the write still says so: the write is saved in storage whatever happens to this
 * instance's local bookkeeping afterwards.
 *
 * NOTE: filled in, not returned, because a return value is lost on a throw — and a refresh CAN
 * throw after finishing its own entry (the invalidation read and the replay both run later). */
export type RefreshReport = {
	/** Set once the refresh found the in-flight write's own log entry and FINISHED it
	 * ({@link Collection.completeOwnEntry}): every block the entry names holds the write, so it is
	 * saved. Left unset on every other refresh, including every reader's.
	 *
	 * `durability` is who holds the finished write, when the refresh learned it. It is absent when
	 * finishing found every block already holding the write without re-sending anything (the
	 * status-read fallback), which is still a saved write — so test the field, never `durability`,
	 * for "saved". */
	ownEntryFinished?: { durability?: WriteDurability };
};

/** The two blocks every refresh starts from, as {@link Collection.readLogEnds} read them. */
type LogEnds = {
	header: CollectionHeaderBlock;
	/** The repo's answer for the log tail block the header names; absent when the header names no
	 * tail or the repo returned no entry for it. */
	tail?: GetBlockResult;
	/** Every block read, with the revision it was served at — the seed for the refresh's block cache. */
	served: Array<[BlockId, IBlock, number]>;
};

/** Default base backoff (and historical fixed delay) between sync retries, in ms. */
const PendingRetryDelayMs = 100;
/** Default max consecutive no-progress stale-failure retries before {@link Collection.sync} gives up. */
const DefaultMaxAttempts = 10;
/** Default ceiling on a single exponential-backoff sleep, in ms. */
const DefaultMaxBackoffMs = 5000;
/** Default consecutive stalled refreshes — ones that moved this collection's revision NOWHERE
 * while a responder CONFIRMED a revision at or above the one being requested — before
 * {@link Collection.sync} gives up. Two, not one, so a single transiently-lagging read is absorbed.
 *
 * NOTE: two is a judgement call, not a measurement — nothing here counts how often a legitimate
 * loser reads a view that moves nowhere for two consecutive rounds. The check only strikes when the
 * refresh made NO progress at all, so a client merely catching up is already excluded; if a
 * spurious `SyncRevisionStalledError` ever shows up under real contention anyway, raise this. */
const DefaultMaxStalledAttempts = 2;

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
	/** The bases the transforms' update operations were computed against (see {@link BasePins}),
	 *  copied at snapshot time. Restored with the transforms, so a restore never pairs operations
	 *  with the bases of some later re-stage: the pend would then declare a base the operations
	 *  were not built on. Absent on a snapshot built by hand; such a restore keeps whatever pins
	 *  the tracker holds for the restored ids. */
	pins?: BasePins;
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
	 * under this id, that action's LOG TAIL landed despite the failure answer that sent us back here
	 * — every member applies the log tail before the action's other blocks, and
	 * `NetworkTransactor.commit` reports failure when the commit carrying the tail was refused after
	 * landing on a minority (`commit-not-durable`; in one round the other blocks may have landed on
	 * that minority too, in two the sweep never ran) and when a later sweep block confirmed a
	 * conflict. Such an entry is never REPLAYED, because replaying re-appends content
	 * the committed tail already carries, producing a duplicate entry under one action id at two
	 * revisions. But it is not proof the write is saved either: the entry proves only that the tail
	 * landed, and the writer's own cancel has since dropped the pending records of every block that
	 * did not. So the refresh first FINISHES the action ({@link completeOwnEntry}) — landing the
	 * remaining blocks at the same action id and revision, from {@link inFlightAttempt} — and only
	 * then consumes the entry ({@link consumeOwnEntry}).
	 *
	 * The collection owns this fact rather than taking it as a `updateInternal` argument so that no
	 * refresh path can forget to supply it — {@link update} and {@link updateAndSync} are refreshes
	 * on behalf of a READER, the field is unset for them, and the consume branch cannot fire. Before
	 * this was a field, `TransactionCoordinator.commit`'s inter-attempt refresh went through
	 * `update()` and was therefore indistinguishable from a reader refresh even though the
	 * coordinator held the very id it was retrying. (It now goes through {@link refreshInFlight},
	 * which differs from `update()` only in reporting what the refresh saved — the field, not the
	 * method, is still what makes the refresh recognise the entry.)
	 *
	 * LIFETIME is the whole attempt CYCLE, not the latched span: it must survive the refresh
	 * BETWEEN a failed attempt and its retry, which is the only moment it is ever read. In
	 * {@link syncInternal} that cycle is contained inside the collection latch `sync()` holds; in
	 * `TransactionCoordinator.commit` the inter-attempt refresh runs OUTSIDE the commit latch
	 * span by design (`Latches` is non-reentrant), so the coordinator's clear necessarily runs
	 * latch-free. That is safe: this is a single field write, {@link beginInFlightAction}'s
	 * disposer only clears an id it still owns, and the only reader runs under the latch — so the
	 * worst a foreign concurrent refresh can see is a cleared field (it stops consuming), never a
	 * field it should not have consumed. */
	private inFlightActionId?: ActionId;

	/** The most recent FAILED attempt made under {@link inFlightActionId} — exactly what it sent,
	 * kept so a refresh that finds that attempt's own log entry can finish the action instead of
	 * assuming it is finished (see {@link completeOwnEntry}). Set by {@link retainInFlightAttempt},
	 * cleared with the mark by {@link beginInFlightAction}'s disposer, and meaningless without it.
	 *
	 * The transforms are retained VERBATIM rather than rebuilt at the point of finishing: by then
	 * the attempt's snapshot tracker is gone, and the re-send has to name the same log tail block
	 * the entry was appended to. The separate guarantee that a same-revision REBUILD sends identical
	 * bytes ({@link logAppendBlockIds}, and the per-write timestamp {@link syncInternal} mints)
	 * covers the retry that finds NO entry at all; it does not hand this path a tail id.
	 *
	 * Only the latest attempt is kept. An own entry can only be visible at the revision of an
	 * attempt whose tail landed, and a later attempt at a DIFFERENT revision is only made after a
	 * refresh adopted somebody else's entry at the earlier one — which is proof the earlier tail did
	 * not land. {@link completeOwnEntry} still checks the revision and refuses on a mismatch. */
	private inFlightAttempt?: InFlightAttempt;

	/** The log data-block ids the append of the action marked in {@link inFlightActionId} has
	 * minted, in the order it minted them, together with the revision they were minted for. Set and
	 * read by {@link logAppendBlockIds}, cleared with the rest of the in-flight state by
	 * {@link beginInFlightAction} and its disposer. */
	private mintedLogBlockIds?: { rev: number; ids: BlockId[] };

	/** The log tail block id the most recent header read named. A refresh asks for this block in the
	 * same request as the header ({@link readLogEnds}): the tail id only changes when the tail block
	 * fills, so an idle refresh is one request rather than two. A stale value costs one extra request
	 * and nothing else. */
	private logTailId?: BlockId;

	protected constructor(
		public readonly id: CollectionId,
		public readonly transactor: ITransactor,
		private readonly handlers: Record<ActionType, ActionHandler<TAction>>,
		private readonly source: TransactorSource<IBlock>,
		/** Cache of unmodified blocks from the source */
		private readonly sourceCache: CacheSource<IBlock>,
		/** Tracked Changes */
		public readonly tracker: Tracker<IBlock>,
		/** What each block named by a walked log entry must be at least as new as — raised by
		 * {@link updateInternal}, and shared with every read source this handle builds (see
		 * {@link BlockFloors}). */
		private readonly floors: BlockFloors,
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
		// Generated BEFORE anything reads, so every diagnostic of this handle — the floors the probe
		// wires up and the log-attach-time lines included — names the instance the same way
		// post-construction ones do.
		const instanceTag = Collection.newInstanceTag();
		const { source, sourceCache, tracker, floors, header } = await Collection.probeHeader(transactor, id, instanceTag);
		if (!header) {
			// Return before anything is staged: the tracker's transforms stay empty, so a caller
			// that ignores the undefined cannot later sync a phantom collection into existence.
			return undefined;
		}
		await Collection.attachToLog<TAction>(source, transactor, tracker, id, instanceTag, header);
		const collection = new Collection(id, transactor, init.modules, source, sourceCache, tracker, floors, init.filterConflict, instanceTag);
		collection.logTailId = header.tailId;
		return collection;
	}

	/** Open an existing collection, or stage a fresh empty one in the local tracker when the
	 * header is authoritatively absent. Nothing is written to storage until {@link sync}.
	 *
	 * Correct only where inventing a collection is genuinely intended — a first write, a
	 * bootstrap path. The create branch logs `collection:invented`; prefer {@link open} on
	 * any pure read path. */
	static async createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>): Promise<Collection<TAction>> {
		// Pre-construction for the same reason as in open(): see the comment there.
		const instanceTag = Collection.newInstanceTag();
		const { source, sourceCache, tracker, floors, header } = await Collection.probeHeader(transactor, id, instanceTag);

		if (header) {	// Collection already exists
			await Collection.attachToLog<TAction>(source, transactor, tracker, id, instanceTag, header);
		} else {	// Collection does not exist
			log('collection:invented id=%s — no committed header found; staging a fresh empty collection', id);
			const headerBlock = init.createHeaderBlock(id, tracker);
			tracker.insert(headerBlock);
			source.actionContext = undefined;
			await Log.open<Action<TAction>>(tracker, id);
		}

		const collection = new Collection(id, transactor, init.modules, source, sourceCache, tracker, floors, init.filterConflict, instanceTag);
		collection.logTailId = header?.tailId;
		return collection;
	}

	/** The per-instance read wiring every open path needs, plus the header probe result.
	 * Shared by {@link open} and {@link createOrOpen} so the two cannot drift. */
	private static async probeHeader(transactor: ITransactor, id: CollectionId, instanceTag: string): Promise<{
		source: TransactorSource<IBlock>,
		sourceCache: CacheSource<IBlock>,
		tracker: Tracker<IBlock>,
		floors: BlockFloors,
		header: CollectionHeaderBlock | undefined,
	}> {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information.
		// One shared read-dependency collector feeds both the source (direct structural reads) and the cache (every
		// cache hit/miss), so a block read from either layer records a dependency — cache hits included.
		const collector = new ReadDependencyCollector();
		const floors = Collection.newFloors(id, instanceTag);
		const source = new TransactorSource(id, transactor, undefined, collector, floors);
		const sourceCache = new CacheSource(source, undefined, collector);
		const tracker = new Tracker(sourceCache);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
		return { source, sourceCache, tracker, floors, header };
	}

	/** A new handle's floors: none yet (opening walks no entries), wired to report every below-floor
	 * answer any of the handle's read sources receives. The line is the only trace such an answer
	 * leaves — the read itself succeeds (see the accepted-tradeoff NOTE at
	 * `TransactorSource.mayRetain`) — so repeated lines for one block with `servedRev` short of
	 * `floorRev` are how an operator sees a machine that has not caught up, and lines that never
	 * stop are how they see a log entry whose blocks never landed. */
	private static newFloors(id: CollectionId, instanceTag: string): BlockFloors {
		return new BlockFloors(({ blockId, floor, servedRev }) => {
			log('collection:block-below-floor id=%s tag=%s block=%s floorRev=%d floorAction=%s servedRev=%d',
				id, instanceTag, blockId, floor.rev, floor.actionId, servedRev);
		});
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
		Collection.bootstrapContext(source, header.tailId === undefined ? undefined : await Collection.readLogTail(transactor, header.tailId));

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
			await this.updateInternal({});
		} finally {
			release();
		}
	}

	/** The refresh `TransactionCoordinator.commit` runs between attempts: exactly {@link update},
	 * plus a report of whether it finished the write in flight on this instance's behalf (see
	 * {@link RefreshReport}). The coordinator needs that fact to tell its caller which participants
	 * are already saved when the commit later fails; a reader's `update()` has no write in flight
	 * and nothing to report.
	 *
	 * `report` is REQUIRED so a write path cannot refresh without learning what the refresh saved.
	 * It is filled in as the refresh goes, so it is accurate when this throws too.
	 *
	 * `lastChance` is REQUIRED for the same reason: only the caller knows whether its retry budget
	 * ends with this round, and a round that is the last must settle a half-landed write rather than
	 * ask for another (see {@link completeOwnEntry}). */
	async refreshInFlight(report: RefreshReport, lastChance: boolean): Promise<void> {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.updateInternal(report, lastChance);
		} finally {
			release();
		}
	}

	/** Finishes a half-landed write BEFORE its own log entry is consumed, so that consuming never
	 * reports a write as saved on the strength of its log entry alone.
	 *
	 * THE RULE: a write may be reported saved only if EVERY block its log entry names holds the
	 * write — at the write's own revision, or at a later revision that was BUILT FROM it. Finding the
	 * entry proves only that the log tail landed (see {@link inFlightActionId} for the two ways
	 * `NetworkTransactor.commit` answers failure over a stored tail). The writer's cancel has since
	 * removed the pending records of every block that did not land, so nothing else will ever land
	 * them — if this does not, the entry stands in the log, the blocks stay at their previous
	 * revision on every node, and readers materialize blocks, not log entries: the write is
	 * silently gone.
	 *
	 * Finishing is a plain re-send of the retained failed attempt ({@link inFlightAttempt}) — the
	 * SAME transforms, action id, revision and tail. Every storage tier treats a block that already
	 * holds exactly this action at exactly this revision as satisfied rather than as a rival
	 * (`isOwnRevision`: `StorageRepo.pend`/`.commit`, `ClusterMember`, `CoordinatorRepo`), so the
	 * re-send rolls forward precisely the blocks that are missing and is a no-op for the rest,
	 * including when nothing is missing at all. It is never sent at a new revision: the refresh has
	 * already seen the entry at this one, and a second revision would record the entry twice.
	 *
	 * A refused re-send is NOT yet an answer. Storage refuses it whenever any block has moved past
	 * the write's revision — and every later commit to the collection moves the log tail past it —
	 * which says a rival was there, not whether the rival built on this write or over it. That is
	 * asked separately, of the blocks' own history ({@link settleUnfinished}).
	 *
	 * Runs at the top of {@link updateInternal}, before that method has changed anything on this
	 * instance, so every throw from here leaves the collection exactly as the failed attempt left
	 * it — staged actions and transforms intact, revision not advanced.
	 *
	 * @param lastChance - the caller will not refresh again for this write (its retry budget ends
	 * with this round), so a refusal that could clear is settled now instead of asking for another
	 * round: the error that escapes then says whether the write can still land.
	 * @returns who holds the finished write, for the sync to report.
	 * @throws TornActionError — see {@link TornActionReason} for the three causes. Only an unsettled
	 * `completion-refused` (always `final: false`) is retried by the write paths.
	 *
	 * NOTE: the re-send costs a full pend and commit round even when every block had in fact landed
	 * (a lost or masked success). That is deliberate — it is the source of the durability the sync
	 * reports when nothing has superseded the write — and the case is rare: after a returned failure
	 * the network transactor has, by construction, NOT swept every block. If own-entry refreshes ever
	 * show up as a cost, ask `getLineage` first and skip the re-send when every block contains the
	 * write. */
	private async completeOwnEntry(entry: ActionEntry<Action<TAction>>, entryRev: number | undefined, lastChance: boolean): Promise<WriteDurability | undefined> {
		const attempt = this.inFlightAttempt;
		const rev = entryRev ?? attempt?.rev;
		if (attempt === undefined || rev === undefined || attempt.rev !== rev) {
			// Nothing to finish the action WITH. That is only acceptable if there is nothing to
			// finish. `getStatus` is the cheap first question; it judges a block by who holds its
			// LATEST revision, so a block this action landed and a later action has since built on
			// reads there as not committed — those are asked again, properly, by settleUnfinished.
			// Both write paths retain an attempt before any refresh can run, so production only
			// reaches this branch when the entry sits at a revision the retained attempt was not
			// made at — a forked lineage.
			const [status] = await this.transactor.getStatus([{ actionId: entry.actionId, blockIds: entry.blockIds }]);
			if (entry.blockIds.every((_, i) => status?.statuses[i] === 'committed')) {
				// Whole, and saved: the refresh reports it as finished (see RefreshReport), so the
				// coordinator counts this participant as committed. Only WHO holds it is unknown.
				// NOTE: a sync whose only commit was recognised here therefore answers `undefined` —
				// the "nothing was written" answer — for a write that is saved, because the sync reads
				// the report's durability, not the finished flag. Reachable only on the forked-lineage
				// path above; if that path ever becomes ordinary, take the durability from
				// `getLineage` (as settleUnfinished does) instead of stopping at the status read.
				return undefined;
			}
			return await this.settleUnfinished(entry, rev, undefined, 'transforms-not-held',
				attempt === undefined
					? 'no failed attempt is retained for this action'
					: `the retained attempt was made at rev ${attempt.rev}`);
		}

		// NOTE: priority 0. The attempt's aged retry priority is a fairness hint for a race over a
		// free revision; this revision is already this action's own, so there is no race to rank in.
		// NOTE: this is a plain pend. When the failed attempt came from `TransactionCoordinator`, its
		// pend carried `validation` (the transaction and its operations hash) and
		// `superclusterNominees`; neither is retained, so the re-send carries neither. Harmless while
		// no deployment hands members a transaction validator (and nothing reads the nominees on
		// the receiving side at all). Once a validator is wired, members approve these
		// blocks unchecked under `unvalidatablePendPolicy: 'accept'` and refuse them under `'reject'`
		// (surfacing as a `completion-refused` TornActionError). Simply retaining and re-sending the
		// pair is not obviously right either: a member re-executing the transaction after a sibling
		// participant has landed no longer sees the state it was staged against. Tracked as an arm
		// of tickets/backlog/feat-no-deployment-validates-transactions-at-pend.
		const result = await this.source.transact(attempt.transforms, entry.actionId, rev, this.id, attempt.tailId, 0, attempt.blockDigests, attempt.baseRevs);
		if (result.success) {
			return result.durability;
		}
		// A refusal that CONFIRMS a committed revision under another action — `staleAt`, which every
		// producer sets only after reading it out of its own storage and never for this action's own
		// revision, or a non-empty `missing` list of committed rival transforms — will be repeated by
		// every later re-send. Anything else (a rival merely PENDING on a block, a revision not yet
		// held by a majority, a bare reason) can clear, and is worth the caller's next round.
		// NOTE: `staleAt` is read here as "a rival committed", which is a second consumer of a field
		// documented as never a retryability signal (docs/internals.md). It is the same kind of use
		// `syncAttempts`' stall check makes: it can only END a retry, never start one.
		const rivalConfirmed = result.staleAt !== undefined || (result.missing?.length ?? 0) > 0;
		// NOTE: a confirmed rival settles at once, even with retry budget left: re-sending is
		// pointless, but the lineage question is asked only this once, so a member that is silent
		// just now makes the answer `final: false`. If unsettled outcomes ever show up often under
		// contention, spend the remaining rounds re-asking `getLineage` before giving up.
		if (!rivalConfirmed && !lastChance) {
			// The refusal does not say which blocks lack the revision, so name every block the entry
			// lists other than the tail — the entry being visible is what proves the tail holds it.
			return this.throwTorn(entry, rev, entry.blockIds.filter(blockId => blockId !== attempt.tailId),
				'completion-refused', false, result.reason ?? 'the re-send was refused');
		}
		return await this.settleUnfinished(entry, rev, attempt.tailId,
			rivalConfirmed ? 'rival-holds-revision' : 'completion-refused',
			result.reason ?? (rivalConfirmed ? 'a different action holds a later revision' : 'the re-send was refused'),
			result.staleAt);
	}

	/** Decides what a write that can no longer be finished BY RE-SENDING amounts to, and answers
	 * one of exactly three things — never a guess between them:
	 *
	 * - SAVED (returns): every block the entry names holds content built from the write, on a
	 *   strict majority of its cohort (`ITransactor.getLineage`). The rival that refused the re-send
	 *   had read this write and added to it. Returns who holds it.
	 * - TORN AND FINAL (throws, `final: true`): every block still missing the write answered, for its
	 *   whole cohort, that it does not hold it — and the write's pending records were confirmed gone
	 *   BEFORE the blocks were asked. The order is the point: a pending record left standing can be
	 *   promoted by any later read that knows this write's log entry is committed
	 *   (`StorageRepo.get`), so a block that answered "not reached" could still take the write
	 *   afterwards. With the records gone first, nothing is left that could land it.
	 * - TORN, OUTCOME NOT ESTABLISHED (throws, `final: false`): anything else — the transactor
	 *   cannot answer for lineage, a cohort did not all answer or contradicted itself, fewer than a
	 *   majority hold the write, or the cancel could not be confirmed.
	 *
	 * `tailId` is the log block this write's entry was appended to, when known. It is never asked
	 * about: the refresh has just READ the entry out of it, which is direct evidence that the
	 * block's current content was built from the write, whatever any member's records can prove.
	 *
	 * NOTE: a write recognised as saved here reports the durability `getLineage` assembled. When
	 * the log block's own cohort could not vouch for it (members that took it as a replica), that is
	 * absent and the sync answers `undefined` for a saved write — the same wart the status-read
	 * branch of {@link completeOwnEntry} documents. If it is ever seen, fold the data blocks'
	 * reports alone rather than inventing one for the log block. */
	private async settleUnfinished(
		entry: ActionEntry<Action<TAction>>,
		rev: number | undefined,
		tailId: BlockId | undefined,
		reason: TornActionReason,
		detail: string,
		staleAt?: { blockId: BlockId; rev: number },
	): Promise<WriteDurability | undefined> {
		const discharged = await this.dischargeOwnPendings(entry);
		const lineage = rev === undefined ? undefined : await this.lineageOfOwnEntry(entry, rev);
		const unsaved = entry.blockIds.filter((blockId, i) => blockId !== tailId && lineage?.blocks[i] !== 'contains');
		if (lineage !== undefined && unsaved.length === 0) {
			log('collection:own-entry-superseded-but-saved id=%s tag=%s action=%s rev=%d blocks=%d',
				this.id, this.instanceTag, entry.actionId, rev, entry.blockIds.length);
			return lineage.durability;
		}
		const cannotLand = lineage !== undefined && unsaved.every(blockId => {
			const answer = lineage.blocks[entry.blockIds.indexOf(blockId)];
			return answer === 'excludes' || answer === 'behind';
		});
		return this.throwTorn(entry, rev ?? -1, unsaved, reason, discharged && cannotLand, detail, staleAt);
	}

	/** Cancels every pending record this write may have left, and says whether that is CONFIRMED.
	 * `ITransactor.cancel` returns only once the records are gone and throws otherwise; a throw here
	 * is reported as "not confirmed" rather than raised, because the caller is already reporting a
	 * torn write and that must not be displaced. Cancelling a block that holds no record is a no-op,
	 * so naming every block the entry lists is safe. */
	private async dischargeOwnPendings(entry: ActionEntry<Action<TAction>>): Promise<boolean> {
		try {
			await this.transactor.cancel({ actionId: entry.actionId, blockIds: entry.blockIds });
			return true;
		} catch (err) {
			log('collection:torn-cancel-unconfirmed id=%s tag=%s action=%s error=%s',
				this.id, this.instanceTag, entry.actionId, err instanceof Error ? err.message : String(err));
			return false;
		}
	}

	/** What the blocks' own history says about this write, or `undefined` when nothing can say: the
	 * transactor (or a wrapper around it) does not offer `getLineage`, or the question failed. */
	private async lineageOfOwnEntry(entry: ActionEntry<Action<TAction>>, rev: number): Promise<ActionLineage | undefined> {
		if (this.transactor.getLineage === undefined) {
			return undefined;
		}
		try {
			return await this.transactor.getLineage({ actionId: entry.actionId, blockIds: entry.blockIds, rev });
		} catch (err) {
			log('collection:lineage-unanswered id=%s tag=%s action=%s rev=%d error=%s',
				this.id, this.instanceTag, entry.actionId, rev, err instanceof Error ? err.message : String(err));
			return undefined;
		}
	}

	private throwTorn(
		entry: ActionEntry<Action<TAction>>,
		rev: number,
		blockIds: BlockId[],
		reason: TornActionReason,
		final: boolean,
		detail: string,
		staleAt?: { blockId: BlockId; rev: number },
	): never {
		log('collection:torn id=%s tag=%s action=%s rev=%d reason=%s final=%s blocks=%o',
			this.id, this.instanceTag, entry.actionId, rev, reason, final, blockIds);
		throw new TornActionError(this.id, entry.actionId, rev, blockIds, reason, final, detail, staleAt);
	}

	/** Drops the pending actions this sync's OWN committed entry made durable, instead of replaying
	 * them into a duplicate entry (see {@link inFlightActionId}). Only ever called once
	 * {@link completeOwnEntry} has returned for this entry — the entry alone is not proof the write
	 * is saved.
	 *
	 * `addActions` wrote exactly the snapshot pending list under this action id, and the entry's
	 * actions are therefore the LEADING `entry.actions.length` items of `this.pending` — anything
	 * staged since is behind them, because {@link actInternal} appends. Under
	 * {@link syncInternal} nothing can even be staged mid-cycle (`act()` shares the collection
	 * latch); under `TransactionCoordinator.commit` the mark spans a latch-free inter-attempt
	 * window, so an `act()` there CAN grow `pending` — still only at the tail, so the slice stays
	 * right.
	 *
	 * The guard below is the load-bearing part: `slice` fails SILENTLY if that correspondence ever
	 * breaks, dropping actions that were never committed, so an entry longer than `pending` throws
	 * instead of losing work. (See the sibling note on `syncInternal`'s post-commit replay, which
	 * rests on the same invariant.) */
	private consumeOwnEntry(entry: ActionEntry<Action<TAction>>) {
		if (entry.actions.length > this.pending.length) {
			throw new Error(
				`Collection ${this.id}: own committed entry for action ${entry.actionId} holds `
				+ `${entry.actions.length} actions but only ${this.pending.length} are pending; `
				+ `consuming it would drop actions that were never committed`);
		}
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
	 * by omission.
	 *
	 * @param report - Filled in as the refresh goes (see {@link RefreshReport}): its
	 * `ownEntryFinished` is set the moment the refresh has found this write's own log entry and
	 * finished it ({@link completeOwnEntry}) — before the entry is consumed, so a later throw from
	 * here still leaves it set. Never set on a reader's refresh. A caller with no use for it passes `{}`.
	 * @param lastChance - Whether the write in flight will get no further refresh (see
	 * {@link completeOwnEntry}). Meaningless, and left false, on a reader's refresh.
	 * @throws TornActionError when it found that entry and could not finish the action — thrown
	 * before anything on this instance changed, and with `report` untouched. */
	private async updateInternal(report: RefreshReport, lastChance = false): Promise<void> {
		// Start with a context that can see to the end of the log
		const source = new TransactorSource(this.id, this.transactor, undefined);

		// A header the storage layer could not retrieve throws BlockUnavailableError out of
		// this read (it is not a StaleFailure, so sync's retry loop does not absorb it).
		const ends = await Collection.readLogEnds(this.transactor, this.id, this.logTailId);
		if (!ends) {
			if (this.source.actionContext) {
				// An absent header is only believable for a collection that has never committed.
				// We hold a committed revision, so the two answers contradict each other — surface it
				// as a fault instead of no-opping into a forgotten revision and a rev-1 retry spin.
				// NOTE: this aborts every caller of update(), including TransactionCoordinator's
				// blanket refresh of ALL registered collections between commit retries — a
				// non-participant with a momentarily-absent header now fails the whole retry rather
				// than being skipped (the coordinator still refreshes the remaining collections first,
				// so a participant that can be finished is). That is the intended loud failure; if it ever shows up as
				// otherwise-healthy transactions aborting, narrow that refresh to the transaction's
				// participants (see the note at coordinator.ts's update loop) rather than softening
				// this throw.
				throw new CollectionHeaderVanishedError(this.id, this.source.actionContext.rev);
			}
			// The header is genuinely absent AND we hold no revision: nothing was ever committed under
			// this id, so there is no log to walk and nothing to adopt — correct here, rather than a
			// masked failure.
			return;
		}
		this.logTailId = ends.header.tailId;
		// Bootstrap context from committed tail so pending blocks are accessible.
		Collection.bootstrapContext(source, ends.tail);

		// The revision the committed tail just claimed, captured before anything else can touch
		// the local source. This is the authoritative "latest committed under this id" number,
		// read straight off the tail block's state; the chain walk below arrives at its own
		// number by a different path, and the two disagreeing is worth saying out loud (see the
		// {@link reportShortfall} call after advanceContext). Stays undefined when there is no
		// tail, or a tail with no `latest` — both legitimate "nothing committed yet" states.
		const tailRev = source.actionContext?.rev;

		const actionContext = this.source.actionContext;
		// A write's retry refresh always walks. Not needed for soundness — the write's own entry would
		// sit above the held revision, which the tail test already refuses — but losing that entry
		// loses the write, and a retry refresh is rare enough that the walk costs nothing that matters.
		if (this.inFlightActionId === undefined && Collection.tailShowsNothingNewer(actionContext, ends.tail)) {
			return;
		}

		// One block cache for the whole refresh, seeded with the header and tail just read: Log.open,
		// the entry walk and the invalidation walk each start again from the header and the tail, and
		// would otherwise fetch both every time. The seed came from UNPINNED reads and is served to
		// reads pinned at the tail's claim, which is sound: the tail's content at its own claimed
		// revision is that pinned view, and the header changes only when the tail block fills, which
		// Chain.getTail already tolerates by following `nextId` from whichever tail the header names.
		// NOTE: the cache keeps its default size (128 blocks, about 4,000 log entries). The entry walk
		// reads every log block back to the head (no checkpoints), newest first, so past that size
		// the newest blocks are evicted first and the invalidation walk fetches them again. If logs
		// get that long before checkpoints land, walk entries and invalidations in one pass.
		const tracker = new Tracker(new CacheSource(source, undefined, undefined, ends.served));

		// Get the latest entries from the log, starting from where we left off
		const collectionLog = await Log.open<Action<TAction>>(tracker, this.id);
		const latest = collectionLog ? await collectionLog.getFrom(actionContext?.rev ?? 0) : undefined;

		// This write's own entry, if its log tail landed despite the failure that sent us here.
		// Decided ONCE, here: the mark can be cleared latch-free while the completion below is
		// awaiting (see {@link inFlightActionId}), and an entry that was finished as our own must
		// not then be run through the conflict filter as a stranger's and replayed.
		const inFlightActionId = this.inFlightActionId;
		const ownEntry = inFlightActionId === undefined
			? undefined
			: latest?.entries.find(entry => entry.actionId === inFlightActionId);
		// Finish it BEFORE anything below changes this instance — see {@link completeOwnEntry}. A
		// throw from here (the action cannot be finished, or not yet) therefore abandons the refresh
		// with the staged actions, the tracker and the held revision exactly as they were.
		// The entry's revision comes from the context the same walk built; an entry older than a
		// checkpoint is not restated there, and completeOwnEntry falls back to the attempt's own.
		const entryRevs = Collection.revisionsByAction(latest?.context);
		if (ownEntry !== undefined) {
			const durability = await this.completeOwnEntry(ownEntry, entryRevs.get(ownEntry.actionId), lastChance);
			// Saved from here on, whatever below throws — record it before anything else can.
			report.ownEntryFinished = { durability };
		}

		// Process the entries and track the blocks they affect
		let anyConflicts = false;
		for (const entry of latest?.entries ?? []) {
			const isOwnEntry = entry === ownEntry;
			const { after, mutated } = isOwnEntry
				? this.consumeOwnEntry(entry)
				: this.filterAgainstEntry(entry);
			this.pending = after;
			anyConflicts = anyConflicts || mutated || this.tracker.conflicts(new Set(entry.blockIds)).length > 0;
		}

		// React to durable invalidations that landed since we last synced. getFrom intentionally skips
		// invalidation entries (they are not pending/committed actions), so surface them separately: an
		// invalidation reverted committed content this client may have read, so treat it like a stale
		// read — drop the reverted blocks from the read cache and replay pending work against the reverted
		// base (docs/right-is-right.md §Client notification). De-duped across cascade children by reverted
		// block; over-inclusive by design (over-invalidation just resubmits — it never wrongly retains).
		const invalidations = collectionLog ? await collectionLog.getInvalidationsFrom(actionContext?.rev ?? 0) : [];
		const revertedBlockIds = [...new Set(invalidations.flatMap(inv => inv.reverted.map(r => r.blockId)))];
		if (invalidations.length > 0 && this.pending.length > 0) {
			anyConflicts = true;
		}

		this.forgetAndAdopt(latest, entryRevs, revertedBlockIds, ends.served);

		Collection.reportShortfall(this.id, this.instanceTag, tailRev, actionContext?.rev, this.source.actionContext?.rev);

		// Re-stage the pending actions against the adopted revision. The affected
		// blocks were already dropped from sourceCache above (per log entry / per invalidation),
		// so the replay's reads re-materialize from the transactor.
		// NOTE: a throw out of replayActions leaves the tracker holding only the transforms
		// replayed so far while `pending` still lists them all; the caller's error handling is
		// expected to abort/reset the collection rather than keep staging. The coordinator's partial
		// report after a refresh-saved sibling does not (backlog: debt-a-failed-refresh-can-leave-a-
		// collection-half-restaged). If replay ever gains a
		// routinely-throwing read path, rebuild into a scratch tracker and swap on success.
		if (this.mustReplay(anyConflicts, actionContext)) {
			await this.replayActions();
		}
	}

	/** Forget every block the refresh saw change, floor the ones a log entry names, adopt the
	 * revision the log is at, and keep what the refresh already read
	 * ({@link keepWhatTheRefreshRead}) — ONE synchronous step, which must stay free of any `await`.
	 *
	 * Reads are not latched, so one can run while a refresh is under way. Forgetting a block while
	 * this handle still reads at the revision it is LEAVING invites exactly the wrong re-read: the
	 * block comes back as it was at that revision (correctly — that is what was asked for, and no
	 * floor applies to a read below it), the cache keeps it, and the advance that follows turns it
	 * into old content nothing will ever clear, the entry that named it having been consumed. That
	 * needs no lagging machine; storage can be perfectly current. With no gap between the forgetting
	 * and the adopting, a concurrent read either lands before both and is forgotten with the rest,
	 * or lands after both and is judged at the adopted revision — against the floor
	 * ({@link TransactorSource.tryGet} reads its context when the answer arrives, not when it was
	 * asked for) and against the generation the clear moved (`CacheSource.stillWanted`).
	 *
	 * The advance is monotonic (see {@link advanceContext}): an empty or unopenable log yields no
	 * context at all, and a log read that lags what this handle already committed yields an older
	 * one; neither is grounds for forgetting the revision held. It also has to precede
	 * {@link replayActions}, which re-reads blocks through `this.source` at whatever revision the
	 * context names — replaying first would refill the cache at the revision being left. */
	private forgetAndAdopt(
		latest: GetFromResult<Action<TAction>> | undefined,
		entryRevs: ReadonlyMap<ActionId, number>,
		revertedBlockIds: BlockId[],
		served: LogEnds['served'],
	): void {
		for (const entry of latest?.entries ?? []) {
			this.sourceCache.clear(entry.blockIds);
			this.raiseFloors(entry, entryRevs.get(entry.actionId));
		}
		this.sourceCache.clear(revertedBlockIds);
		Collection.advanceContext(this.source, this.id, this.instanceTag, 'refresh', latest?.context);
		this.keepWhatTheRefreshRead(served);
	}

	/** Put the header and log tail block {@link readLogEnds} already fetched into this handle's own
	 * cache, so the next read of either is a hit rather than a second fetch of a block just
	 * received. Without it, a write that follows ANOTHER handle's commit fetches the log tail twice:
	 * the refresh reads it, the walked entry names it (a commit's blocks include the log block its
	 * entry was appended to) so the clear above drops it, and `Chain.add` then reads it again to
	 * append this write's own entry.
	 *
	 * Last in {@link forgetAndAdopt}'s one synchronous step, after BOTH clears — offering before
	 * either would simply be undone by it. An id that an invalidation reverted is therefore
	 * re-offered rather than left forgotten, which is sound because the revert is itself a commit
	 * and {@link readLogEnds} read unpinned: what it read already includes the revert.
	 *
	 * An offer is made only when all three hold:
	 * - **This handle holds a context.** With none adopted, every later read is unpinned and may
	 *   legitimately be answered newer than what was read here, so there is nothing to judge the
	 *   offer against.
	 * - **The served revision is at or below the adopted one.** {@link readLogEnds} reads unpinned,
	 *   so it can come back newer than the view this handle now reads at — exactly the
	 *   `collection:context-short-of-tail` case. Serving that to a read pinned lower would fabricate
	 *   a view that never existed. At or below the pin it is sound: a block whose newest content is
	 *   at `rev <= context.rev` has the same content at `context.rev`.
	 * - **The served revision meets any applicable floor.** A cache must never keep a below-floor
	 *   answer.
	 *
	 * NOTE: the floor check lives here because {@link readLogEnds} reads around
	 * {@link TransactorSource}, which is what applies floors on every other read — nothing else on
	 * this path would apply one. It asks {@link BlockFloors.meetsApplicableFloor} rather than
	 * spelling the comparison out, so it cannot drift from the one `answeredBelowFloor` makes, and
	 * asks the non-reporting face because this is not an answer being served to a reader — the
	 * `collection:block-below-floor` line would misdescribe it.
	 *
	 * Only this site seeds. The early return at {@link tailShowsNothingNewer} is deliberately left
	 * alone: it fires when the log has not moved, and the cache is then already warm with the tail
	 * (folded in by this handle's own commit, or kept from its last walk), so seeding there would
	 * buy a fetch back only when the LRU had evicted it — at the cost of putting the one-synchronous-
	 * step reasoning in a second place. */
	// NOTE: an offer whose revision equals what the cache already holds is still kept, so a walking
	// refresh bumps the header's generation even when the header was neither cleared nor changed.
	// Over-bumping is safe (see `CacheSource.bump`) and costs a re-materialize of that block on its
	// next read; if that ever shows up, skip the offer when the cache already RETAINS the id at the
	// same revision — but note it would then also stop correcting a cached block whose content was
	// folded forward locally at that revision.
	private keepWhatTheRefreshRead(served: LogEnds['served']): void {
		const context = this.source.actionContext;
		if (context === undefined) {
			return;
		}
		for (const [blockId, block, rev] of served) {
			if (rev <= context.rev && this.floors.meetsApplicableFloor(blockId, context, rev)) {
				this.sourceCache.offerServed(blockId, block, rev);
			}
		}
	}

	/** The revision each action in `context` committed at, keyed by action id. `Log.getFrom` returns
	 * entries without their revisions; the context the same walk built is where they are restated. */
	private static revisionsByAction(context: ActionContext | undefined): Map<ActionId, number> {
		return new Map((context?.committed ?? []).map(({ actionId, rev }) => [actionId, rev]));
	}

	/** Records that the walked `entry` changed the blocks it names, so a later answer for one of
	 * them that is older than the entry is recognised and never remembered (see {@link BlockFloors}).
	 * Beside the cache clear on purpose (see {@link forgetAndAdopt}): the clear is what sends the next
	 * read of these blocks back to storage, and that read is the one a lagging machine can answer too
	 * old — after which nothing would clear the block again, this entry having been consumed.
	 *
	 * NOTE: an entry whose revision the walk did not restate sets no floor. That is an entry older
	 * than the log's most recent checkpoint, and no checkpoint is written today
	 * (tickets/backlog/debt-the-collection-log-never-writes-a-checkpoint). Once they are, such an
	 * entry's blocks go unguarded unless `Log.getFrom` starts returning each entry's revision. */
	private raiseFloors(entry: ActionEntry<Action<TAction>>, rev: number | undefined): void {
		if (rev !== undefined) {
			this.floors.raise(entry.blockIds, { rev, actionId: entry.actionId });
		}
	}

	/** Whether the log tail a refresh just read proves the log holds nothing newer than `held` —
	 * the test that lets a refresh with nothing to find stop after one request instead of walking
	 * the log.
	 *
	 * Sound because every commit and every invalidation appends a log entry, and entries only ever
	 * go on the tail block. A tail block that is still the end of the chain (no `nextId`), whose
	 * newest entry is at the held revision and names the action `held` names there — and whose own
	 * claim (`state.latest`) says the same — has nothing above `held`. The walk would then find no
	 * entries, no invalidations, and a context {@link advanceContext} adopts at an unchanged
	 * revision, so it would change nothing.
	 *
	 * Says "no" — sending the refresh down the full walk — whenever the tail and the held context
	 * disagree in any way, so everything that walk reports still fires:
	 * - a claim above `held` (ordinary catch-up) or below it (a lagging read);
	 * - a newest entry that is not the claimed action, or not an action at all: the entries lag the
	 *   claim (`collection:context-short-of-tail`, or `collection:context-not-lowered` for a handle
	 *   pinned by an over-claiming tail), or an invalidation or checkpoint took the newest slot;
	 * - any action entry in the tail block naming a different action than `held` names at the same
	 *   revision (`collection:lineage-divergence`, and the walk's adoption of the log's list).
	 *
	 * NOTE: the lineage comparison sees only the entries the tail block holds. A fork below them, on
	 * a log that has not moved, is not looked at again until a refresh finds something new — that
	 * walk compares the whole list. Walking every time to look is exactly the cost this avoids.
	 *
	 * NOTE: an invalidation entry in the newest slot never matches (it names no action), so every
	 * refresh after one walks the log until the next commit lands. Fine while disputes are rare; if
	 * they are not, match an invalidation slot against the held revision too. */
	private static tailShowsNothingNewer(held: ActionContext | undefined, tail: GetBlockResult | undefined): boolean {
		const claim = tail?.state.latest;
		const block = tail?.block as LogBlock<unknown> | undefined;
		if (held === undefined || claim === undefined || !block || block.nextId !== undefined) {
			return false;
		}
		const newest = block.entries[block.entries.length - 1];
		return claim.rev === held.rev
			&& newest?.rev === claim.rev
			&& newest.action?.actionId === claim.actionId
			&& actionIdAt(held, held.rev) === claim.actionId
			&& !Collection.disagreesWithHeld(held, block.entries);
	}

	/** Whether any action entry in `entries` names a different action than `held` names at the same
	 * revision. A revision only one side names is missing evidence, not disagreement — the rule
	 * {@link earliestFork} applies too. */
	private static disagreesWithHeld(held: ActionContext, entries: readonly LogEntry<unknown>[]): boolean {
		const logged = new Map(entries.flatMap(entry => entry.action ? [[entry.rev, entry.action.actionId] as const] : []));
		return held.committed.some(entry => {
			const loggedAction = logged.get(entry.rev);
			return loggedAction !== undefined && loggedAction !== entry.actionId;
		});
	}

	/** Whether {@link updateInternal} must re-stage `pending` after adopting `latest`, given the
	 * context it held BEFORE the refresh.
	 *
	 * The answer is deliberately NOT just "a conflict was found". A conflict is detected by an
	 * incoming log entry naming a block this tracker already holds a transform for — so an action
	 * that changed NO block can never register one. A staged delete of a key this instance cannot
	 * see is exactly that action: the tree's `replace` handler misses on `find` and `deleteAt`
	 * returns false without writing. Gated on conflicts alone, such an action stayed in `pending`
	 * unapplied until the commit wrote a log entry listing it whose transforms did nothing — and
	 * readers materialize blocks, not log entries, so the action was lost on every node, silently
	 * and permanently. The invariant that has to hold is that **a pending action was applied
	 * against the revision it commits over**, so a mere revision advance is reason enough.
	 *
	 * The advance test rests on {@link advanceContext} being monotonic (it refuses to lower), which
	 * is what makes "the adopted rev differs from the held one" mean "it went up".
	 *
	 * The second conjunct is `pending.length` and deliberately NOT {@link hasUnsyncedChanges},
	 * which also counts tracker transforms. A collection {@link createOrOpen} just INVENTED holds
	 * its staged header/root in the tracker with NO pending action naming them, and
	 * {@link replayActions} resets the tracker before re-staging — so counting transforms here
	 * would drop those blocks and leave a brand-new collection unreadable (the same hazard
	 * {@link snapshotPending} documents). Nothing to re-stage means nothing to replay.
	 *
	 * NOTE: this makes a refresh that adopts a newer revision O(pending) rather than free, so a
	 * read taken mid-transaction while a rival keeps committing re-stages every action staged so
	 * far, on each such read. Measured as no change to the storage-op budgets
	 * (`index-backfill-cost.spec.ts`, `cold-apply-cost.spec.ts`), because the replay's reads are
	 * served from `sourceCache`. If a long transaction's reads ever show up as slow, narrow the
	 * replay to the actions whose reads the adopted entries actually invalidated — NOT back to
	 * conflicts alone, which is the defect above. */
	private mustReplay(anyConflicts: boolean, priorContext: ActionContext | undefined): boolean {
		if (anyConflicts) {
			return true;
		}
		const adoptedRev = this.source.actionContext?.rev;
		if (adoptedRev !== undefined && adoptedRev !== priorContext?.rev && this.pending.length > 0) {
			return true;
		}
		// Third reason: a staged block's base has MOVED — the read cache no longer describes it at
		// the revision its operations were computed against (see `Tracker.movedBases`). A refresh
		// that adopted nothing and found no conflict can still be standing over such a block: a
		// concurrent read served content the cache then kept at a newer revision, say. Re-staging
		// is the only repair; declaring the pinned revision on the pend would merely get it refused.
		return this.pending.length > 0 && this.logMovedBases(this.tracker.movedBases()) > 0;
	}

	/** Re-judge every staged update's pinned base against the read cache and re-stage the pending
	 * queue if any has moved. Runs immediately before each pend attempt — {@link syncAttempts} and
	 * the coordinator's commit span both call it — because that is the last moment before the
	 * base the pend declares is put on the wire, and nothing between a refused attempt and the
	 * re-pend reads the block again (the refresh may have moved nothing and so replayed nothing).
	 *
	 * Two steps. First, one read for each pinned block the cache does NOT retain — content handed
	 * through unkept (a below-floor answer, which the cache re-asks for on every read anyway): the
	 * pin names the revision last served, storage may have caught up since without the log moving,
	 * and only a read can tell. An evicted-but-kept base needs no read: its content met every floor
	 * the handle knows, so storage cannot have moved it without a log entry the next refresh will
	 * walk (and the pend would be refused as stale on revision alone). Then, one cache probe per
	 * pinned block ({@link Tracker.movedBases}) and a replay if any moved.
	 *
	 * Latch-free by contract, like {@link snapshotPending}: the caller holds this instance's latch
	 * ({@link replayActions} is always run under it).
	 *
	 * NOTE: reads are not latched, so a concurrent read can still move a base between this check
	 * and the pend. The pend then declares the pin's (old) revision, storage refuses it, and the
	 * next attempt's call here re-stages — one wasted round trip, never a wrong base. If that
	 * refusal ever shows up in practice, the closure is to hold the pend under the read latch.
	 *
	 * @returns whether the pending queue was re-staged. */
	async restageIfBasesMoved(): Promise<boolean> {
		for (const id of this.tracker.unretainedBases()) {
			// `navigation` never upgrades the purpose the original read recorded (value-wins), and
			// the revision recorded is the one returned, which the replay below re-records anyway.
			await this.sourceCache.tryGet(id, 'navigation');
		}
		if (this.pending.length === 0 || this.logMovedBases(this.tracker.movedBases()) === 0) {
			return false;
		}
		await this.replayActions();
		return true;
	}

	/** Report each moved base, naming the revision the operations were computed against and the
	 * one the cache describes now, and return how many there were. */
	private logMovedBases(moved: readonly BlockId[]): number {
		if (log.enabled) {
			for (const blockId of moved) {
				log('collection:restage-moved-base id=%s tag=%s block=%s pinnedRev=%s currentRev=%s',
					this.id, this.instanceTag, blockId,
					this.tracker.stagedBaseRevs([blockId])[blockId] ?? 'none',
					this.sourceCache.getCachedRevision(blockId) ?? 'none');
			}
		}
		return moved.length;
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
			pins: this.tracker.pins.copy(),
			pending: [...this.pending],
			context: structuredClone(this.source.actionContext),
		};
	}

	/** Restore the staged state captured by {@link snapshotPending}, discarding any
	 * mutations staged since. Reads through the collection then observe exactly the
	 * snapshot state again; storage is untouched because nothing was ever synced.
	 *
	 * A snapshot is only restorable VERBATIM onto the committed boundary it was captured
	 * on. If this collection has since ADOPTED a newer committed revision — a rival's
	 * commit folded in by a refresh while the snapshot's transaction was in flight, e.g.
	 * the conflict replay that refused a guarded insert (TreeKeyTakenError) — the
	 * snapshot's transforms describe block state at the OLD boundary, and reinstalling
	 * them would shadow committed blocks with stale structure. The observed case: an
	 * INVENTED collection's pre-commit header/root transforms restored over the rival's
	 * now-committed collection make every later read descend an empty tree, silently
	 * hiding the committed rows. When the snapshot's pending queue is empty (the
	 * transaction-rollback shape: the capture predates the transaction's first stage),
	 * the correct restore target IS the committed state — reset the tracker empty and
	 * let reads flow through to the adopted revision.
	 *
	 * NOTE: a snapshot that carries PENDING actions across a moved boundary (a
	 * mid-transaction savepoint captured before a mid-transaction refresh adopted a
	 * rival's commit) still restores verbatim below — rebasing it would require an async
	 * replay this synchronous method cannot run. That shape predates this guard and
	 * keeps its old behaviour; if it is ever observed producing stale reads, the rebase
	 * belongs in an async caller that can replay the pending queue (see replayActions).
	 * The WRITE side of that shape is closed here: the snapshot's base pins are restored with
	 * its transforms, so the restored operations name the bases they were computed on, and the
	 * pre-pend re-validation (restageIfBasesMoved) finds those bases moved and re-stages. */
	restorePending(snapshot: CollectionSnapshot<TAction>): void {
		const capturedRev = snapshot.context?.rev;
		const currentRev = this.source.actionContext?.rev;
		const boundaryMoved = currentRev !== undefined && (capturedRev === undefined || currentRev > capturedRev);
		if (boundaryMoved && snapshot.pending.length === 0) {
			this.tracker.reset();
			this.pending = [];
			return;
		}
		this.tracker.reset(copyTransforms(snapshot.transforms));
		if (snapshot.pins) this.tracker.pins.replaceWith(snapshot.pins);
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
		// The view shares this handle's floors, so a block the last refresh saw change is not kept
		// too old by the view either. A view pinned below a floor is untouched by it.
		const pinnedSource = new TransactorSource<IBlock>(
			this.id, this.transactor, structuredClone(pinContext), collector, this.floors);
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
	 * how an operator reads the difference.
	 *
	 * The one exception is `undefined` itself, which is a STATE rather than a revision:
	 * "this instance invented the collection and has never adopted a committed revision".
	 * For the same reason (only this instance moves it), it stays true until this instance
	 * updates, syncs or records a commit, so a caller holding a freshly opened instance may
	 * branch on it — the Quereus adapter does, to leave an invented, never-written index tree
	 * unflushed exactly as an unwritten table tree is left. Never branch on the NUMBER. */
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
	 * MUST call the release exactly once, in a `finally`.
	 *
	 * NOTE: the commit paths are the ONLY callers — {@link act}, {@link update} and {@link sync}
	 * take the same mutex through `Latches.acquire` directly, never through here. The acquisition
	 * -order cases in `test/coordinator-latch-span.spec.ts` rely on that: they shadow this method
	 * to record the span's order, so routing a refresh path through it would silently fold
	 * refreshes into those recordings and weaken the assertions rather than fail them. Route a new
	 * refresh caller here only alongside a filter in that spy. */
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
	 * A concurrent READER's refresh landing in that latch-free window is fine, and is reachable
	 * today (`OptimysticModule` declares `concurrencyMode = 'reentrant-reads'`, so scans inside a
	 * transaction share one instance and only serialize on the latch). Consuming is a property of
	 * the (instance, action id) pair, not of who calls: whoever refreshes first drops exactly the
	 * durable entry's actions and the write's own later refresh then finds nothing new. The leading
	 * slice stays right because {@link actInternal} APPENDS, so anything staged after the entry was
	 * written survives it.
	 *
	 * NOTE: a concurrent WRITER is the hazard. The mark deliberately outlives the latch (see
	 * {@link inFlightActionId}), so two writes overlapping on ONE instance can trample each other's:
	 * a second write that acquires the latch between the first's failed attempt and its
	 * retry-refresh replaces the id, and the first's refresh then reads the SECOND write's id —
	 * consuming that write's durable entry and dropping pending actions of its own that never
	 * landed. Not reachable today: a coordinator commit and a `sync()` both run on one session call
	 * path, which is the same assumption the participant selection in
	 * `TransactionCoordinator.commitOnce` and its `rollback` already rest on. If a second writer is
	 * ever allowed to drive the SAME instance concurrently, this must become a per-attempt token (a
	 * mark object compared by identity, refusing to replace a live one) rather than a bare id. */
	beginInFlightAction(actionId: ActionId): () => void {
		if (this.inFlightActionId !== actionId) {
			// A different action's failed attempt cannot finish this one. Re-marking the SAME id (a
			// coordinator re-marks on every attempt) keeps what the previous attempt retained — that
			// is the attempt the next refresh may need, and the block ids it minted are what make the
			// next attempt's log append identical to it.
			this.inFlightAttempt = undefined;
			this.mintedLogBlockIds = undefined;
		}
		this.inFlightActionId = actionId;
		return () => {
			if (this.inFlightActionId === actionId) {
				this.inFlightActionId = undefined;
				this.inFlightAttempt = undefined;
				this.mintedLogBlockIds = undefined;
			}
		};
	}

	/** Keep what a FAILED attempt under `actionId` sent, so that if the refresh before its retry
	 * finds that attempt's own log entry it can finish the action rather than assume it finished
	 * (see {@link inFlightAttempt} and {@link completeOwnEntry}). Every write path that marks an
	 * action in flight must call this for each attempt that fails, BEFORE the refresh that follows —
	 * a path that does not still never reports a half-landed write as saved (the refresh then
	 * refuses with a `transforms-not-held` {@link TornActionError}), but it cannot recover from one.
	 *
	 * A no-op unless `actionId` is the action currently marked, so a late call from an attempt whose
	 * cycle has already ended cannot plant transforms under somebody else's mark. Latch-free and
	 * synchronous, like the mark itself: `TransactionCoordinator` calls it from inside its commit
	 * span, where it already holds this instance's latch. */
	retainInFlightAttempt(actionId: ActionId, attempt: InFlightAttempt): void {
		if (this.inFlightActionId === actionId) {
			this.inFlightAttempt = attempt;
		}
	}

	/** Ids for the log data blocks a write's log append may have to mint, so a RETRY of that write
	 * at the same revision sends the same ids the attempt it is repeating sent. Hand the result to
	 * {@link Log.open} as `newDataBlockId`; it yields remembered ids in order and mints (and
	 * remembers) a fresh one past the end.
	 *
	 * The divergence this closes is not confined to the new block, which on its own would only be
	 * an orphan: minting a second id also rewrites `nextId` on the block that was the tail and
	 * `tailId` on the collection header, so two attempts send DIFFERENT update operations for two
	 * blocks that already exist, under one action id and revision. A machine that landed the first
	 * attempt then reads the log as ending in one block and a machine that landed the retry reads
	 * it as ending in another, permanently — a forked history.
	 *
	 * `addActions` appends exactly one entry, so at most one block per attempt; the memory is an
	 * ordered list anyway, so a future multi-entry append cannot silently reintroduce this.
	 *
	 * Reuse is keyed on the in-flight action (the memory is cleared with the rest of that state by
	 * {@link beginInFlightAction}) AND on `rev`. At a DIFFERENT revision the write is genuinely
	 * different, and re-inserting an id an earlier attempt may have committed at the old revision
	 * would give that block a second revision on the machines that landed that attempt and a first
	 * on the machines that did not — the same divergence through another door. A revision change
	 * needs no extra bookkeeping to spot: {@link getNextRev} only ever rises, so "the same
	 * revision" is "`rev` unchanged since the ids were minted".
	 *
	 * A caller with no action marked in flight — `TransactionCoordinator.execute`, which re-runs
	 * the engine and re-stages, so its re-drive is not the same write — mints afresh and remembers
	 * nothing. */
	logAppendBlockIds(store: BlockStore<IBlock>, rev: number): () => BlockId {
		if (this.inFlightActionId === undefined) {
			return () => store.generateId();
		}
		if (this.mintedLogBlockIds?.rev !== rev) {
			this.mintedLogBlockIds = { rev, ids: [] };
		}
		const minted = this.mintedLogBlockIds;
		let next = 0;
		return () => {
			const index = next++;
			const remembered = minted.ids[index];
			if (remembered !== undefined) {
				return remembered;
			}
			const id = store.generateId();
			minted.ids[index] = id;
			return id;
		};
	}

	/** Push our pending actions to the transactor.
	 *
	 * @returns who holds what this sync committed, or `undefined` when NOTHING WAS WRITTEN — a sync
	 * with no staged changes does no pend and no commit, so there is no durability to report and none
	 * is fabricated. That is the one case a caller must handle; every other outcome either returns a
	 * class or throws ({@link SyncRetryExhaustedError} for a write that never landed). Present a change
	 * as saved only via `isFullyDurable`, never by comparing `quorum`. */
	async sync(options?: SyncOptions): Promise<WriteDurability | undefined> {
		const release = await Latches.acquire(this.latchId);
		try {
			return await this.syncInternal(options);
		} finally {
			release();
		}
	}

	/** Mints the one action id this sync reuses across all of its retry attempts, and owns it for
	 * the WHOLE cycle — including the inter-attempt refresh, which is the only thing that reads it
	 * (see {@link inFlightActionId}). `sync()`/`updateAndSync()` hold the collection latch across
	 * all of this, so the mark's lifetime is contained inside the latched span here; the disposer
	 * runs on every exit, including a throw out of retry exhaustion or an abort. */
	private async syncInternal(options?: SyncOptions): Promise<WriteDurability | undefined> {
		const bytes = randomBytes(16);
		const actionId = uint8ArrayToString(bytes, 'base64url');
		// One timestamp for the WRITE, minted here beside the action id and for the same reason: an
		// attempt that takes its own would make the retry's log block differ from the one the
		// attempt it repeats may already have stored under this `(action id, revision)`.
		const timestamp = Date.now();

		const endInFlight = this.beginInFlightAction(actionId);
		try {
			return await this.syncAttempts(actionId, timestamp, options);
		} finally {
			endInFlight();
		}
	}

	/** The retry loop behind {@link syncInternal}, run with `actionId` already marked in flight.
	 *
	 * @param timestamp the WRITE's time, stamped on the log entry every attempt appends — see
	 * {@link syncInternal}, which mints it.
	 * @returns the durability of what this sync committed, or `undefined` when the loop never ran a
	 * commit (nothing staged). See {@link sync}. */
	private async syncAttempts(actionId: ActionId, timestamp: number, options?: SyncOptions): Promise<WriteDurability | undefined> {
		const maxAttempts = options?.maxAttempts ?? DefaultMaxAttempts;
		const baseBackoffMs = options?.baseBackoffMs ?? PendingRetryDelayMs;
		const maxBackoffMs = options?.maxBackoffMs ?? DefaultMaxBackoffMs;
		const maxStalledAttempts = options?.maxStalledAttempts ?? DefaultMaxStalledAttempts;
		const deadlineMs = options?.deadlineMs;
		const signal = options?.signal;
		const startedAt = Date.now();

		// Count of consecutive stale failures that made no forward progress. Reset to 0 on every
		// successful transact, so the cap bounds only a persistently-failing sync — a legitimate
		// large multi-batch sync (which iterates many times committing progress) never trips it.
		let consecutiveFailures = 0;
		let lastReason: string | undefined;
		// Highest confirmed revision any responder has reported holding, accumulated with the
		// codebase's single rule for picking among several candidates. Reported on the error, and
		// the evidence the stall check below reasons from.
		let lastStaleAt: { blockId: BlockId; rev: number } | undefined;
		// Whether the failure most recently handled carried its OWN staleAt. A strike needs the
		// responder to have re-confirmed the number this round, not merely an older observation
		// left standing in `lastStaleAt`.
		let lastFailureConfirmedStaleAt = false;
		// Consecutive refreshes that moved `getNextRev()` nowhere at all while a confirmed revision
		// stood at or above it.
		let consecutiveStalls = 0;
		// The revision the PREVIOUS iteration would have requested, so the stall check can tell a
		// refresh that moved nowhere from one that is still climbing toward the confirmed number.
		let previousRequestedRev: number | undefined;
		// Who holds what this sync has committed so far. Stays `undefined` while nothing has been
		// committed, which is also the answer when the loop never runs at all — a sync with nothing
		// staged writes nothing, and there is no durability to fabricate for it. Failed attempts never
		// contribute: a refused attempt left nothing behind, so the answer is the committing attempt's.
		let durability: WriteDurability | undefined;

		while (this.hasUnsyncedChanges()) {
			if (signal?.aborted) {
				throw makeAbortError(signal);
			}
			// Progress-agnostic ceiling: give up if the wall-clock deadline passed. Deliberately
			// ahead of the stall check: the deadline is the documented outer bound, so a sync that
			// is both past it and stalled reports the deadline.
			if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
				throw new SyncRetryExhaustedError(this.id, consecutiveFailures, lastReason ?? 'deadline exceeded', lastStaleAt);
			}

			// Can the attempt about to run possibly differ from the one that just failed? Only when
			// BOTH of these hold is the answer provably no:
			//
			//  - The revision it would request is at or below one a responder CONFIRMED is taken. A
			//    producer sets `staleAt` only after reading that revision as durably held by someone
			//    else out of its own storage, revisions are one per-collection counter that every
			//    commit touches, and a confirmed revision never becomes un-taken (invalidation takes
			//    a NEW slot). So the request is already lost before it is sent.
			//  - The refresh in between moved the collection nowhere. `advanceContext` never lowers
			//    the held revision, so "nowhere" is exactly `requestedRev` unchanged since the last
			//    iteration. A refresh that moved forward WITHOUT clearing the confirmed number is a
			//    collection still climbing (it read a replica that lags the holder — the same
			//    partial catch-up `reportShortfall` exists to report), and its next attempt is a
			//    genuinely different request that may yet win.
			//
			// This is NOT a second answer to "is this failure retryable?" — `isConflictFailure`
			// remains the sole rule for that, untouched. It only ever stops a loop that rule had
			// already decided to continue.
			const requestedRev = this.getNextRev();
			const refreshMoved = previousRequestedRev !== undefined && requestedRev > previousRequestedRev;
			previousRequestedRev = requestedRev;
			if (lastStaleAt !== undefined) {
				if (requestedRev > lastStaleAt.rev || refreshMoved) {
					// Either the refresh adopted a revision above the confirmed one — ordinary
					// contention, where the rival's commit is exactly what we just read — or it made
					// partial forward progress. Both mean the next attempt differs. Not a stall.
					consecutiveStalls = 0;
				} else if (lastFailureConfirmedStaleAt) {
					consecutiveStalls++;
					if (log.enabled) {
						log('collection:sync-stalled id=%s tag=%s heldRev=%s requestedRev=%d staleBlock=%s staleRev=%d strike=%d of=%d',
							this.id, this.instanceTag, this.source.actionContext?.rev ?? 'none', requestedRev,
							lastStaleAt.blockId, lastStaleAt.rev, consecutiveStalls, maxStalledAttempts);
					}
					// Two strikes, not one: a legitimate loser can transiently read a view that has
					// not yet caught up with the rival's commit, which looks identical for one round.
					if (consecutiveStalls >= maxStalledAttempts) {
						throw new SyncRevisionStalledError(this.id, consecutiveFailures, lastStaleAt,
							requestedRev, this.source.actionContext?.rev, lastReason);
					}
				}
				// Else: the responder told us nothing new this round. No strike, and no reset either
				// — the budget stays bounded by maxAttempts.
			}

			// A pending action is never pended over a base that has moved under it — before EVERY
			// attempt, first and retries alike (see restageIfBasesMoved for why the retry needs it).
			await this.restageIfBasesMoved();

			// Snapshot the pending actions so that any new actions aren't assumed to be part of this action
			const pending = [...this.pending];

			// Create a snapshot tracker for the action, so that we can ditch the log changes if we have to retry the action.
			// It SHARES the live tracker's pin store: the snapshot inherits transforms by copy and never
			// stages the data-block updates itself, so without the shared pins the digest pass below
			// could only describe bases still resident in the read cache.
			// NOTE: an attempt that ends in a stale failure is abandoned WITHOUT reset(), so the log
			// tail/header bases its append pinned stay in the shared store until the live tracker's
			// next reset. Bounded and harmless — a few log blocks per attempt, capped by maxAttempts,
			// each re-validated against the source generation before any use — but if this loop ever
			// grows a per-attempt footprint beyond the log blocks, reset the abandoned tracker on the
			// stale-failure branch instead of letting the residue ride to the end of the sync.
			const snapshot = copyTransforms(this.tracker.transforms);
			const tracker = new Tracker(this.sourceCache, snapshot, this.tracker.pins);

			// Add the action to the log (in local tracking space). The append is a fixed function of
			// this write and the revision it is requesting: the timestamp was minted once for the
			// whole write (syncInternal) and any data block the append has to mint takes the id an
			// earlier attempt at this revision already minted (logAppendBlockIds).
			const newRev = this.getNextRev();
			const collectionLog = await Log.open<Action<TAction>>(tracker, this.id,
				{ newDataBlockId: this.logAppendBlockIds(tracker, newRev) });
			if (!collectionLog) {
				throw new Error(`Log not found for collection ${this.id}`);
			}
			const addResult = await collectionLog.addActions(pending, actionId, newRev,
				() => tracker.transformedBlockIds(), { timestamp });

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
			// The base each update-only block's operations were computed against, for the pend (see
			// `PendRequest.baseRevs`): the tracker's pinned revisions, which `restageIfBasesMoved` at the
			// top of this iteration has just re-judged, so a moved base was re-staged before it is named.
			const baseRevs = tracker.stagedBaseRevs(tracker.transformedBlockIds());

			// Commit the action to the transactor. Carry the aged retry priority derived from the
			// consecutive-failure count so a sync that keeps losing concurrent races out-ranks fresh
			// (priority-0) rivals in the cluster's resolveRace (fairness-only; capped at MaxPriority).
			// First attempt has consecutiveFailures == 0, so priority 0 — the common pend is unchanged.
			const attempt = await this.source.transact(tracker.transforms, actionId, newRev, this.id, addResult.tailPath.block.header.id, clampPriority(consecutiveFailures), blockDigests, baseRevs);
			if (!attempt.success) {
				consecutiveFailures++;
				lastReason = attempt.reason ?? lastReason;
				// Highest-wins, not last-wins: the next request has to clear EVERY holder, so a later
				// responder reporting a LOWER number understates the binding constraint. Same rule the
				// producers and the transactor's aggregation already use.
				lastStaleAt = highestStaleAt([lastStaleAt, attempt.staleAt]);
				lastFailureConfirmedStaleAt = attempt.staleAt !== undefined;
				// Give up once the consecutive no-progress budget is exhausted, so a transactor that
				// persistently rejects the sync can no longer hold the collection latch forever.
				// NOTE: this also bounds the legitimate `pending`-wait case (retrying the same action
				// while another commit is in flight), which used to retry indefinitely. Default 10
				// attempts ≈ 21s of exponential backoff. If a high-contention workload legitimately
				// needs to wait longer for a pending commit to clear, raise maxAttempts for that caller.
				// NOTE: no refresh follows the LAST budgeted attempt, so if that attempt's log tail
				// landed nobody finds out: the caller gets plain exhaustion over a log that holds an
				// entry for this write. The write is still never reported saved, which is the rule; what
				// is lost is the more specific name (TornActionError). The leftover entry itself is
				// tracked in tickets/backlog/bug-a-refused-write-can-leave-its-log-entry-behind.
				if (consecutiveFailures >= maxAttempts) {
					throw new SyncRetryExhaustedError(this.id, consecutiveFailures, lastReason, lastStaleAt);
				}
				// Keep exactly what this attempt sent. A refused commit is not proof nothing landed:
				// the log tail is committed first and can be stored while the answer is still a
				// failure, and `transact` has just cancelled every block that did not land. If the
				// refresh below finds this attempt's own entry, these are the transforms that finish
				// the action (see completeOwnEntry). The snapshot tracker is abandoned after this
				// iteration, so its transforms are handed over as-is, uncopied.
				this.retainInFlightAttempt(actionId, {
					rev: newRev,
					transforms: tracker.transforms,
					tailId: addResult.tailPath.block.header.id,
					...(blockDigests === undefined ? {} : { blockDigests }),
					...baseRevsField(baseRevs),
				});
				// Refresh, and keep refreshing while it reports that this write's own half-landed
				// action could not be finished YET. It must not fall through to a new attempt in that
				// state: this action's log entry is already durable, and as soon as a refresh adopts a
				// newer revision a new attempt appends a SECOND entry under the same action id — the
				// duplicate consumeOwnEntry exists to prevent. (At an unchanged revision the rebuild
				// is byte-identical — see logAppendBlockIds — so what is at stake is the second entry,
				// not two versions of one tail block.) Each round is a failure against the same
				// no-progress budget as a refused attempt.
				for (;;) {
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
					try {
						// Fetch latest state - updateInternal() will call replayActions() if there are conflicts.
						// This sync's actionId is marked in flight for the whole cycle (see syncInternal), so
						// the refresh recognizes a log entry written by THIS action (its log tail landed but
						// the commit answered failure), FINISHES that action from the attempt retained
						// above, and only then consumes the entry rather than replaying it into a duplicate.
						// The round that would spend the last of the budget settles a half-landed write
						// instead of asking for another round, so the error that escapes below says
						// whether the write can still land. (A deadline cannot be foreseen the same
						// way; a write given up on it escapes unsettled, as `final: false`.)
						const report: RefreshReport = {};
						await this.updateInternal(report, consecutiveFailures + 1 >= maxAttempts);
						const completed = report.ownEntryFinished?.durability;
						if (completed !== undefined) {
							// The refresh made this sync's write durable: that is a commit, and it is
							// reported and counted exactly like one made by an attempt (see the success
							// branch below for why batches fold to the weakest).
							durability = durability === undefined ? completed : mergeDurability([durability, completed]);
							consecutiveFailures = 0;
							lastReason = undefined;
							lastStaleAt = undefined;
							lastFailureConfirmedStaleAt = false;
							consecutiveStalls = 0;
						}
						break;
					} catch (err) {
						if (!(err instanceof TornActionError) || err.reason !== 'completion-refused') {
							throw err;
						}
						// Refused for a cause that can clear. The error already names the write as torn,
						// which is the truth if the budget ends here — so it, not a plain exhaustion,
						// is what escapes: the log holds an entry for a write that was not saved.
						consecutiveFailures++;
						lastReason = err.detail;
						if (consecutiveFailures >= maxAttempts
							|| (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs)) {
							throw err;
						}
					}
				}
			} else {
				// This attempt's commit landed, so its durability is the one to report. A sync that
				// commits ONCE — every sync that has a caller today — reports exactly that answer,
				// untouched. A sync whose loop commits more than one batch (the `hasUnsyncedChanges`
				// condition re-entering after a successful commit) folds the batches with
				// `mergeDurability`, whose scalar answer is the WEAKEST of them: one batch that only
				// reached the writer makes the whole sync only-on-the-writer, and reporting the last
				// batch's class instead would show such a write as saved.
				durability = durability === undefined ? attempt.durability : mergeDurability([durability, attempt.durability]);
				// Forward progress: reset the no-progress budget.
				consecutiveFailures = 0;
				lastReason = undefined;
				lastStaleAt = undefined;
				lastFailureConfirmedStaleAt = false;
				consecutiveStalls = 0;
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
		return durability;
	}

	/** Refresh from the transactor, then push. Same return contract as {@link sync}: the durability of
	 * what was committed, or `undefined` when nothing was staged and so nothing was written. */
	async updateAndSync(options?: SyncOptions): Promise<WriteDurability | undefined> {
		const release = await Latches.acquire(this.latchId);
		try {
			await this.updateInternal({});
			return await this.syncInternal(options);
		} finally {
			release();
		}
	}

	/** Stage `actions` and flush them as one call that either takes effect or leaves NOTHING behind:
	 * when the flush throws, the actions this call staged are unstaged again before the error escapes.
	 *
	 * For callers that own both halves of a write (`Tree.replace`, `Diary.append`). Staging with
	 * {@link act} and flushing separately leaves a failed write's actions staged — deliberate for a
	 * caller that means to call {@link sync} again, and a trap for one that does not: the actions
	 * ride along, unasked, with its NEXT write, so a change the caller was told had failed shows up
	 * later, and a caller that reacted to the failure by submitting it again stores it twice. That
	 * is how a write reported torn was seen to "appear one write later" (the pending-record route
	 * first suspected was ruled out: with the failed writer's collection discarded, 0 of 17 torn
	 * rows ever appeared).
	 *
	 * One latch hold spans staging and flushing, so no other {@link act} on this instance can land
	 * between them and the actions to take back are exactly the ones this call put there.
	 *
	 * The error is rethrown untouched. Unstaging says nothing about storage: a
	 * {@link TornActionError} with `final: false` still means the write may be saved or may yet
	 * land, and only the staged copy is gone. */
	async actAndSync(actions: Action<TAction>[], options?: SyncOptions): Promise<WriteDurability | undefined> {
		const release = await Latches.acquire(this.latchId);
		try {
			const stagedBefore = copyTransforms(this.tracker.transforms);
			const revBefore = this.source.actionContext?.rev;
			await this.actInternal(...actions);
			try {
				await this.updateInternal({});
				return await this.syncInternal(options);
			} catch (err) {
				await this.unstage(actions, stagedBefore, revBefore);
				throw err;
			}
		} finally {
			release();
		}
	}

	/** Takes `actions` back out of the staged queue and rebuilds the tracker without them (always
	 * called under latch). `stagedBefore` / `revBefore` are the tracker's transforms and the held
	 * revision from before the actions were staged.
	 *
	 * While the held revision has not moved, the earlier transforms are reinstated verbatim rather
	 * than rebuilt by replay: an INVENTED collection keeps its header and root in the tracker with
	 * no staged action naming them, and a replay (which resets the tracker first) would drop them —
	 * the hazard {@link mustReplay} and {@link snapshotPending} document. Once the revision has
	 * moved those transforms describe blocks at a revision this handle has left, so what remains is
	 * re-staged against the adopted one, exactly as a refresh would have done. */
	private async unstage(actions: Action<TAction>[], stagedBefore: Transforms, revBefore: number | undefined): Promise<void> {
		// NOTE: matched by identity, which is what `filterAgainstEntry` promises for a kept action.
		// A `filterConflict` hook that answers a REPLACEMENT instance for one of these actions would
		// leave the replacement staged here. No collection installs such a hook today (`Tree` and
		// `Diary` install none); if one ever does, carry a per-call token on the staged actions and
		// match on that instead.
		this.pending = this.pending.filter(staged => !actions.includes(staged));
		if (this.source.actionContext?.rev === revBefore) {
			this.tracker.reset(stagedBefore);
		} else {
			await this.replayActions();
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

	/** The two blocks every refresh starts from — the collection header and the log tail block it
	 * names — read unpinned ("latest"), in ONE request when `knownTailId` is the tail the header
	 * names. Only when the header names a different tail (the known one filled, or none was known)
	 * is that tail fetched in a second request; the out-of-date block's answer is dropped rather
	 * than kept, because nothing proves it is current at the revision the refresh will pin to.
	 *
	 * Both answers pass {@link answeredBlock}'s checks as unpinned reads, header first, so a doubted
	 * header or tail throws exactly as it would through {@link TransactorSource.tryGet}.
	 *
	 * NOTE: a batched get fails as a whole when any block in it gets no answer
	 * (`NetworkTransactor.get` throws on a missing id), so an unreachable out-of-date tail fails a
	 * refresh that would not have needed it. Harmless today: the log has no checkpoints, so a
	 * refresh that finds a new tail walks back through the old one anyway. If checkpoints start
	 * letting that walk stop short, read the known tail in its own request instead.
	 *
	 * @returns undefined when the header is authoritatively absent. */
	private static async readLogEnds(transactor: ITransactor, id: CollectionId, knownTailId: BlockId | undefined): Promise<LogEnds | undefined> {
		const results = await transactor.get({ blockIds: knownTailId === undefined ? [id] : [id, knownTailId] });
		const headerEntry = results?.[id];
		if (headerEntry === undefined) {
			return undefined;
		}
		const header = answeredBlock(id, headerEntry, undefined) as CollectionHeaderBlock | undefined;
		if (!header) {
			return undefined;
		}
		const served: LogEnds['served'] = [[id, header, servedRevision(headerEntry)]];
		const tailId = header.tailId;
		if (tailId === undefined) {
			return { header, served };
		}
		const tail = tailId === knownTailId
			? Collection.checkedLogTail(tailId, results[tailId])
			: await Collection.readLogTail(transactor, tailId);
		if (tail?.block) {
			served.push([tailId, tail.block, servedRevision(tail)]);
		}
		return { header, tail, served };
	}

	/** An unpinned read of the log tail block, checked as {@link checkedLogTail} describes. */
	private static async readLogTail(transactor: ITransactor, tailId: BlockId): Promise<GetBlockResult | undefined> {
		return Collection.checkedLogTail(tailId, (await transactor.get({ blockIds: [tailId] }))?.[tailId]);
	}

	/** The repo's answer for the log tail, once it has passed {@link answeredBlock}'s unpinned-read
	 * checks. The raw entry, not just the block, is what a refresh needs — {@link bootstrapContext}
	 * reads `state.latest` off it — which is why the tail is read around {@link TransactorSource}
	 * and has to be checked here.
	 *
	 * Both checks matter at this seam in particular. A tail the repo could not retrieve must not
	 * degrade into "no context", which would leave the chain walk unable to see pending non-tail
	 * blocks and the collection reading as if they did not exist. And this unpinned tail read is
	 * the ONE seam where a lagging collection can learn a newer revision exists — every later data
	 * read is pinned to the context seeded from it — so seeding from a tail the repo could not
	 * confirm is current would freeze the collection at the stale revision with nothing ever
	 * reporting a problem. A tail with no `state.latest` and no flag is a real answer (nothing
	 * committed yet). */
	private static checkedLogTail(tailId: BlockId, entry: GetBlockResult | undefined): GetBlockResult | undefined {
		if (entry) {
			answeredBlock(tailId, entry, undefined);
		}
		return entry;
	}

	/** Bootstrap ActionContext from the committed tail block's state.
	 * Every member applies an action's tail before its other blocks (commit protocol guarantee:
	 * `StorageRepo.commit` orders the tail first and stops at the first failure), so wherever
	 * committed data of an action exists its tail does too, readable with context=undefined.
	 * Its state.latest contains the ActionRev of the most recent
	 * committed action — exactly the proof needed for the transactor to serve pending
	 * non-tail blocks during chain walks. A tail with no `latest` (or no tail) no-ops.
	 *
	 * NOTE: this number is adopted on trust, and adoption is one-way (advanceContext never
	 * lowers it). A tail that over-claims therefore pins the collection at a revision its
	 * own log can never reach, permanently: every later refresh walks the log (the claim's newest
	 * entry never matches, so {@link tailShowsNothingNewer} never lets it skip), reads the
	 * real (lower) revision, and is refused — so the instance emits
	 * `collection:context-not-lowered` forever while `collection:context-short-of-tail`
	 * stays silent (the held revision is at or above what the tail claims). No condition
	 * that makes a real tail over-claim has been demonstrated; this was seen only through a
	 * test double built to lie (see collection.spec.ts, 'a refresh that lands short of the
	 * tail it just read'). If an over-claiming tail is ever observed in the field, the fix
	 * belongs here — validate the claim against the log before pinning — not in the refresh.
	 */
	private static bootstrapContext(source: TransactorSource<IBlock>, tail: GetBlockResult | undefined): void {
		const latest = tail?.state.latest;
		if (latest) {
			source.actionContext = {
				committed: [{ actionId: latest.actionId, rev: latest.rev }],
				rev: latest.rev,
			};
		}
	}
}
