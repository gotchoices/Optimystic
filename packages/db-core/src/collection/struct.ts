import type { IBlock, BlockId, Action, ActionId, Transforms, WriteDurability } from "../index.js";
import type { IChainHeader } from "../chain/chain-nodes.js";
import type { RandFn } from "../utility/backoff.js";
import type { EntryId } from "./segments.js";
import type { AlreadyAppliedTally } from "./action.js";
import type { BlockBaseRevs, BlockContentDigests } from "../network/struct.js";

export type CollectionId = BlockId;

/**
 * A handler's statement that an action cannot be applied over the committed state it is being
 * replayed against — a uniqueness or lost-update check failed. Not a transport failure and never
 * retryable: the action's staged writes are discarded (the handler runs inside an Atomic), and
 * nothing downgrades it to a stale failure. `TreeGuardRefusedError` in
 * `packages/db-core/src/collections/tree/struct.ts` is the tree's subclass, and carries the
 * contract every refusal obeys.
 *
 * Lives here rather than beside the tree so the collection can recognise a refusal without
 * importing the tree module (which imports the collection). Segment-aware replay
 * (`Collection.replayActions`) treats a throw of this class from a SEALED segment as that
 * segment's refusal and keeps going; from the open segment it propagates as it always has.
 */
export class ActionRefusedError extends Error {
	constructor(
		/** The collection whose handler refused the action. */
		readonly collectionId: CollectionId,
		message: string,
	) {
		super(message);
		this.name = 'ActionRefusedError';
	}
}

/** Why a sealed segment stood in the way of a commit (see {@link SealedSegmentsError}):
 * - `whole-collection` — a whole-collection commit was asked for while a segment is sealed.
 * - `not-head` — `commitHead` named a segment that is not the oldest sealed one.
 * - `refused` — `commitHead` named a segment a replay has refused; the queue drops it instead.
 * - `in-flight` — a head commit is on the network for the named segment, so neither a second
 *   `commitHead` nor a `dropSealed` of it can proceed. */
export type SealedSegmentsReason = 'whole-collection' | 'not-head' | 'refused' | 'in-flight';

/**
 * Thrown by the whole-collection commit paths — {@link ICollection.sync},
 * {@link ICollection.updateAndSync}, `Collection.actAndSync` and `Collection.getPendingActions`
 * (the coordinator's append) — while the collection holds sealed segments. Those paths commit
 * everything staged as ONE log entry under one action id; over sealed segments that would merge
 * several queue entries into one, which the queue's identity rules forbid
 * (docs/offline-sync.md §Identity across attempts). A sealed segment is committed on its own,
 * through `Collection.commitHead`, whose own preconditions throw this class too, with a
 * {@link reason} other than `whole-collection` (see {@link SealedSegmentsReason}).
 *
 * Nothing is unstaged or changed when this is thrown: every segment, sealed and open, is exactly
 * as it was.
 */
export class SealedSegmentsError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		/** The sealed segments' entry ids, in order. */
		readonly sealedEntries: EntryId[],
		readonly reason: SealedSegmentsReason = 'whole-collection',
		/** The entry a `commitHead` or `dropSealed` named, for every reason but `whole-collection`. */
		readonly entryId?: EntryId,
	) {
		super(sealedSegmentsMessage(collectionId, sealedEntries, reason, entryId));
		this.name = 'SealedSegmentsError';
	}
}

function sealedSegmentsMessage(collectionId: CollectionId, sealedEntries: EntryId[], reason: SealedSegmentsReason, entryId: EntryId | undefined): string {
	const listed = sealedEntries.length === 0 ? 'nothing' : sealedEntries.join(', ');
	switch (reason) {
		case 'whole-collection':
			return `collection ${collectionId} holds sealed segment(s) ${listed}; `
				+ `a whole-collection commit would merge them into one log entry — commit the head segment instead`;
		case 'not-head':
			return `collection ${collectionId}: entry ${entryId} is not the head sealed segment (sealed: ${listed}); `
				+ `only the oldest sealed segment can be committed`;
		case 'refused':
			return `collection ${collectionId}: entry ${entryId} carries a recorded refusal; `
				+ `a refused segment is dropped, never committed`;
		case 'in-flight':
			return `collection ${collectionId}: a head commit of entry ${entryId} is in flight on this instance`;
	}
}

