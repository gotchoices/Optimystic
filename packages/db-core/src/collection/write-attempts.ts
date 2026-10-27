import type { IBlock, BlockId, Action, ActionId, BlockContentDigests, BlockStore, Transforms, WriteDurability, WriteFailure } from "../index.js";
import type { BlockBaseRevs } from "../network/struct.js";
import { Log } from "../log/log.js";
import { Tracker } from "../transform/tracker.js";
import type { BasePins } from "../transform/base-pins.js";
import type { CacheSource } from "../transform/cache-source.js";
import { copyTransforms } from "../transform/helpers.js";
import { describeTouchedBlocks, baseRevsField } from "../transform/digest.js";
import { oversizedBlock } from "../network/block-size.js";
import { mergeDurability } from "../network/durability.js";
import { highestStaleAt, isExpiryFailure, isRejectedFailure, isShortfallFailure } from "../network/stale-failure.js";
import { TransactionExpiredError } from "../network/transaction-expired-error.js";
import { PromiseShortfallError } from "../network/promise-shortfall-error.js";
import { ValidityRejectedError } from "../network/validity-rejected-error.js";
import { SyncRetryExhaustedError, SyncRevisionStalledError, TornActionError } from "./struct.js";
import type { CollectionId, InFlightAttempt, SyncOptions } from "./struct.js";
import type { RefreshReport } from "./collection.js";
import { clampPriority, SlotHoldAfterLosses } from "../transaction/transaction.js";
import { jitteredBackoffMs, abortableDelay, makeAbortError } from "../utility/backoff.js";
import type { JitteredBackoffConfig, RandFn } from "../utility/backoff.js";
import { createLogger } from "../logger.js";

/**
 * The attempt machinery a collection's two write paths share — `Collection.syncAttempts`, which
 * commits the open segment, and `Collection.commitHead`, which commits the head sealed segment
 * (docs/offline-sync.md §One entry, one network transaction). Each path decides WHAT an attempt
 * sends and what to do with a commit; everything about HOW an attempt is built and accounted for
 * is here, so the two cannot drift: the per-attempt tracker and log append
 * ({@link stageAttempt}), the retained attempt a refresh may finish from
 * ({@link retainedAttempt}), and the retry accounting with its stall check and its
 * refresh-until-settled loop ({@link AttemptCycle}). The rules each step enforces are spelled out
 * in docs/internals.md under *Key Invariants* ("The writer's retry finishes its own half-landed
 * action", "A write's log append is a fixed function of the write and the revision it is
 * requesting", "Monotonicity is also what makes a wedged view detectable").
 */

const log = createLogger('collection');

/** Default base backoff (and historical fixed delay) between write retries, in ms. */
const PendingRetryDelayMs = 100;
/** Default max consecutive no-progress stale-failure retries before a write gives up. */
const DefaultMaxAttempts = 10;
/** Default ceiling on a single exponential-backoff sleep, in ms. */
const DefaultMaxBackoffMs = 5000;
/** Default consecutive stalled refreshes — ones that moved this collection's revision NOWHERE
 * while a responder CONFIRMED a revision at or above the one being requested — before a write
 * gives up. Two, not one, so a single transiently-lagging read is absorbed.
 *
 * NOTE: two is a judgement call, not a measurement — nothing here counts how often a legitimate
 * loser reads a view that moves nowhere for two consecutive rounds. The check only strikes when the
 * refresh made NO progress at all, so a client merely catching up is already excluded; if a
 * spurious `SyncRevisionStalledError` ever shows up under real contention anyway, raise this. */
const DefaultMaxStalledAttempts = 2;