/** Exactly what one write attempt sent to the transactor — enough to send the same thing again.
 * Retained by `Collection.retainInFlightAttempt` so that a refresh which then finds this attempt's
 * own log entry can land the blocks the attempt left behind, at the same action id and revision
 * (see `Collection.completeOwnEntry`).
 *
 * Also the shape a caller RECORDS before an attempt is sent and hands back on a later cycle
 * ({@link HeadCommitOptions.recordAttempt} and {@link HeadCommitOptions.resume};
 * docs/offline-sync.md §Identity across attempts), so it must stay plain data — ids, numbers and the
 * transforms as the wire carries them, nothing with object identity and no functions: the
 * offline-sync journal serialises it as JSON. */
export type InFlightAttempt = {
	/** The action id the attempt was sent under — the one every attempt of the write reuses, and
	 * the one a cycle that resumes from this record must run under. */
	actionId: ActionId;
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

/** What `Collection.commitHead` commits the head segment under, beside the retry bounds of
 * {@link SyncOptions}. Both fields are the queue's (docs/offline-sync.md §Identity across
 * attempts): the collection mints neither. */
export type HeadCommitOptions = SyncOptions & {
	/** The action id the attempt cycle runs under. The queue mints it, and re-supplies the SAME id
	 * when it re-drives an entry whose earlier attempt may have landed, so the refresh that opens the
	 * cycle recognises that attempt's log entry as the write's own and finishes or consumes it
	 * instead of committing a second copy. */
	actionId: ActionId;
	/** The entry's local commit time, stamped on the log entry in place of the time
	 * `Collection.syncInternal` mints for a sync. Fixed per write, so every attempt appends the same
	 * entry (see "A write's log append is a fixed function of the write and the revision it is
	 * requesting" in docs/internals.md). */
	timestamp: number;
	/** The write-ahead hook: called with each attempt exactly as it is about to be sent — after it is
	 * built and BEFORE the collection latch is released for the network — and awaited under that
	 * latch. It is where the queue records the attempt's identity before sending it
	 * (docs/offline-sync.md §Identity across attempts) and, later, where the journal writes it. A
	 * throw aborts the cycle before anything is sent: it escapes `commitHead` unchanged, the handle
	 * closes, and every segment is exactly as it was. */
	recordAttempt?: (attempt: InFlightAttempt) => Promise<void>;
	/** The attempt an earlier cycle under the SAME `actionId` handed to `recordAttempt` and did not
	 * resolve — it must carry this `actionId`, and `openHeadCommit` throws before touching anything
	 * when it does not. Seeded as the retained attempt right after the action is marked in flight,
	 * so the cycle's opening refresh, finding that attempt's log entry with blocks missing, finishes
	 * it from these transforms (`Collection.completeOwnEntry`) instead of refusing it as torn with
	 * `transforms-not-held`. Without it a re-drive can recognise only an attempt that landed whole.
	 * The revision check still applies: an attempt recorded at a revision other than the entry's is
	 * refused as before. And when that refresh finds nothing new, this attempt is what the cycle
	 * re-sends, verbatim, while the next attempt would request its revision (`resumedAttempt`), since
	 * it may have landed on machines the refresh did not hear from. */
	resume?: InFlightAttempt;
	/** Called once, with what the head segment's actions accepted as already applied
	 * ({@link AlreadyAppliedTally}, as recorded on the segment by its last staging over the committed
	 * state), at the moment the segment is made durable and dropped: when the committed attempt is
	 * folded (`HeadCommitHandle.fold`), or when the cycle's refresh finds the entry's own log entry and
	 * consumes the head (`Collection.consumeHead`) — so a re-drive that finds its earlier attempt landed
	 * reports it too. Runs synchronously under the collection latch, like `onSealedRefused`, so it must
	 * not call a latched method of the collection; the queue's closure only records into a map. A throw
	 * out of it is logged, never raised: the commit is already durable. A hook rather than a widened
	 * return type because the partial-commit path reports the committed half through
	 * `CoordinatorPartialCommitError` and the refresh-consumed path through `RefreshReport`; one hook
	 * reaches all three. */
	onCommittedHead?: (applied: AlreadyAppliedTally) => void;
};

export type CollectionHeaderBlock = IBlock & Partial<IChainHeader>;

/** A collection's committed tail: the log tail block its header names, and that block's latest
 * committed revision, which is the collection's (every commit touches the log tail). */
export type CommittedTail = { tailId: BlockId; rev: number };

/** One collection a batched committed-tail read names (`Collection.readCommittedTails`). */
export type CommittedTailQuery = {
	readonly id: CollectionId;
	/** The tail block the caller's previous read found. While the header still names it, the read
	 * needs no second request for this collection. */
	readonly knownTailId?: BlockId;
};

/** How a batched committed-tail read (`Collection.readCommittedTails`) asks. */
export type CommittedTailReadOptions = {
	/** Ask every answering repo not to start the background read-repair consult its lazy window would
	 * run behind the read (`BlockGets.skipWindowConsult`) — for a poll that only wants what is held. */
	readonly skipWindowConsult?: boolean;
};

/** One collection's answer to a batched committed-tail read: its tail (`undefined` when it has
 * never committed), or why reading it failed — what the single-collection read would have thrown. */
export type CommittedTailAnswer =
	| { readonly tail: CommittedTail | undefined }
	| { readonly error: unknown };

/** Bounds the retry loop inside {@link ICollection.sync} / {@link ICollection.updateAndSync}
 * so a transactor that keeps rejecting the sync can no longer spin the collection latch forever.
 * All fields are optional; unset fields fall back to conservative defaults. */
export interface SyncOptions {
	/** Max consecutive stale-failure retries that make no progress before giving up.
	 * The counter resets to 0 on every successful commit, so a legitimate large multi-batch
	 * sync (which iterates many times making forward progress) is never falsely tripped.
	 * Default 10. */
	maxAttempts?: number;
	/** Optional wall-clock deadline in ms measured from the start of the sync call. Independent
	 * of the attempt count — a progress-agnostic ceiling. Unset means no deadline. */
	deadlineMs?: number;
	/** Base backoff delay in ms applied before the first retry; subsequent retries grow the delay
	 * exponentially up to {@link maxBackoffMs}. Default 100. Not applied once `SlotHoldAfterLosses` of the
	 * write's refused attempts carried a confirmed committed revision (`StaleFailure.staleAt`) and the
	 * latest refusal is one of them: a member then holds the next slot for this write,
	 * and the retry follows at once rather than spending the hold asleep. */
	baseBackoffMs?: number;
	/** Upper bound on any single backoff sleep, in ms. Default 5000. Like {@link baseBackoffMs}, not
	 * applied to a retry that follows at once because a member holds the slot for this write. */
	maxBackoffMs?: number;
	/** Optional abort signal. Checked at the top of each loop iteration and raced against the
	 * backoff sleep, so an aborted sync rejects promptly (with an AbortError) rather than finishing
	 * the current sleep. */
	signal?: AbortSignal;
	/** Advanced/testing hook: source of uniform [0,1) randomness for the backoff jitter. Defaults to
	 * the package CSPRNG; inject a deterministic sequence to assert exact retry delays. */
	rand?: RandFn;
	/** Consecutive refreshes that move this collection's revision NOWHERE while a responder has
	 * CONFIRMED a revision at or above the one the next attempt would request, before sync gives up
	 * with {@link SyncRevisionStalledError}. Such a retry provably re-sends the identical, already
	 * lost request, so the wait buys nothing. Two absorbs one transiently-lagging read; set it to
	 * {@link maxAttempts} or higher to restore the pre-existing behaviour of burning the whole
	 * budget. Default 2.
	 *
	 * Neither shape of progress trips this. Ordinary contention: the rival's commit is what the
	 * refresh adopts, so the next request lands above the confirmed revision. A collection still
	 * catching up: the refresh moves the revision forward without yet clearing the confirmed
	 * number, so the next request differs from the one that just failed. Either resets the counter.
	 * {@link deadlineMs} is still checked first, so a sync that is both past its deadline and
	 * stalled reports the deadline (as {@link SyncRetryExhaustedError}), not the stall. */
	maxStalledAttempts?: number;
	/** Refuse to let this write be committed by a lone node — a coordinator whose cohort for the
	 * write is only itself — while that node knows of members of the cohort it could not reach, is
	 * still waiting to hear from a peer it was configured to join through, or could not route the
	 * write at all. A node that is genuinely alone (no absent member known, nothing awaited, routed to
	 * itself) still commits. The refusal is a promise shortfall (`PromiseShortfallError`, with
	 * `soloRefused` naming the reason), so the write stops and is classified `cohort-unreachable`.
	 * Rides on every send of the write's attempt cycle as `PendRequest.refuseSolo` and
	 * `CommitRequest.refuseSolo`. Default off: only the offline queue sets it (docs/offline-sync.md
	 * §When to submit: the reachability gate). A coordinator on a build that predates the field
	 * ignores it and commits alone as before. */
	refuseSoloCommit?: boolean;
}

/** What a write's attempt cycle carries besides its identity, recorded beside the in-flight mark
 * (`Collection.beginInFlightAction`) so that every send of the cycle carries it: each attempt, and
 * the re-send a refresh makes to finish a torn one (`Collection.completeOwnEntry`). */
export type InFlightCycle = {
	/** {@link SyncOptions.refuseSoloCommit}, for this cycle. */
	readonly refuseSolo?: boolean;
};

/** What `Collection.openHeadCommit` opens a head commit with besides its identity: the cycle's
 * {@link InFlightCycle}, the attempt an earlier cycle under the same action id recorded and did not
 * resolve ({@link HeadCommitOptions.resume}), and the committed-head hook
 * ({@link HeadCommitOptions.onCommittedHead}). */
export type OpenHeadCommitOptions = InFlightCycle & {
	readonly resume?: InFlightAttempt;
	readonly onCommittedHead?: (applied: AlreadyAppliedTally) => void;
};

/** Thrown by {@link ICollection.sync} / {@link ICollection.updateAndSync} when the retry budget
 * (attempt count or deadline) is exhausted while the transactor keeps returning stale failures.
 * Catchable so callers can surface a clear "gave up syncing" condition instead of hanging.
 *
 * It says the write was NOT SAVED; it does not prove nothing was stored. A write's log tail is
 * committed before its other blocks, and the attempt that spent the budget is not followed by a
 * refresh, so that attempt's log entry may be standing in the log with none of its data — the state
 * {@link TornActionError} names when a refresh does get to see it. */
export class SyncRetryExhaustedError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		readonly attempts: number,
		readonly lastReason?: string,
		/** The last confirmed revision a responder reported holding, if any responder reported one
		 * (see `StaleFailure.staleAt`). Absent whenever no rejection carried a confirmed number —
		 * which is normal, not a signal that the failure was something other than a lost race. */
		readonly staleAt?: { blockId: BlockId; rev: number },
	) {
		super(`sync for collection ${collectionId} exhausted ${attempts} retries` +
			(lastReason ? `: ${lastReason}` : '') +
			(staleAt ? `, last seen block ${staleAt.blockId} at rev ${staleAt.rev}` : ''));
		this.name = 'SyncRetryExhaustedError';
	}
}