/**
 * The sleep before the refresh that follows a write's `failures`-th consecutive loss.
 *
 * The jittered backoff exists to separate a herd of writers that lost the SAME race, so they do not
 * re-collide on the next tick. A loss to a rival that had already committed (the refusal carried a
 * confirmed `staleAt`) is not a herd, and once this write has taken `SlotHoldAfterLosses` such losses
 * (`confirmedLosses`, counted over the whole write as a member counts its stale refusals of one
 * action) the members that refused it hold the next slot for it — so sleeping only spends that hold.
 * Both sides count the same refusals against the same constant, so the writer stops sleeping on the
 * loss after which a member holds, with nothing said over the wire. A loss the latest refusal did not
 * confirm (`latestConfirmed` false — a race against something still in flight) keeps the jitter.
 *
 * NOTE: against members that do not hold (an earlier release, `slotHoldWindowMs: 0`, or a member the
 * refused pends did not reach) this retries without sleeping and so spends the same attempt budget
 * sooner, at about twice one writer's pend rate (measured in the plan stage of
 * `slot-hold-for-an-aged-writer`). Accepted: the backoff bought that writer nothing either, it only
 * delayed the same give-up.
 */
function retryBackoffMs(failures: number, confirmedLosses: number, latestConfirmed: boolean,
	config: JitteredBackoffConfig, rand?: RandFn): number {
	if (latestConfirmed && confirmedLosses >= SlotHoldAfterLosses) {
		return 0;
	}
	return jitteredBackoffMs(failures - 1, config, rand);
}

/** What a write is identified as on the wire: the action id every attempt of it reuses, and the
 * log entry's timestamp. Both are minted once per WRITE, never per attempt, so a retry at the same
 * revision appends the same entry (docs/internals.md, "A write's log append is a fixed function of
 * the write and the revision it is requesting"). */
export type WriteIdentity = {
	readonly actionId: ActionId;
	readonly timestamp: number;
};

/** What one attempt is built from: the actions its log entry records, the transforms they produced
 * over the committed state, and the bases those transforms were computed against. For a sync these
 * are the open segment and the live tracker's; for a head commit the head segment and the head
 * tracker's (see `Collection.commitHead`). */
export type AttemptTarget<TAction> = {
	readonly actions: readonly Action<TAction>[];
	readonly transforms: Transforms;
	readonly pins: BasePins;
};

/** One attempt as it goes on the wire: a per-attempt tracker holding the target's transforms plus
 * the log append, the revision it requests, and the declarations the pend and commit carry. */
export type StagedAttempt = {
	readonly tracker: Tracker<IBlock>;
	readonly rev: number;
	/** The log tail block the entry was appended to, committed first. */
	readonly tailId: BlockId;
	readonly blockDigests: BlockContentDigests | undefined;
	readonly baseRevs: BlockBaseRevs;
};

/**
 * Build one attempt: a tracker seeded with a COPY of the target's transforms, so the target is
 * untouched whatever becomes of the attempt, with the log entry for `target.actions` appended at
 * `rev` under `identity`, then the content declarations and the size check.
 *
 * The per-attempt tracker SHARES the target's pin store: it inherits the transforms by copy and
 * never stages the data-block updates itself, so without the shared pins the digest pass could only
 * describe bases still resident in the read cache. NOTE: an attempt that ends in a stale failure is
 * abandoned WITHOUT reset(), so the log tail/header bases its append pinned stay in the shared
 * store until the target tracker's next reset. Bounded and harmless — a few log blocks per
 * attempt, capped by `maxAttempts`, each re-validated against the source generation before any use
 * — but if an attempt ever grows a per-attempt footprint beyond the log blocks, reset the abandoned
 * tracker on the stale-failure branch instead of letting the residue ride to the end of the write.
 *
 * The append is a fixed function of the write and `rev`: the timestamp is the identity's, and any
 * data block the append has to mint takes the id `newDataBlockId` hands out — the caller's
 * `Collection.logAppendBlockIds`, which replays the ids an earlier attempt at this revision minted.
 *
 * The declarations are computed AFTER the append so the log tail and header transforms the attempt
 * just staged are digested too, and purely locally — an id whose base is not cached is omitted and
 * falls back to corroboration on the member side. NOTE: recomputed from scratch on every attempt,
 * so a write that loses N races pays N full hashing passes over its touched blocks. Unmeasured and
 * cheap relative to the round trips it is retrying; if a high-contention write ever shows digest
 * hashing in a profile, memoize per (id, staged ops).
 *
 * @throws BlockTooLargeError when a touched block would be left larger than one message can carry —
 * before anything is sent, judged apart from the declaration (which never throws), and unretried by
 * either write path, since a later attempt would leave the same block. */