/** Thrown by {@link ICollection.sync} / {@link ICollection.updateAndSync} when refreshing
 * repeatedly moved this collection nowhere at all while a responder confirmed a revision at or
 * above the one being requested — the client's view of the current revision disagrees with the
 * cluster's, and retrying would re-send the identical taken number.
 *
 * The distinction matters because the two failures need different responses. Plain exhaustion
 * means "I lost a race too many times", and waiting longer or retrying later can succeed. This
 * one means the next attempt is provably identical to the one that just failed, so the remaining
 * budget buys nothing — the caller's view of the collection has to be repaired first.
 *
 * Sync deliberately does NOT adopt the responder's revision to get past this. `staleAt` is a bare
 * number, not content: submitting this client's staged transforms at a revision built on a
 * history it never read would overwrite that history silently. Reconciling a genuine fork is
 * partition healing's job (docs/transactions.md), not the retry loop's.
 *
 * Extends {@link SyncRetryExhaustedError} so existing callers that catch the base class keep
 * working; catch this subclass to distinguish "my revision view is wrong" from "I lost a race
 * too many times". */
export class SyncRevisionStalledError extends SyncRetryExhaustedError {
	/** Required here, unlike on the base class — it is the evidence the stall is based on. */
	declare readonly staleAt: { blockId: BlockId; rev: number };