export async function stageAttempt<TAction>(
	collectionId: CollectionId,
	cache: CacheSource<IBlock>,
	target: AttemptTarget<TAction>,
	identity: WriteIdentity,
	rev: number,
	newDataBlockId: (store: BlockStore<IBlock>) => () => BlockId,
): Promise<StagedAttempt> {
	const tracker = new Tracker(cache, copyTransforms(target.transforms), target.pins);
	const collectionLog = await Log.open<Action<TAction>>(tracker, collectionId, { newDataBlockId: newDataBlockId(tracker) });
	if (!collectionLog) {
		throw new Error(`Log not found for collection ${collectionId}`);
	}
	const added = await collectionLog.addActions([...target.actions], identity.actionId, rev,
		() => tracker.transformedBlockIds(), { timestamp: identity.timestamp });
	const touched = await describeTouchedBlocks(tracker, tracker.transformedBlockIds());
	const tooLarge = oversizedBlock(touched.bytes);
	if (tooLarge) throw tooLarge;
	return {
		tracker,
		rev,
		tailId: added.tailPath.block.header.id,
		blockDigests: touched.digests,
		// The base each update-only block's operations were computed against, for the pend (see
		// `PendRequest.baseRevs`): the pinned revisions, which the caller re-judged before staging.
		baseRevs: tracker.stagedBaseRevs(tracker.transformedBlockIds()),
	};
}

/** Exactly what an attempt sends under `actionId`, for `Collection.retainInFlightAttempt` and for
 * the write-ahead hook (`HeadCommitOptions.recordAttempt`): a refused commit is not proof nothing
 * landed, and if the refresh that follows finds the attempt's own log entry these are the
 * transforms that finish the action. The attempt's tracker is abandoned once this is taken, so its
 * transforms are handed over as they are, uncopied.
 * NOTE: the same object reaches the write-ahead hook and is retained for the re-send; nothing in
 * the tree mutates it (a fold clones the inserts and applies the updates to the cache's own blocks),
 * but a hook that mutated its argument would corrupt the re-send. If a hook ever needs to, copy
 * here (`copyTransforms`) rather than at the hook. */
export function retainedAttempt(staged: StagedAttempt, actionId: ActionId): InFlightAttempt {
	return {
		actionId,
		rev: staged.rev,
		transforms: staged.tracker.transforms,
		tailId: staged.tailId,
		...(staged.blockDigests === undefined ? {} : { blockDigests: staged.blockDigests }),
		...baseRevsField(staged.baseRevs),
	};
}

/**
 * The inverse of {@link retainedAttempt}, for a head commit opened with `resume`
 * (`HeadCommitOptions.resume`): the attempt an earlier cycle recorded, as a {@link StagedAttempt}
 * that sends exactly what that cycle sent, while `rev` — the revision the next attempt would
 * request — equals the recorded one; `undefined` otherwise, and the attempt is built as usual.
 * The tracker is over the handle's read cache, with a COPY of the recorded transforms (a fold
 * resets it and folds what it holds, and the record stays the caller's) and pins of its own, since
 * it stages nothing.
 *
 * The recorded attempt IS the attempt that may have landed: it can sit on a minority of its cohort,
 * hidden from the refresh by a coordinator lagging that cohort, and storage accepts a retry of one
 * `(action id, revision)` as the same write, so anything but these transforms under that pair forks
 * the block on the machines that hold the first (docs/offline-sync.md §Identity across attempts).
 * Three departures from how an attempt is otherwise built are deliberate:
 * - **Keyed on `resume`, not on the retained attempt.** Within one cycle a retry at an unchanged
 *   revision reuses the head tracker and the minted log block ids, so it is byte-identical already,
 *   and keeps the re-judging of its base pins before each attempt (`Collection.headTrackerFor`).
 *   The recorded attempt is re-sent as it was, unjudged: a base that moved under it is judged by
 *   storage's own base guard, which refuses it on every machine whose base moved — the exception
 *   `Collection.completeOwnEntry`'s re-send of a retained attempt already takes.
 * - **No invented baseline.** A head tracker over a collection with no committed revision starts
 *   from the invented baseline so the header, log block and root ride in the head's commit; the
 *   recorded transforms already carry those inserts.
 * - **Only equality switches it on.** A refresh that moves the revision past `attempt.rev` adopted a
 *   rival's entry there, which proves the recorded attempt lost at that revision, and the write is
 *   rebuilt at the higher one. A revision BELOW it is not reachable inside one process (the held
 *   revision never lowers); a new handle after a restart that reaches one has read a view behind the
 *   attempt, and the ordinary build handles it as it would without `resume` — the recorded revision
 *   is not adopted to get there.
 */