	constructor(
		collectionId: CollectionId,
		attempts: number,
		staleAt: { blockId: BlockId; rev: number },
		/** The revision the next attempt would have requested. */
		readonly requestedRev: number,
		/** The revision this client believes is current. `undefined` for a collection that has
		 * committed nothing. */
		readonly heldRev: number | undefined,
		lastReason?: string,
	) {
		super(collectionId, attempts, lastReason, staleAt);
		// The base class's "exhausted N retries" wording is deliberately NOT reused: it reads as
		// ordinary contention, which is exactly the misdiagnosis this class exists to prevent.
		this.message = `sync for collection ${collectionId} stopped after ${attempts} attempts: `
			+ `this client holds rev ${heldRev ?? 'none'} and would request rev ${requestedRev}, `
			+ `but block ${staleAt.blockId} is confirmed committed at rev ${staleAt.rev} and `
			+ `refreshing did not close the gap`
			+ (lastReason ? `: ${lastReason}` : '');
		this.name = 'SyncRevisionStalledError';
	}
}

/** Why a half-landed write could not be finished (see {@link TornActionError}). This is the CAUSE
 * of giving up; whether the write is then definitely not saved is a separate fact, carried by
 * {@link TornActionError.final} — every reason can arrive with either value.
 *
 * - `rival-holds-revision` — finishing was refused because a DIFFERENT action holds a revision past
 *   the one the write needed on some block. That alone does NOT mean the write is lost: a later
 *   revision is often built ON the write (a rival that read it and added to it), and a write every
 *   block of which was built upon is reported SAVED, never by this error. It is raised only once
 *   the blocks' own history was asked (`ITransactor.getLineage`) and did not vouch for every block.
 * - `completion-refused` — finishing was attempted and refused for a cause that can clear on its
 *   own (another write in flight on the block, the revision not yet held by a majority). The write
 *   paths retry this inside their own budget, so seeing it means that budget ran out.
 * - `transforms-not-held` — the write's own log entry was found with blocks still missing, but this
 *   collection no longer holds the transforms that would finish them. */