export function resumedAttempt(cache: CacheSource<IBlock>, attempt: InFlightAttempt | undefined, rev: number): StagedAttempt | undefined {
	if (attempt === undefined || attempt.rev !== rev) {
		return undefined;
	}
	return {
		tracker: new Tracker(cache, copyTransforms(attempt.transforms)),
		rev: attempt.rev,
		tailId: attempt.tailId,
		blockDigests: attempt.blockDigests,
		baseRevs: attempt.baseRevs ?? {},
	};
}

/** The refresh a write path runs between attempts — `Collection.updateInternal`, under the
 * collection latch, with the write's action marked in flight so the refresh recognises the write's
 * own log entry. `lastChance` says the budget ends with this round; `tailFloor` is the highest
 * revision a responder confirmed is taken, for the tail read. */
export type Refresh = (report: RefreshReport, lastChance: boolean, tailFloor: number | undefined) => Promise<void>;

/**
 * The retry accounting of one write's attempt cycle: how many consecutive attempts have been
 * refused, what the responders confirmed, whether the refresh in between moved the collection, and
 * who holds what the write has committed so far. One instance per write; the write path drives it
 * in order — {@link beforeAttempt}, then either {@link recordRefusal} followed by
 * {@link refreshUntilSettled}, or {@link recordCommit}.
 */
export class AttemptCycle {
	private readonly maxAttempts: number;
	private readonly maxStalledAttempts: number;
	private readonly backoff: JitteredBackoffConfig;
	private readonly deadlineMs: number | undefined;
	private readonly signal: AbortSignal | undefined;
	private readonly rand: RandFn | undefined;
	private readonly startedAt = Date.now();

	// Count of consecutive stale failures that made no forward progress. Reset to 0 on every
	// commit, so the cap bounds only a persistently-failing write — a legitimate large multi-batch
	// sync (which iterates many times committing progress) never trips it.
	private consecutiveFailures = 0;
	private lastReason: string | undefined;
	// Highest confirmed revision any responder has reported holding, accumulated with the
	// codebase's single rule for picking among several candidates. Reported on the error, and
	// the evidence the stall check reasons from.
	private lastStaleAt: { blockId: BlockId; rev: number } | undefined;
	// Whether the failure most recently handled carried its OWN staleAt. A strike needs the
	// responder to have re-confirmed the number this round, not merely an older observation
	// left standing in `lastStaleAt`.
	private lastFailureConfirmedStaleAt = false;
	// Refused attempts of this write that carried their own staleAt. Never reset: a member counts
	// its stale refusals per action for the action's whole life, and this is the writer's view of
	// that count (see retryBackoffMs).
	private confirmedLosses = 0;
	// Consecutive refreshes that moved the requested revision nowhere at all while a confirmed
	// revision stood at or above it.
	private consecutiveStalls = 0;
	// The revision the PREVIOUS attempt would have requested, so the stall check can tell a
	// refresh that moved nowhere from one that is still climbing toward the confirmed number.
	private previousRequestedRev: number | undefined;

	/** Who holds what the write has committed so far. Stays `undefined` while nothing has been
	 * committed, which is also the answer when no attempt runs at all — a write with nothing staged
	 * writes nothing, and there is no durability to fabricate for it. Refused attempts never
	 * contribute: a refused attempt left nothing behind, so the answer is the committing one's. A
	 * write that commits more than once folds them with `mergeDurability`, whose scalar answer is
	 * the WEAKEST: one batch that only reached the writer makes the whole write only-on-the-writer,
	 * and reporting the last batch's class instead would show such a write as saved. */
	durability: WriteDurability | undefined;