export type TornActionReason = 'rival-holds-revision' | 'completion-refused' | 'transforms-not-held';

/** Thrown when a write HALF-LANDED and was not finished: its log entry is stored, but at least one
 * of the other blocks that entry names is not known to hold the write.
 *
 * A write's log tail is committed before the rest of its blocks, so a write can be refused AFTER the
 * tail was stored (see `NetworkTransactor.commit`). The writer's retry then finds its own log entry.
 * That entry proves only that the tail landed; the write is saved only once EVERY block the entry
 * names holds the write — at the write's own revision, or at a later revision that was built from
 * it — so the retry finishes the remaining blocks at the same action id and revision (see
 * `Collection.completeOwnEntry`). This error is what it raises when it could not — {@link reason}
 * says why, and {@link final} says what that leaves the caller able to do.
 *
 * **{@link final} is the field to act on.** An application's only safe reaction to a failed write
 * is to submit it again, and that is only safe when the first one can never show up:
 *
 * - `final: true` — the write is NOT saved and never will be. Every block it still needed answered
 *   for its whole cohort that it does not hold the write (its history passed the write's revision
 *   without it, or it never reached that revision), and the write's pending records were confirmed
 *   cancelled first, so nothing is left that could land it. Submitting the same change again stores
 *   it once.
 * - `final: false` — that could NOT be established. The write may already be saved, or may still
 *   land (a block's cohort did not all answer, members contradicted each other, fewer than a
 *   majority hold it, or the cancel could not be confirmed). Submitting again can store the change
 *   twice; read the data back first.
 *
 * It is deliberately not a {@link SyncRetryExhaustedError}: that error says the write never landed,
 * whereas here the log already holds an entry for it. Finishing needs the original action id and
 * the transforms it sent, and both are gone once this escapes. Re-driving under a NEW revision
 * records the same actions in the log twice, so nothing here does that on the caller's behalf. The
 * staged actions are left in place on the collection, so at this level "submit again" is calling
 * `sync()` again, and abandoning the write is the caller's to do (`Collection.restorePending`).
 * `Tree.replace` and `Diary.append` do abandon it — they own both the staging and the flush, and a
 * failed call that left its action staged would ride along, unasked, with the caller's next write.
 *
 * Raised out of {@link ICollection.sync} / {@link ICollection.updateAndSync}, and out of the
 * refresh `TransactionCoordinator.commit` runs between attempts (`Collection.refreshInFlight`).
 * The coordinator passes it on bare only when no other participant of the commit is saved; when
 * one is, it arrives as the `reason` of a `CoordinatorPartialCommitError` that names the saved
 * participants. */