	constructor(
		private readonly collectionId: CollectionId,
		private readonly instanceTag: string,
		options?: SyncOptions,
	) {
		this.maxAttempts = options?.maxAttempts ?? DefaultMaxAttempts;
		this.maxStalledAttempts = options?.maxStalledAttempts ?? DefaultMaxStalledAttempts;
		this.backoff = {
			baseMs: options?.baseBackoffMs ?? PendingRetryDelayMs,
			capMs: options?.maxBackoffMs ?? DefaultMaxBackoffMs,
		};
		this.deadlineMs = options?.deadlineMs;
		this.signal = options?.signal;
		this.rand = options?.rand;
	}

	/** The aged retry priority for the next attempt, from the consecutive-failure count: a write
	 * that keeps losing concurrent races out-ranks fresh (priority-0) rivals in the cluster's
	 * `resolveRace` (fairness-only, capped at `MaxPriority`). A first attempt is priority 0, so the
	 * common pend is unchanged. */
	priority(): number {
		return clampPriority(this.consecutiveFailures);
	}

	/**
	 * The checks that run before an attempt is built: the abort signal, the wall-clock deadline, and
	 * the stall check. The deadline comes before the stall check deliberately: it is the documented
	 * outer bound, so a write that is both past it and stalled reports the deadline.
	 *
	 * The stall check asks: can the attempt about to run possibly differ from the one that just
	 * failed? Only when BOTH of these hold is the answer provably no:
	 *
	 *  - `requestedRev` is at or below one a responder CONFIRMED is taken. A producer sets `staleAt`
	 *    only after reading that revision as durably held by someone else out of its own storage,
	 *    revisions are one per-collection counter that every commit touches, and a confirmed
	 *    revision never becomes un-taken (invalidation takes a NEW slot). So the request is already
	 *    lost before it is sent.
	 *  - The refresh in between moved the collection nowhere. `advanceContext` never lowers the
	 *    held revision, so "nowhere" is exactly `requestedRev` unchanged since the last attempt. A
	 *    refresh that moved forward WITHOUT clearing the confirmed number is a collection still
	 *    climbing (it read a replica that lags the holder — the same partial catch-up
	 *    `reportShortfall` exists to report), and its next attempt is a genuinely different request
	 *    that may yet win.
	 *
	 * This is NOT a second answer to "is this failure retryable?" — `isConflictFailure` remains the
	 * sole rule for that, untouched. It only ever stops a loop that rule had already decided to
	 * continue.
	 *
	 * @param requestedRev the revision the attempt would request (`Collection.getNextRev`).
	 * @param heldRev the revision the collection holds, for the stall report.
	 * @throws AbortError, {@link SyncRetryExhaustedError} (deadline), {@link SyncRevisionStalledError}. */
	beforeAttempt(requestedRev: number, heldRev: number | undefined): void {
		if (this.signal?.aborted) {
			throw makeAbortError(this.signal);
		}
		if (this.pastDeadline()) {
			throw new SyncRetryExhaustedError(this.collectionId, this.consecutiveFailures, this.lastReason ?? 'deadline exceeded', this.lastStaleAt);
		}
		const refreshMoved = this.previousRequestedRev !== undefined && requestedRev > this.previousRequestedRev;
		this.previousRequestedRev = requestedRev;
		if (this.lastStaleAt === undefined) {
			return;
		}
		if (requestedRev > this.lastStaleAt.rev || refreshMoved) {
			// Either the refresh adopted a revision above the confirmed one — ordinary contention,
			// where the rival's commit is exactly what we just read — or it made partial forward
			// progress. Both mean the next attempt differs. Not a stall.
			this.consecutiveStalls = 0;
		} else if (this.lastFailureConfirmedStaleAt) {
			this.consecutiveStalls++;
			if (log.enabled) {
				log('collection:sync-stalled id=%s tag=%s heldRev=%s requestedRev=%d staleBlock=%s staleRev=%d strike=%d of=%d',
					this.collectionId, this.instanceTag, heldRev ?? 'none', requestedRev,
					this.lastStaleAt.blockId, this.lastStaleAt.rev, this.consecutiveStalls, this.maxStalledAttempts);
			}
			// Two strikes, not one: a legitimate loser can transiently read a view that has not yet
			// caught up with the rival's commit, which looks identical for one round.
			if (this.consecutiveStalls >= this.maxStalledAttempts) {
				throw new SyncRevisionStalledError(this.collectionId, this.consecutiveFailures, this.lastStaleAt,
					requestedRev, heldRev, this.lastReason);
			}
		}
		// Else: the responder told us nothing new this round. No strike, and no reset either — the
		// budget stays bounded by maxAttempts.
	}