export class TornActionError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		/** The half-landed write's action id. */
		readonly actionId: string,
		/** The revision its log entry landed at — the revision every block it names had to take. */
		readonly rev: number,
		/** The blocks the entry names that are not known to hold the write. */
		readonly blockIds: BlockId[],
		/** Why finishing failed — see {@link TornActionReason}. Says nothing about {@link final}. */
		readonly reason: TornActionReason,
		/** Whether the write is definitely not saved and can never land — see the class comment.
		 * `false` means "not established", never "it landed". */
		readonly final: boolean,
		/** The refusal in the responder's own words, for a log line. Never branch on it. */
		readonly detail: string,
		/** The confirmed revision a responder reported holding under ANOTHER action, when the refusal
		 * carried one (see `StaleFailure.staleAt`). */
		readonly staleAt?: { blockId: BlockId; rev: number },
	) {
		super(`collection ${collectionId}: action ${actionId} is torn at rev ${rev} — its log entry is stored `
			+ `but block(s) ${blockIds.join(', ') || '(unknown)'} are not known to hold it, and the write cannot be `
			+ `finished: ${detail}`
			+ (staleAt ? ` (block ${staleAt.blockId} is at rev ${staleAt.rev})` : '')
			+ (final
				? ' — the write is not saved and cannot land; it is safe to submit again'
				: ' — whether the write is saved could not be established; it may be saved already or land later'));
		this.name = 'TornActionError';
	}
}

/** Thrown when a collection that already holds a committed revision reads its own header
 * block as authoritatively absent.
 *
 * The two facts contradict each other: this client has proof that something was committed
 * under this id (it holds the revision it committed at, or the one it read off the log tail),
 * and storage has just answered that nothing ever was. Exactly one of them is wrong, so this
 * is a fault rather than an absence — the same reasoning `Collection.attachToLog` applies to a
 * header that probes fine but whose log will not open.
 *
 * Deliberately NOT a `StaleFailure`: {@link ICollection.sync}'s retry loop only absorbs
 * returned stale failures, so throwing this aborts the sync immediately with a named
 * diagnosis instead of letting it spin the full retry budget re-requesting a revision it
 * has silently forgotten.
 *
 * NOTE: durable invalidation restores reverted content to its as-if-absent state, so once the
 * cascade runs end-to-end (docs/right-is-right.md § Durable Invalidation), reverting the commit
 * that CREATED a collection would make its header legitimately absent for a client still holding
 * that revision — a reversal, not a contradiction, which this message would misdiagnose.
 * Aborting is still the right action there; if it ever fires for that reason, distinguish the
 * two by checking the log for an invalidation of the held revision before wording the error. */
export class CollectionHeaderVanishedError extends Error {
	constructor(
		readonly collectionId: CollectionId,
		/** The committed revision this collection held when the header read came back absent. */
		readonly heldRev: number,
	) {
		super(`collection ${collectionId} holds committed revision ${heldRev}, but its header block `
			+ `read as absent — storage reported that nothing was ever committed under this id`);
		this.name = 'CollectionHeaderVanishedError';
	}
}

export interface ICollection<TAction> {
	readonly id: CollectionId;
	act(...actions: Action<TAction>[]): Promise<void>;
	update(): Promise<void>;
	/** Push staged changes. Resolves to who holds what was committed, or `undefined` when NOTHING WAS
	 * WRITTEN — nothing was staged, so there was no pend and no commit and there is no durability to
	 * report. A write that never landed throws ({@link SyncRetryExhaustedError}) rather than returning
	 * a class. Decide "is this saved" with `isFullyDurable`, never by comparing `quorum`. */
	sync(options?: SyncOptions): Promise<WriteDurability | undefined>;
	/** Refresh, then {@link sync}. Same return contract. */
	updateAndSync(options?: SyncOptions): Promise<WriteDurability | undefined>;
	selectLog(forward?: boolean): AsyncIterableIterator<Action<TAction>>;
}

export type CreateCollectionAction = Action<void> & {
	type: "create";
};