	/**
	 * Account for a refused attempt. The three refusals a retry can never get past are thrown by
	 * name, with nothing on the collection touched (the attempt ran on its own tracker), so the
	 * staged actions are still staged for a later write: an expiry, because the next attempt's
	 * expiration comes from the same clock; a promise shortfall, because every coordinator of the
	 * cohort meets the same silent members (only a pend answers this way, so nothing of the attempt
	 * was stored); a validity rejection, because the next attempt sends the same content to the same
	 * checks. Everything else is a stale failure counted against the no-progress budget, so a
	 * transactor that persistently rejects can no longer hold the collection latch forever.
	 *
	 * NOTE: an expiry refusing a commit SWEEP (`NetworkTransactor.commitTailThenSweep`) arrives after
	 * the log tail was stored, and no refresh follows this throw, so that attempt's log entry stays
	 * behind with none of its data — the state the budget-exhausted exit leaves too. Needs a sweep
	 * cohort whose clocks disagree while the tail's agree; tracked with the other leftover-entry
	 * exits in tickets/backlog/bug-a-refused-write-can-leave-its-log-entry-behind.
	 *
	 * NOTE: the budget also bounds the legitimate `pending`-wait case (retrying the same action while
	 * another commit is in flight), which used to retry indefinitely. Default 10 attempts ≈ 21s of
	 * exponential backoff. If a high-contention workload legitimately needs to wait longer for a
	 * pending commit to clear, raise maxAttempts for that caller.
	 *
	 * NOTE: no refresh follows the LAST budgeted attempt, so if that attempt's log tail landed nobody
	 * finds out: the caller gets plain exhaustion over a log that holds an entry for this write. The
	 * write is still never reported saved, which is the rule; what is lost is the more specific name
	 * (TornActionError). The leftover entry itself is tracked in
	 * tickets/backlog/bug-a-refused-write-can-leave-its-log-entry-behind.
	 *
	 * @throws TransactionExpiredError, PromiseShortfallError, ValidityRejectedError, SyncRetryExhaustedError */
	recordRefusal(refusal: WriteFailure): void {
		if (isExpiryFailure(refusal)) {
			throw new TransactionExpiredError(refusal.expired);
		}
		if (isShortfallFailure(refusal)) {
			throw new PromiseShortfallError(refusal.shortfall);
		}
		if (isRejectedFailure(refusal)) {
			throw new ValidityRejectedError(refusal.rejected);
		}
		this.consecutiveFailures++;
		this.lastReason = refusal.reason ?? this.lastReason;
		// Highest-wins, not last-wins: the next request has to clear EVERY holder, so a later
		// responder reporting a LOWER number understates the binding constraint. Same rule the
		// producers and the transactor's aggregation already use.
		this.lastStaleAt = highestStaleAt([this.lastStaleAt, refusal.staleAt]);
		this.lastFailureConfirmedStaleAt = refusal.staleAt !== undefined;
		if (this.lastFailureConfirmedStaleAt) this.confirmedLosses++;
		if (this.consecutiveFailures >= this.maxAttempts) {
			throw new SyncRetryExhaustedError(this.collectionId, this.consecutiveFailures, this.lastReason, this.lastStaleAt);
		}
	}

	/** Account for a commit — by an attempt, or by a refresh that finished the write's own entry,
	 * which is a commit too and is reported and counted exactly like one (see {@link durability}).
	 * Forward progress: the no-progress budget and the stall evidence start over. */
	recordCommit(durability: WriteDurability): void {
		this.durability = this.durability === undefined ? durability : mergeDurability([this.durability, durability]);
		this.consecutiveFailures = 0;
		this.lastReason = undefined;
		this.lastStaleAt = undefined;
		this.lastFailureConfirmedStaleAt = false;
		this.consecutiveStalls = 0;
	}

	/**
	 * Back off, refresh, and keep refreshing while the refresh reports that this write's own
	 * half-landed action could not be finished YET. The write path must not fall through to a new
	 * attempt in that state: the action's log entry is already durable, and as soon as a refresh
	 * adopts a newer revision a new attempt appends a SECOND entry under the same action id — the
	 * duplicate `Collection.consumeOwnEntry` exists to prevent. (At an unchanged revision the rebuild
	 * is byte-identical — see `Collection.logAppendBlockIds` — so what is at stake is the second
	 * entry, not two versions of one tail block.) Each round is a failure against the same
	 * no-progress budget as a refused attempt, and the round that would spend the last of it is told
	 * so (`lastChance`), so it settles a half-landed write instead of asking for another round and
	 * the error that escapes says whether the write can still land. (A deadline cannot be foreseen
	 * the same way; a write given up on it escapes unsettled, as `final: false`.)
	 *
	 * The backoff before each round grows exponentially from the base delay up to the cap, with
	 * proportional random jitter so a herd of clients that lost the same race does not re-collide on
	 * the next tick (see utility/backoff.ts) — except once this write has lost to committed rivals
	 * often enough that a member holds the next slot for it ({@link retryBackoffMs}). The abortable
	 * sleep lets an aborted write reject promptly instead of finishing the sleep. A refresh that
	 * follows NO refused attempt — the one `Collection.commitHead` opens its cycle with — sleeps not
	 * at all: there is no race to space out.
	 * NOTE: the `missing`/`reason` conflict paths pay this backoff too (they used to retry with zero
	 * delay); that is what stops the persistent-`reason` hot spin. If a high-contention workload ever
	 * shows this base delay as recovery latency, lower baseBackoffMs for that caller rather than
	 * reintroducing the zero-delay retry.
	 *
	 * The highest revision a responder confirmed is taken rides out as the floor of the refresh's
	 * tail read, so a machine that has not caught up to it is not the last one asked (see
	 * `Collection.updateInternal`).
	 *
	 * @returns whether the refresh FINISHED the write's own log entry (`RefreshReport.ownEntryFinished`)
	 * — the write is saved and the entry consumed, whether or not the refresh learned who holds it.
	 * @throws TornActionError with any reason but an unsettled `completion-refused`, and that one too
	 * once the budget or the deadline is spent; whatever else the refresh throws. */
	async refreshUntilSettled(refresh: Refresh): Promise<boolean> {
		// Whether the failure just handled was a loss to a rival already durably committed. Only the
		// attempt's own refusal can say so; a refresh refused for a cause that can clear (below) is a
		// race against something still in flight, and clears it.
		let latestConfirmed = this.lastFailureConfirmedStaleAt;
		for (;;) {
			const delay = this.consecutiveFailures === 0
				? 0
				: retryBackoffMs(this.consecutiveFailures, this.confirmedLosses, latestConfirmed, this.backoff, this.rand);
			await abortableDelay(delay, this.signal);
			try {
				const report: RefreshReport = {};
				await refresh(report, this.consecutiveFailures + 1 >= this.maxAttempts, this.lastStaleAt?.rev);
				const completed = report.ownEntryFinished?.durability;
				if (completed !== undefined) {
					this.recordCommit(completed);
				}
				return report.ownEntryFinished !== undefined;
			} catch (err) {
				if (!(err instanceof TornActionError) || err.reason !== 'completion-refused') {
					throw err;
				}
				// Refused for a cause that can clear. The error already names the write as torn, which
				// is the truth if the budget ends here — so it, not a plain exhaustion, is what escapes:
				// the log holds an entry for a write that was not saved.
				this.consecutiveFailures++;
				this.lastReason = err.detail;
				latestConfirmed = false;
				if (this.consecutiveFailures >= this.maxAttempts || this.pastDeadline()) {
					throw err;
				}
			}
		}
	}

	private pastDeadline(): boolean {
		return this.deadlineMs !== undefined && Date.now() - this.startedAt >= this.deadlineMs;
	}
}
