import type { ITransactor, BlockId, CollectionId, Transforms, PendRequest, PendResult, CommitRequest, CommitResult, WriteFailure, ActionId, WriteDurability, BlockContentDigests } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions, ReadDependency } from "./transaction.js";
import type { PeerId } from "../network/types.js";
import { isConflictFailure, isExpiryFailure, isRejectedFailure, isShortfallFailure } from "../network/stale-failure.js";
import { withBlockRevs } from "../network/durability.js";
import { TransactionExpiredError } from "../network/transaction-expired-error.js";
import { PromiseShortfallError } from "../network/promise-shortfall-error.js";
import { ValidityRejectedError } from "../network/validity-rejected-error.js";
import { TransactionTooLargeError } from "../network/transaction-size.js";
import { BlockTooLargeError, oversizedBlock } from "../network/block-size.js";
import type { Collection, CollectionSnapshot, RefreshReport } from "../collection/collection.js";
import type { SyncOptions } from "../collection/index.js";
import { TornActionError } from "../collection/struct.js";
import { isTransactionExpired, clampPriority } from "./transaction.js";
import { Log } from "../log/log.js";
import { blockIdsForTransforms, copyTransforms } from "../transform/helpers.js";
import { describeTouchedBlocks, blockDigestsField, baseRevsField } from "../transform/digest.js";
import { collectOperations, hashOperations } from "./operations-hash.js";
import { CoordinatorConcurrentStampError, CoordinatorPartialCommitError, CoordinatorStaleLossError } from "./errors.js";
import { recordCollectionDurability, transactionDurability, type TransactionDurability } from "./durability.js";
import { jitteredBackoffMs, abortableDelay, makeAbortError } from "../utility/backoff.js";
import { createLogger } from "../logger.js";

const log = createLogger('trx:coordinator');

/** Default max consecutive clean-stale-loss retries before {@link TransactionCoordinator.commit}
 * gives up. Mirrors the single-collection sync default so the two retry loops share one policy. */
const DefaultMaxAttempts = 10;
/** Default base backoff (ms) before the first commit retry. */
const DefaultBaseBackoffMs = 100;
/** Default ceiling (ms) on a single commit-retry backoff sleep. */
const DefaultMaxBackoffMs = 5000;

/**
 * A pend that failed. `conflict` marks the retryable class — an optimistic-concurrency collision that
 * a re-read + re-pend can clear — as decided by `isConflictFailure` over the failure response. A hard
 * rejection (storage full, policy) is NOT a conflict and is not worth re-driving. Built by
 * {@link pendRefusalError} for one collection's pend, or for every collection of a batched one, and
 * classified by {@link pendFailure}, which reads the flag off it.
 */
class PendRejectedError extends Error {
	constructor(
		collectionIds: readonly CollectionId[],
		readonly conflict: boolean,
		reason?: string,
		/** Confirmed revision the responder holds, from `StaleFailure.staleAt`. Folded into the
		 * message because pendPhase collapses this error to its `.message` string, which is the only
		 * form that reaches an embedder through the transaction result's `error` field. */
		staleAt?: { blockId: BlockId; rev: number },
	) {
		super(`Pend failed for ${collectionIds.length === 1 ? 'collection' : 'collections'} ${collectionIds.join(', ')}: ${reason ?? (conflict ? 'stale conflict' : 'rejected')}`
			+ (staleAt ? ` (block ${staleAt.blockId} at rev ${staleAt.rev})` : ''));
		this.name = 'PendRejectedError';
	}
}

/** The error a refused pend of `collectionIds` stands for: its validity rejection — never retried, since
 * a re-drive sends the same content to the same checks — its expiry — never retried, since a re-drive's
 * expiration comes from the same clock — or its promise shortfall — never retried, since a re-drive
 * meets the same silent members — or a rejection carrying whether a re-read can clear it.
 * Retryability comes from the response itself: a producer that classified the failure sets `conflict`,
 * and only where none did is it inferred from `missing`/`pending` (`isConflictFailure`). */
function pendRefusalError(collectionIds: readonly CollectionId[], refusal: WriteFailure): ValidityRejectedError | TransactionExpiredError | PromiseShortfallError | PendRejectedError {
	if (isRejectedFailure(refusal)) return new ValidityRejectedError(refusal.rejected);
	if (isExpiryFailure(refusal)) return new TransactionExpiredError(refusal.expired);
	if (isShortfallFailure(refusal)) return new PromiseShortfallError(refusal.shortfall);
	return new PendRejectedError(collectionIds, isConflictFailure(refusal), refusal.reason, refusal.staleAt);
}

/** A transaction refused before anything was sent: its pend, or a block it would leave, too large to send. */
type TooLargeError = TransactionTooLargeError | BlockTooLargeError;

/** How the pend phase failed. */
type PendPhaseFailure = { success: false; error: string; staleLoss?: boolean; rejected?: ValidityRejectedError; expired?: TransactionExpiredError; shortfall?: PromiseShortfallError; tooLarge?: TooLargeError };

/** Per collection, what its commit declares about its blocks (`CommitRequest.blockDigests`), described
 * once before the pend ({@link TransactionCoordinator.declareTouchedBlocks}). */
type DeclaredDigests = ReadonlyMap<CollectionId, BlockContentDigests>;

/**
 * The pend phase's failure for `reasons` — what every failed pend threw or stood for, at least one.
 * The error text is the first reason's. The attempt is a retryable clean stale loss only if at least one
 * reason was a conflicting pend ({@link PendRejectedError}`.conflict`) AND none was a hard failure: a
 * single hard failure (storage/policy rejection, or a thrown/unavailable transactor) will not clear on a
 * re-read, so re-driving it would just burn the retry budget. A validity rejection, an expiry, a promise
 * shortfall, and a pend or a block too large to send, are hard failures carried whole: each is the error
 * the commit surfaces.
 */
function pendFailure(reasons: readonly unknown[]): PendPhaseFailure {
	const first = reasons[0];
	const conflicts = reasons.filter(reason => reason instanceof PendRejectedError && reason.conflict);
	const rejected = reasons.find((reason): reason is ValidityRejectedError => reason instanceof ValidityRejectedError);
	const expired = reasons.find((reason): reason is TransactionExpiredError => reason instanceof TransactionExpiredError);
	const shortfall = reasons.find((reason): reason is PromiseShortfallError => reason instanceof PromiseShortfallError);
	const tooLarge = reasons.find((reason): reason is TooLargeError => reason instanceof TransactionTooLargeError || reason instanceof BlockTooLargeError);
	return {
		success: false,
		error: first instanceof Error ? first.message : String(first),
		staleLoss: conflicts.length > 0 && conflicts.length === reasons.length,
		...(rejected === undefined ? {} : { rejected }),
		...(expired === undefined ? {} : { expired }),
		...(shortfall === undefined ? {} : { shortfall }),
		...(tooLarge === undefined ? {} : { tooLarge }),
	};
}

/**
 * What one {@link TransactionCoordinator.commit} call keeps across all of its attempts. Created
 * once per commit, filled in by each attempt and by the refresh between attempts, and read when
 * the commit fails, so the failure can say which participants are already saved.
 */
type CommitCycle = {
	/** Disposers for the in-flight marks each attempt sets on the participants it latches. They
	 * must outlive the individual attempt: the inter-attempt refresh is the ONLY reader of the mark,
	 * and it deliberately runs after the commit span released its latches (`Latches` is
	 * non-reentrant), so a clear tied to the latch would already have run. Each disposer is
	 * id-guarded, so re-marking on a later attempt is harmless and a stale disposer cannot wipe a
	 * newer mark. */
	inFlightDisposers: (() => void)[];
	/** Every collection any attempt included — one with staged changes when that attempt began. A
	 * registered collection no attempt included is not part of this transaction and appears in no
	 * report. */
	participants: Set<CollectionId>;
	/** Participants that are durably committed while the commit is still being driven: a refresh
	 * between attempts found this transaction's own log entry and finished it (see
	 * {@link RefreshReport}), or an attempt committed them and was refused on a sibling that can
	 * still be finished (the partial-retry branch of {@link commitOnceLatched}). Once non-empty,
	 * the commit can no longer fail cleanly: every later failure is reported through
	 * {@link reportSaved} as a partial landing naming these as committed. A successful attempt
	 * ends the commit and records nothing here (it returns what it committed instead); a partial
	 * landing on a hard failure reports its own committed set at once. Each saved participant
	 * carries who holds it, `undefined` where the refresh that saved it could not say (see
	 * {@link TransactionDurability}). */
	saved: Map<CollectionId, WriteDurability | undefined>;
};

/** How one collection's commit ended ({@link TransactionCoordinator.commitCollection}, or its share of
 * a batched commit's one answer). */
type CollectionCommitOutcome =
	| { collectionId: CollectionId; committed: true; durability: WriteDurability }
	| { collectionId: CollectionId; committed: false; error: string; stale?: boolean; expired?: TransactionExpiredError };

/**
 * How `collectionId`'s commit ended when `result` answered its `request` — the answer to its own
 * commit, or, in a batched commit, the batch's one answer for every collection of it. A success is
 * stamped with the collection's own blocks at its own revision (`withBlockRevs`).
 */
function collectionCommitOutcome(collectionId: CollectionId, request: CommitRequest, result: CommitResult): CollectionCommitOutcome {
	if (result.success) {
		return { collectionId, committed: true, durability: withBlockRevs(result.durability, request.blockIds, request.rev) };
	}
	if (isExpiryFailure(result)) {
		// Not a stale loss: a re-drive's expiration comes from the same clock.
		const expired = new TransactionExpiredError(result.expired);
		return { collectionId, committed: false, error: expired.message, expired };
	}
	// Permanent stale failure: never retried verbatim. It IS a clean stale loss, though, so mark it
	// retryable at the coordinator level (after a re-read advances the rev).
	// NOTE: deliberately does NOT consult `isConflictFailure` / `StaleFailure.conflict` like the pend
	// path does. Once the pend succeeded, a returned commit failure means the revision slot moved, or a
	// member behind on the base refused — the durability gate's `commit-not-durable` (which does set
	// `conflict`) or a solo StorageRepo's `missing-base-revision` (a bare `reason`, no `conflict`). All of
	// these clear on a re-drive, so gating on `conflict` here would fail the last of them fast. One commit
	// producer DOES set `conflict` now — db-p2p's CoordinatorRepo.commit returns lost commit-consensus
	// races and classified stale-commit rejections as `{ success:false, conflict:true }` (returning, not
	// throwing, is what keeps them out of commitCollection's verbatim retry) — but every returned failure
	// still maps to `stale: true` here, and `isConflictFailure` covers that new shape, so no behavior
	// change is needed. The one returned refusal that is NOT a stale loss, an expiry, is split off above.
	// If a commit producer ever starts returning other hard commit rejections (validator policy, storage
	// fault) as results too, gate `stale` on isConflictFailure here.
	return {
		collectionId,
		committed: false,
		stale: true,
		error: result.reason ?? `Stale commit for collection ${collectionId}`
	};
}

/** How one attempt's distributed phases ended ({@link TransactionCoordinator.coordinateTransaction}).
 * `committedCollections` carries who holds each collection that durably committed — every
 * participant on success, a subset (possibly empty) on failure. */
type CoordinationResult =
	| { success: true; committedCollections: ReadonlyMap<CollectionId, WriteDurability> }
	| {
		success: false;
		error?: string;
		committedCollections?: ReadonlyMap<CollectionId, WriteDurability>;
		failedCollections?: ReadonlySet<CollectionId>;
		/** True when the failure was a clean optimistic-concurrency conflict (stale loss / pending
		 * contention) with nothing durable — i.e. safe to re-drive after a re-read. */
		staleLoss?: boolean;
		/** Present when a pend was refused because the members that sank it judged the transaction
		 * invalid: the error the commit surfaces, never a stale loss. */
		rejected?: ValidityRejectedError;
		/** Present when a pend or a commit was refused because the transaction had expired by the
		 * cohort's clocks: the error the commit surfaces, never a stale loss. */
		expired?: TransactionExpiredError;
		/** Present when a pend was refused because too few cohort members answered its promise round:
		 * the error the commit surfaces, never a stale loss. */
		shortfall?: PromiseShortfallError;
		/** Present when the transaction was refused before anything was sent because its pend, or a block
		 * it would leave, was too large to send: the error the commit surfaces, never a stale loss. */
		tooLarge?: TooLargeError;
	};

/** What a successful commit wrote: `written` folded into one report, or `undefined` when it holds
 * nothing (nothing was staged, so there was no pend and no commit — the same hole
 * `Collection.sync` has). */
function writtenDurability(written: ReadonlyMap<CollectionId, WriteDurability | undefined>): TransactionDurability | undefined {
	return written.size === 0 ? undefined : transactionDurability(written);
}

/**
 * What a pend this coordinator sends carries for the receiving cluster members to re-check.
 *
 * - `'transaction'` (default): the transaction and the hash of every operation it produced — the
 *   session-mode shape. A member with a transaction validator re-executes the statements and
 *   compares hashes; the aged retry priority rides inside the transaction.
 * - `'none'`: bare transforms, exactly the shape a single-collection `Collection.sync` pend has.
 *   For a commit that has no statements to re-execute — the Quereus adapter's legacy multi-tree
 *   commit, whose rows were staged directly into the trees — a validating member would otherwise
 *   refuse the pend as a validator fault. The aged priority then rides on the pend itself
 *   (`PendRequest.priority`), which is the other carrier a member's race resolution reads, so a
 *   repeatedly-losing commit still ages. Members configured `unvalidatablePendPolicy: 'reject'`
 *   refuse these pends, as they refuse every unvalidatable pend.
 */
export type PendValidationMode = 'transaction' | 'none';

export interface CoordinatorOptions {
	/** See {@link PendValidationMode}. Default `'transaction'`. */
	pendValidation?: PendValidationMode;
}

/**
 * Coordinates multi-collection transactions.
 *
 * This is the ONLY interface for all mutations (single or multi-collection).
 *
 * Responsibilities:
 * - Manage collections (create as needed)
 * - Apply actions to collections (run handlers, write to logs)
 * - Commit transactions by running consensus phases (GATHER, PEND, COMMIT)
 */
export class TransactionCoordinator {
	/** Per-stampId tracking: the pre-staging snapshot of every collection the stamp may have
	 * staged into, which is everything {@link rollback} needs to rewind it.
	 *
	 * INVARIANT: `stampData.size <= 1` — at most ONE open stamp per coordinator, enforced by the
	 * guards in {@link applyActions} and {@link commit} (which throw
	 * {@link CoordinatorConcurrentStampError}) and {@link execute} (which returns it as a failure
	 * result). The registered collections hold exactly one staged state — one tracker transform
	 * set and one pending action queue each, shared by every open stamp — so two concurrent stamps
	 * would read each other's uncommitted rows and a commit of either would write the other's
	 * staged actions into its own durable log entry. A stamp is released by commit (success or
	 * partial) or by rollback; a CLEAN commit failure keeps its entry so `rollback(stampId)`
	 * stays a complete recovery, meaning an abandoned failed commit holds the coordinator against
	 * new stamps until it is rolled back. The guard sees only what opens a stamp, so two
	 * coordinators sharing collection instances — and writers that stage only via Tree.stage /
	 * Collection.act, which open none — stay the caller's contract ("own bridge per writer" —
	 * docs/transactions.md), not this map's.
	 *
	 * Each snapshot holds BOTH halves of a collection's staged state — tracker transforms AND
	 * the pending action queue — as one {@link Collection.snapshotPending} value. Restoring only
	 * the transforms would leave a rolled-back stamp's actions queued, where the next commit on
	 * that collection would write them into ITS durable log entry (and a conflicting sync's
	 * `replayActions` would re-apply them into the tracker as live data). Keeping the pair in one
	 * value makes half-restored staged state unrepresentable here.
	 *
	 * `preSnapshot` is keyed by the {@link Collection} INSTANCE, not by {@link CollectionId}: the
	 * collection map this coordinator is handed is owned by its caller (the Quereus adapter's
	 * registry), which may replace the instance stored under an id when a table re-initializes.
	 * An id-keyed snapshot would then restore the OLD instance's staged state onto the NEW one;
	 * instance keys make that unrepresentable — the new instance simply gets its own capture at
	 * the next reconcile, and the stale entry restores a detached object nobody reads.
	 *
	 * Capture is LAZY: a collection enters the map at the first {@link applyActions} after it
	 * appears in `this.collections` (see {@link captureUncaptured}), so a collection registered
	 * mid-transaction is still captured before anything stages into it. */
	private stampData = new Map<string, {
		preSnapshot: Map<Collection<any>, CollectionSnapshot<any>>;
	}>();

	/** See {@link PendValidationMode}; fixed for the coordinator's lifetime, so every pend it
	 * sends has one shape. */
	private readonly pendValidation: PendValidationMode;

	constructor(
		private readonly transactor: ITransactor,
		private readonly collections: Map<CollectionId, Collection<any>>,
		options: CoordinatorOptions = {}
	) {
		this.pendValidation = options.pendValidation ?? 'transaction';
	}

	/**
	 * The validation pair every pend of this attempt carries, or `undefined` when this coordinator
	 * sends unvalidated pends (see {@link PendValidationMode}). Built once per attempt, AFTER the
	 * log append: the hash covers ALL operations across ALL collections, which a validator
	 * recomputes from its own re-execution and compares. The shared operations-hash module
	 * canonicalises (sort + canonical JSON), so the fingerprint is order-independent. Skipped
	 * entirely — not computed and discarded — when no pend will carry it.
	 */
	private async pendValidationFor(
		transaction: Transaction,
		collectionTransforms: Map<CollectionId, Transforms>
	): Promise<PendRequest['validation']> {
		if (this.pendValidation === 'none') {
			return undefined;
		}
		return { transaction, operationsHash: await hashOperations(collectOperations(collectionTransforms)) };
	}

	/**
	 * Apply actions to collections (called by engines during statement execution).
	 *
	 * This is the core method that engines call to apply actions to collections.
	 * Actions are tagged with the stamp ID and executed immediately through collections
	 * to update the local snapshot.
	 *
	 * @param actions - The actions to apply (per collection)
	 * @param stampId - The transaction stamp ID to tag actions with
	 */
	async applyActions(
		actions: CollectionActions[],
		stampId: string
	): Promise<void> {
		let data = this.stampData.get(stampId);
		if (!data) {
			// At most one open stamp (see the invariant on stampData). Checked inside this method's
			// await-free prologue — the check, the entry creation, and the capture below run as one
			// atomic step, so a second stamp cannot register between a TRACKED stamp's commit guard
			// and its log append: that stamp's entry stays in the map for the whole commit span, so
			// this check keeps seeing it. An UNTRACKED commit (the Tree.stage / Collection.act path,
			// which creates no entry) leaves the map empty and so cannot be interlocked this way —
			// that is the documented out-of-scope case, not a hole this guard closes.
			const open = this.openStampOtherThan(stampId);
			if (open !== undefined) {
				throw new CoordinatorConcurrentStampError(open, stampId);
			}
			data = { preSnapshot: new Map() };
			this.stampData.set(stampId, data);
		}

		// Runs on EVERY call, and stays await-free through to applyActionsRaw — see the method doc.
		this.captureUncaptured(data.preSnapshot);

		await this.applyActionsRaw(actions, stampId);
	}

	/** The id of the open stamp {@link stampData} tracks when it is not `stampId`; undefined when
	 * no OTHER stamp is open. The single-open-stamp invariant on {@link stampData} is what makes
	 * "the" (singular) correct here. */
	private openStampOtherThan(stampId: string): string | undefined {
		for (const open of this.stampData.keys()) {
			if (open !== stampId) return open;
		}
		return undefined;
	}

	/**
	 * Capture the pre-staging state of every registered collection `into` does not already hold.
	 *
	 * Called on EVERY {@link applyActions}, not only a stamp's first. `this.collections` is owned
	 * by the caller (the Quereus adapter's registry) and grows as tables open mid-transaction; a
	 * collection registered after the stamp's first call would otherwise be visible to commit but
	 * absent from every snapshot, so {@link rollback} would never visit it and its staged state
	 * would survive into the next transaction's durable log entry.
	 *
	 * `applyActions` is the right capture point because it precedes any staging that call performs
	 * — and on the Quereus path, where the vtab stages directly into the trees, the awaited
	 * empty-actions applyActions call exists precisely to be that pre-stage barrier (see
	 * optimystic-module.ts's "applyActions before any collection.stage" invariant).
	 *
	 * The already-captured guard is load-bearing: registration is idempotent (the adapter
	 * re-registers already-open index trees), and re-capturing a collection this stamp already
	 * staged into would record a DIRTY state as "before", making rollback preserve the very
	 * actions it must discard.
	 *
	 * Synchronous and await-free BY CONTRACT, for the same reason execute()'s pre-stage snapshot
	 * loop is: an interleaved stage would land inside a snapshot. Callers must not await between
	 * this call and the staging it guards.
	 *
	 * NOTE: this runs per applyActions call rather than once per transaction. Per-call cost for an
	 * already-captured collection is one Map.has; snapshotPending (which deep-copies the transforms)
	 * still runs at most once per collection per stamp. Unmeasured. If the registered-collection
	 * count ever grows large enough for the scan itself to matter, track a per-stamp "collections
	 * map size at last capture" rather than dropping the reconcile.
	 */
	private captureUncaptured(into: Map<Collection<any>, CollectionSnapshot<any>>): void {
		for (const col of this.collections.values()) {
			if (into.has(col)) continue;
			into.set(col, col.snapshotPending());
		}
	}

	/**
	 * Stage each action against its collection, tagged `transaction: stampId`, without touching
	 * the {@link stampData} bookkeeping.
	 *
	 * That tag is a contract, not an implementation detail: it is the provenance the rollback tests
	 * read (`expectNoActionsFromStamp` in coordinator-rollback-pending.spec.ts) to tell one stamp's
	 * queued actions from another's. Only {@link applyActions} calls this; the split exists just to
	 * keep the single-open-stamp guard and the pre-stage capture readable apart from the staging
	 * loop.
	 */
	private async applyActionsRaw(
		actions: CollectionActions[],
		stampId: string
	): Promise<void> {
		for (const { collectionId, actions: collectionActions } of actions) {
			const collection = this.collections.get(collectionId);
			if (!collection) {
				throw new Error(`Collection not found: ${collectionId}`);
			}

			for (const action of collectionActions) {
				const taggedAction = { ...(action as any), transaction: stampId };
				await collection.act(taggedAction);
			}
		}
	}

	/**
	 * Commit a transaction with a bounded, jittered backoff retry around a CLEAN stale loss.
	 *
	 * The single-attempt work lives in {@link commitOnce}; {@link commitAttempts} re-drives it when
	 * the attempt fails as a clean optimistic-concurrency loss ({@link CoordinatorStaleLossError} —
	 * nothing durably committed, every tracker restored to its pre-append state). Before each
	 * re-attempt it re-reads each collection to fresh revisions (so the retry pends against current
	 * state rather than immediately re-failing stale), then backs off with the same jitter policy as
	 * {@link Collection.sync}. Retry is bounded by `maxAttempts` and an optional wall-clock
	 * `deadlineMs`, and honours an abort `signal`.
	 *
	 * A PARTIAL landing — some collection durably committed while a sibling's commit was refused —
	 * is re-driven too when every refusal was a returned one (a member behind on the block's base,
	 * a rival that took the revision slot): the committed collections are recorded as saved and the
	 * next attempt commits only what is still staged, so the durable half is never re-logged and the
	 * refused collection gets the same refresh-and-finish recovery a clean loss gets. A caller must
	 * still never re-drive a partial landing itself. A partial landing on a HARD failure (the
	 * transport budget spent, a structural rejection) escapes at once as
	 * {@link CoordinatorPartialCommitError}, and any other failure (expired transaction,
	 * unavailable transactor, unreachable cluster) also propagates without retry — including a pend
	 * or commit the cohort refused because the transaction had expired by its members' clocks, which
	 * surfaces as {@link TransactionExpiredError} (inside a partial commit's `reason` once a sibling
	 * has landed), a pend too few of the cohort's members answered, which surfaces as
	 * {@link PromiseShortfallError}, and a pend the members that sank it judged invalid, which surfaces
	 * as {@link ValidityRejectedError}.
	 *
	 * A participant can also be SAVED between attempts: an attempt that reported a loss may still
	 * have stored that participant's log tail, and the refresh before the next attempt then finishes
	 * and consumes the participant's own entry (see {@link refreshBetweenAttempts}). From that moment
	 * the commit can no longer fail cleanly, so EVERY failure that escapes afterwards — a torn sibling,
	 * a sibling that keeps losing until the budget runs out, an abort, an expiry, a hard error — is
	 * rethrown as {@link CoordinatorPartialCommitError}, counting the refresh-saved participants as
	 * committed and carrying the original error as its `reason` (see {@link reportSaved}). A commit in
	 * which nothing was saved fails with exactly the error it failed with.
	 *
	 * Defaults are safe out of the box: a caller that passes no options gets bounded, jittered retry.
	 *
	 * @param transaction - The transaction to commit
	 * @param options - Retry knobs; shares the {@link SyncOptions} vocabulary with `Collection.sync`.
	 * @returns who holds what the commit wrote — per collection, across every attempt (a participant
	 * the refresh between attempts saved included), with `overall` the weakest of them. Test it
	 * through `isFullyDurable(overall)`; an absent `overall` means some collection is saved but who
	 * holds it is unknown. `undefined` means NOTHING was written — nothing was staged, or a retry's
	 * replay dropped every staged action — exactly as `Collection.sync` reports an empty sync. Every
	 * other successful return carries a report; a failure after something was written carries the
	 * committed half's on {@link CoordinatorPartialCommitError.durability}.
	 */
	async commit(transaction: Transaction, options?: SyncOptions): Promise<TransactionDurability | undefined> {
		// At most one open stamp (see the invariant on stampData). Checked once, BEFORE the retry
		// loop — this is a hard failure, never retryable: the open stamp must be committed or
		// rolled back first. This guard is what catches a caller that staged directly (Tree.stage /
		// Collection.act, which creates no stampData entry) and commits while a sibling stamp is
		// tracked — such a commit would sweep the sibling's queued actions into its own log entry.
		const open = this.openStampOtherThan(transaction.stamp.id);
		if (open !== undefined) {
			throw new CoordinatorConcurrentStampError(open, transaction.stamp.id);
		}

		const cycle: CommitCycle = {
			inFlightDisposers: [],
			participants: new Set(),
			saved: new Map(),
		};
		try {
			return await this.commitAttempts(transaction, cycle, options);
		} catch (err) {
			// The ONE place a failure leaves this commit, so no exit — present or future — can skip
			// reporting a participant that is already saved.
			throw this.reportSaved(transaction, cycle, err);
		} finally {
			// The in-flight marks must outlive each individual attempt (see CommitCycle), so they are
			// cleared here, on every exit: return, stale-loss exhaustion, a partial landing, a hard
			// error, an abort.
			for (const dispose of cycle.inFlightDisposers) {
				dispose();
			}
		}
	}

	/** The retry loop behind {@link commit}: every attempt, and the refresh between them. Records
	 * what it learns in `cycle`; {@link commit} owns turning a failure into the right report. On
	 * success, reports every participant the cycle saved together with what the final attempt
	 * committed (see {@link commit}'s return). */
	private async commitAttempts(transaction: Transaction, cycle: CommitCycle, options?: SyncOptions): Promise<TransactionDurability | undefined> {
		const maxAttempts = options?.maxAttempts ?? DefaultMaxAttempts;
		const baseBackoffMs = options?.baseBackoffMs ?? DefaultBaseBackoffMs;
		const maxBackoffMs = options?.maxBackoffMs ?? DefaultMaxBackoffMs;
		const deadlineMs = options?.deadlineMs;
		const signal = options?.signal;
		const startedAt = Date.now();

		// Count of consecutive clean stale losses. There is no forward-progress notion here (a
		// single commit either lands or it does not), so this simply bounds how many times we
		// re-drive a losing transaction before surfacing a terminal error.
		let staleLosses = 0;
		let lastLoss: CoordinatorStaleLossError | undefined;

		for (;;) {
			if (signal?.aborted) {
				throw makeAbortError(signal);
			}
			// Progress-agnostic ceiling: once we've taken at least one loss, give up if the
			// wall-clock deadline passed (independent of the attempt cap).
			if (deadlineMs !== undefined && lastLoss && Date.now() - startedAt >= deadlineMs) {
				throw lastLoss;
			}

			// Age the transaction's advisory priority by the number of losses taken so far, so a
			// repeatedly-losing transaction out-ranks fresh (priority-0) rivals in the cluster's
			// resolveRace. Fairness-only and capped at MaxPriority; excluded from the tx id / client
			// signature, so bumping it here does not churn identity. Left untouched on the first
			// attempt (staleLosses == 0) so the initial pend serializes exactly as before.
			if (staleLosses > 0) {
				transaction.priority = clampPriority(staleLosses);
			}

			try {
				const committed = await this.commitOnce(transaction, cycle);
				// Merged, not overwritten, should one participant be both saved and committed (see the
				// NOTE in reportSaved).
				const written = new Map(cycle.saved);
				for (const [collectionId, durability] of committed) {
					recordCollectionDurability(written, collectionId, durability);
				}
				return writtenDurability(written);
			} catch (err) {
				// Only a CLEAN stale loss is retryable. A partial landing, an expired transaction, an
				// unavailable transactor, etc. all propagate unchanged.
				if (!(err instanceof CoordinatorStaleLossError)) {
					throw err;
				}
				lastLoss = err;
				staleLosses++;
				if (staleLosses >= maxAttempts) {
					throw err;
				}
				// Re-read fresh state before re-attempting so the next commit pends against current
				// revisions (mirrors how Collection.sync calls updateInternal() before retrying).
				//
				// A participant whose log tail landed despite the reported loss finds its own entry
				// here and FINISHES that action before consuming it (Collection.completeOwnEntry,
				// from the attempt commitOnceLatched retained). When finishing is refused for a cause
				// that can clear, the refresh — not the commit — is what gets retried: the
				// participant's log entry is already durable, and once a refresh adopts a newer
				// revision commitOnce appends a SECOND entry under this transaction's id. (At an
				// unchanged revision the re-append is byte-identical — see
				// Collection.logAppendBlockIds — so what is at stake is the duplicate entry, not two
				// versions of one tail block.)
				// Each such round counts against the same budget as a stale loss; a permanent
				// refusal (a rival holds the revision) escapes as the named TornActionError at once.
				// Re-refreshing collections an earlier round already refreshed is a no-op.
				// The round that would spend the last of the budget is told so, which makes each
				// participant SETTLE a half-landed write rather than ask for another round: the
				// error thrown below then says whether the write can still land (`final`). A
				// deadline cannot be foreseen the same way; a write given up on it stays unsettled.
				for (;;) {
					const delay = jitteredBackoffMs(staleLosses - 1, { baseMs: baseBackoffMs, capMs: maxBackoffMs }, options?.rand);
					await abortableDelay(delay, signal);
					const refused = await this.refreshBetweenAttempts(cycle, staleLosses + 1 >= maxAttempts);
					if (refused === undefined) {
						break;
					}
					staleLosses++;
					if (staleLosses >= maxAttempts
						|| (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs)) {
						throw refused;
					}
				}
				if (cycle.saved.size > 0 && this.stagedCollections().length === 0) {
					// The refresh saved what was left: nothing is staged any more, so this transaction
					// is committed. Return now rather than go round again, where an abort, the deadline
					// or an expiry check could still report failure for a transaction that is entirely
					// saved. The refresh's consume and replay already gave each saved participant the
					// success path's local treatment, so only the stamp is left to release.
					// Tested on what is still STAGED, not on "every participant saved": a participant
					// can be saved and still hold actions staged after the attempt began, and those
					// the next attempt must commit.
					this.stampData.delete(transaction.stamp.id);
					return transactionDurability(cycle.saved);
				}
			}
		}
	}

	/**
	 * Refresh every registered collection between attempts, recording in `cycle.saved` each one
	 * whose refresh finished this transaction's own log entry (see {@link Collection.refreshInFlight}),
	 * with who holds it — `undefined` when the refresh could not say, which still records it as saved.
	 *
	 * Visits EVERY collection even after one throws. Stopping at the first throw would leave a
	 * participant later in the map unfinished whenever an earlier one is torn — its log tail stored
	 * and its other blocks never landed, the silent loss `Collection.completeOwnEntry` exists to
	 * prevent — and unreported. Each refresh is independent (its own latch, its own instance state),
	 * so one failing says nothing about the next.
	 *
	 * NOTE: refreshes EVERY registered collection, not only the participants of this transaction.
	 * Not free: a non-participant's refresh throws CollectionHeaderVanishedError if its header
	 * momentarily reads absent while it holds a committed revision, aborting this retry. And because
	 * a throw no longer stops the round, an unreachable cluster costs one failed read per registered
	 * collection rather than one. The registered set is small today; if that (or retry latency) ever
	 * bites, narrow this to the transaction's participants.
	 *
	 * @param lastChance - this is the round that spends the last of the retry budget, so a
	 * participant whose half-landed write is refused again settles it (`Collection.completeOwnEntry`)
	 * rather than asking for a round it will not get; the error returned then carries `final`.
	 * @returns the first `completion-refused` {@link TornActionError} when that is the only way any
	 * refresh failed — the round is worth retrying; `undefined` when every refresh succeeded.
	 * @throws the first other error, once every collection has been visited.
	 */
	private async refreshBetweenAttempts(cycle: CommitCycle, lastChance: boolean): Promise<TornActionError | undefined> {
		let terminal: { error: unknown } | undefined;
		let refused: TornActionError | undefined;
		for (const [collectionId, collection] of this.collections) {
			const report: RefreshReport = {};
			try {
				await collection.refreshInFlight(report, lastChance);
			} catch (err) {
				if (err instanceof TornActionError && err.reason === 'completion-refused') {
					refused ??= err;
				} else {
					terminal ??= { error: err };
				}
			}
			// Read after the try, not only on success: a refresh can throw AFTER it finished the
			// entry, and that participant is saved either way.
			if (report.ownEntryFinished !== undefined) {
				recordCollectionDurability(cycle.saved, collectionId, report.ownEntryFinished.durability);
			}
		}
		if (terminal !== undefined) {
			throw terminal.error;
		}
		return refused;
	}

	/** Every registered collection with something to push — the participants an attempt starting
	 * now would commit. The predicate is {@link Collection.hasUnsyncedChanges}, the one
	 * `Collection.sync` loops on: staged actions OR uncommitted tracker transforms. Not the
	 * transforms alone: an action can be staged and have changed no block — a delete of an index
	 * entry this instance's stale view never held (the shape `blind-index-delete-is-logged-but-
	 * never-applied` fixed for the single-collection path) — and such a collection MUST still take
	 * part. Its stale pend is refused, and the refresh between attempts replays the action against
	 * the adopted revision, where it finds the entry and produces the delete the retry commits.
	 * Filtering on transforms dropped it from the batch entirely, so the row went and its index
	 * entry stayed behind, on every node. */
	private stagedCollections(): { collectionId: CollectionId; collection: Collection<any>; transforms: Transforms }[] {
		return Array.from(this.collections.entries())
			.filter(([, collection]) => collection.hasUnsyncedChanges())
			.map(([collectionId, collection]) => ({
				collectionId,
				collection,
				transforms: collection.tracker.transforms
			}));
	}

	/**
	 * What a failure escaping {@link commit} must be reported as. When nothing is saved, the error
	 * itself, untouched. When a refresh between attempts already saved a participant, the commit
	 * half-landed whatever the error says — a {@link CoordinatorStaleLossError}'s "nothing durably
	 * committed, safe to re-drive" would be false, and a re-drive would apply the saved half twice —
	 * so it becomes a {@link CoordinatorPartialCommitError}:
	 *
	 * - `committedCollections`: every refresh-saved participant, plus the committed set of `err`
	 *   when it is itself a partial landing (merged, never wrapped twice — its `reason` is kept);
	 *   `durability` carries who holds each of them, merged the same way;
	 * - `failedCollections`: every other participant of any attempt. Empty when a failure came after
	 *   every participant was saved (a refresh that finished its entry and then threw, say);
	 * - `reason`: the original error.
	 *
	 * Local state already matches that report: a saved participant was consumed by its refresh, and
	 * an unsaved one kept its staged actions (a failed finish throws before touching anything, and
	 * commitOnceLatched restores every participant it did not commit). The stamp is released, as on
	 * the existing partial path, because the transaction can no longer be cleanly rolled back.
	 */
	private reportSaved(transaction: Transaction, cycle: CommitCycle, err: unknown): unknown {
		if (cycle.saved.size === 0) {
			return err;
		}
		const committed = new Map(cycle.saved);
		let reason = err;
		if (err instanceof CoordinatorPartialCommitError) {
			for (const [id, durability] of err.durability.collections) {
				recordCollectionDurability(committed, id, durability);
			}
			reason = err.reason;
		}
		// NOTE: a participant is in exactly one list, so one saved by a refresh that ALSO held actions
		// staged after its attempt began (and a later attempt failed to commit them) is listed only as
		// committed. Unreachable while a session stages and commits on one call path; if staging ever
		// races a commit, report such a participant in both lists.
		const failed = [...cycle.participants].filter(id => !committed.has(id));
		log('commit:partial-after-refresh tx=%s committed=%o failed=%o reason=%s', transaction.id,
			[...committed.keys()], failed, reason instanceof Error ? reason.name : String(reason));
		this.stampData.delete(transaction.stamp.id);
		return new CoordinatorPartialCommitError(committed, failed, reason);
	}

	/**
	 * Commit a transaction (single attempt): materialise a log entry from each collection's staged
	 * pending actions, then orchestrate the distributed consensus (GATHER/PEND/COMMIT).
	 *
	 * Called by {@link commitAttempts} (the backoff+jitter retry loop behind {@link commit}). The
	 * staged mutations already live in each collection's tracker — applied either via
	 * applyActions() (engine-driven path) or directly via Collection.act()/Tree.stage
	 * (the vtab's deferred-DML path) — but in BOTH cases without a log entry yet, so
	 * this method appends that entry here (see the inline note below) before pending,
	 * and folds the committed transforms back into each collection's read cache.
	 *
	 * On a clean stale loss (nothing durable, every tracker restored) it throws
	 * {@link CoordinatorStaleLossError} so the caller can retry. On a partial landing it throws the
	 * same, after recording the committed collections in `cycle.saved`, when every refusal was a
	 * returned one (the retry finishes the refused collection); on a hard failure it throws
	 * {@link CoordinatorPartialCommitError} (not retryable).
	 *
	 * @param transaction - The transaction to commit
	 * @param cycle - The state this commit keeps across attempts (see {@link CommitCycle}). This
	 * attempt adds its participants to `cycle.participants` and one disposer per participant it marks
	 * in flight under this transaction's id (see {@link Collection.beginInFlightAction}) to
	 * `cycle.inFlightDisposers`. REQUIRED, so a future caller cannot silently reintroduce the
	 * unmarked refresh the disposers exist to prevent, nor lose track of who took part. The caller
	 * owns clearing the marks, because they have to survive past this attempt.
	 * @returns every collection this attempt committed, with who holds it — empty when nothing was
	 * staged, so the attempt wrote nothing.
	 */
	private async commitOnce(transaction: Transaction, cycle: CommitCycle): Promise<ReadonlyMap<CollectionId, WriteDurability>> {
		if (isTransactionExpired(transaction.stamp)) {
			throw new Error(`Transaction expired at ${transaction.stamp.expiration}`);
		}

		// Collect collections with staged (un-synced) changes.
		const collectionData = this.stagedCollections();

		if (collectionData.length === 0) {
			// Nothing to commit is a successful commit: release the stamp as the success path does,
			// or a read-only transaction that opened one (the empty pre-stage barrier) wedges every
			// later stamp on this coordinator.
			this.stampData.delete(transaction.stamp.id);
			return new Map();
		}
		for (const { collectionId } of collectionData) {
			cycle.participants.add(collectionId);
		}
		// NOTE: this selection reads each tracker BEFORE the latches below are held, so a stage
		// that lands between the filter and the acquisition is simply not part of this commit.
		// Harmless today — a session stages and commits on one call path, so nothing races its
		// own commit. If a caller ever stages a collection concurrently with committing it,
		// re-derive the participant set inside the held span instead of filtering out here.

		// Hold every participating collection's instance latch for the WHOLE commit span —
		// snapshot, log append, the pend/commit round trips, and the local fold — so a
		// reader-driven update()/sync() on the same instance cannot interleave: without this, a
		// refresh could adopt the newly committed revision mid-flight and recordCommitted would
		// land the action at a revision storage never assigned it. Acquisition is in sorted
		// collection-id order, mirroring StorageRepo.commit's sorted block-id latch discipline
		// (db-p2p/src/storage/block-latch.ts), so two concurrent commits over overlapping
		// participant sets cannot deadlock. `Latches` is non-reentrant, so nothing inside the
		// held span may call a latched Collection method (act/update/sync/updateAndSync) on a
		// participant — the retry loop's blanket refresh in commitAttempts runs OUTSIDE
		// this span, after release.
		// NOTE: the span covers the pend/commit consensus round trips, so every latched method on
		// a participant instance (act/update/sync) queues for as long as the transactor takes.
		// Accepted: correctness needs the whole span, and the transactor's own timeouts bound it.
		// If a stalled peer is ever observed wedging unrelated readers, bound the hold instead —
		// e.g. acquire with a deadline and fail the commit rather than queueing indefinitely.
		const latchReleases: (() => void)[] = [];
		try {
			const latchOrder = [...collectionData].sort((a, b) =>
				a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0);
			for (const { collection } of latchOrder) {
				latchReleases.push(await collection.acquireLatch());
				// Mark THIS attempt's action id on each participant while its latch is held, so the
				// inter-attempt refresh in commitAttempts recognises a log entry this transaction itself
				// stored (a torn commit: the log tail landed, and either its own answer or a later
				// sweep block's reported failure), finishes that action's remaining blocks, and then
				// consumes the entry instead of replaying it into a second entry under the same id
				// (Collection.completeOwnEntry). `transaction.id` is stable across retries, so re-marking on a
				// later attempt re-states the same fact. Only participants are marked; a registered
				// non-participant is left unmarked and its refresh behaves exactly as a reader's.
				cycle.inFlightDisposers.push(collection.beginInFlightAction(transaction.id));
			}
			return await this.commitOnceLatched(transaction, collectionData, cycle);
		} finally {
			for (const release of latchReleases.reverse()) {
				release();
			}
		}
	}

	/**
	 * The body of {@link commitOnce}, run with every participating collection's instance latch
	 * held by the caller (see the acquisition comment there). Nothing in here may re-acquire a
	 * participant's latch — every Collection member it touches (snapshotPending, getPendingActions,
	 * recordCommitted, applyCommittedToCache, restorePending, clearPendingActions, tracker.reset)
	 * is latch-free by contract.
	 *
	 * `cycle` is written only on a partial landing that is retried forward: the participants this
	 * attempt committed go into `cycle.saved`, with who holds each, so the retry loop reports every
	 * later failure as the partial landing it is (see {@link reportSaved}).
	 *
	 * @returns on success, every participant with who holds it (see {@link commitOnce}).
	 */
	private async commitOnceLatched(
		transaction: Transaction,
		collectionData: { collectionId: CollectionId; collection: Collection<any> }[],
		cycle: CommitCycle
	): Promise<ReadonlyMap<CollectionId, WriteDurability>> {
		// Append each collection's staged actions to its log, then collect the
		// resulting transforms + critical (log-tail) block for consensus.
		//
		// The actions were staged directly into the trackers (Collection.act, e.g.
		// via Tree.stage) WITHOUT first appending a log entry, so — exactly as
		// execute()/applyActionsToCollection does — we materialise the log entry
		// here from each collection's pending actions. Reading raw tracker
		// transforms without a fresh log entry only ever "worked" for a
		// collection's pristine first commit (where the initial empty log block is
		// itself an uncommitted tracker insert); it broke for any collection with
		// prior committed state — a pre-synced index tree, or a second commit on
		// the same collection — whose log tail lives in storage, not the tracker.
		const allCollectionIds = collectionData.map(({ collectionId }) => collectionId);
		const collectionTransforms = new Map<CollectionId, Transforms>();
		const criticalBlocks = new Map<CollectionId, BlockId>();
		// The revision each collection's log entry was stamped with. Captured ONCE — at the log
		// append in applyActionsToCollection, the single legitimate capture point — and threaded
		// through pend, commit, and the local recordCommitted, so all four name the same number.
		const pendedRevs = new Map<CollectionId, number>();

		// A participant is never pended over a base that moved under its staged operations
		// (Collection.restageIfBasesMoved). Each re-stages its own queue only. BEFORE the snapshots
		// below, so a failed attempt restores transforms that agree with the tracker's pins; and
		// before the append loop, since a replay resets the tracker and would drop the appended
		// log entry.
		for (const { collection } of collectionData) {
			await collection.restageIfBasesMoved();
		}

		// Snapshot EVERY participating collection's staged state (transforms + pending
		// queue) BEFORE the append loop mutates any tracker. The loop appends log
		// entries sequentially, so a failure on the Nth collection must also undo the
		// 0..N-1 collections that already appended — and coordinateTransaction can fail
		// after ALL of them appended. On any throw below we restore every snapshot, so a
		// failed commit leaves each tracker exactly as it was: a retry re-appends cleanly
		// (no duplicate log entry) and a directly-staged tree's rollback (which no-ops
		// when the stamp was never tracked via applyActions) has nothing poisoned to undo.
		const preCommitSnapshots = new Map<CollectionId, CollectionSnapshot<any>>();
		for (const { collectionId, collection } of collectionData) {
			preCommitSnapshots.set(collectionId, collection.snapshotPending());
		}

		let coordResult: CoordinationResult;
		try {
			for (const { collectionId, collection } of collectionData) {
				const applyResult = await this.applyActionsToCollection(
					{ collectionId, actions: collection.getPendingActions() },
					transaction,
					allCollectionIds
				);
				if (!applyResult.success) {
					throw new Error(`Transaction commit failed: ${applyResult.error}`);
				}
				collectionTransforms.set(collectionId, applyResult.transforms!);
				criticalBlocks.set(collectionId, applyResult.logTailBlockId!);
				pendedRevs.set(collectionId, applyResult.rev!);
			}

			// What each pend carries for members to re-check (post-log-append) — see pendValidationFor.
			const validation = await this.pendValidationFor(transaction, collectionTransforms);

			// Execute consensus phases (GATHER, PEND, COMMIT)
			coordResult = await this.coordinateTransaction(
				transaction,
				validation,
				collectionTransforms,
				criticalBlocks,
				pendedRevs
			);
		} catch (err) {
			// A throw here means the failure happened BEFORE any collection could
			// durably commit (a log-append failure, or coordinateTransaction rejecting
			// unexpectedly). Nothing landed on the cluster, so roll every tracker back
			// to its pre-append snapshot — a genuinely clean rollback that leaves each
			// tracker pristine for retry (see txn-failed-commit-leaves-staged-log-entry).
			for (const { collectionId, collection } of collectionData) {
				await collection.restorePending(preCommitSnapshots.get(collectionId)!);
			}
			throw err;
		}

		if (!coordResult.success) {
			const committed = coordResult.committedCollections ?? new Map<CollectionId, WriteDurability>();
			// Keep exactly what each participant that did NOT commit sent, BEFORE the restores below
			// swap its tracker out. A refused commit is not proof nothing landed: a participant's log
			// tail is committed first and can be stored while the answer is still a failure, and
			// cancelPhase has just dropped the pending records of every block that did not land. If
			// the next refresh of that participant finds this transaction's own log entry, these are
			// the transforms that finish it (Collection.completeOwnEntry) — without them the refresh
			// can only refuse the write as torn, never save it. Copied, because until the restore
			// this is the participant's LIVE tracker state. No block digests are retained: the
			// declaration taken before the pend (declareTouchedBlocks) stays inside coordinateTransaction,
			// so a re-send declares none, and an undeclared block falls back to member-side corroboration.
			for (const { collectionId, collection } of collectionData) {
				if (committed.has(collectionId)) continue;
				collection.retainInFlightAttempt(transaction.id, {
					rev: pendedRevs.get(collectionId)!,
					transforms: copyTransforms(collectionTransforms.get(collectionId)!),
					tailId: criticalBlocks.get(collectionId)!,
				});
			}
			if (committed.size > 0) {
				// PARTIAL COMMIT: at least one collection durably committed via consensus
				// while another failed permanently. A uniform pre-append restore would
				// corrupt the committed half — re-staging its already-durable actions as
				// still-pending, so tracker memory would disagree with cluster storage.
				// Split the local handling instead, in two passes: the committed half is folded
				// first, in one await-free pass (so a committed read observes every committed
				// participant pre-fold or post-fold, as the success fold below promises), and the
				// failed half is restored after it — a restore can replay, so it is awaited, which
				// admits no interleaved stage because every participant's latch is held across
				// this span.
				for (const { collectionId, collection } of collectionData) {
					if (!committed.has(collectionId)) continue;
					// Committed → the success-path local treatment (see below): fold the
					// committed transforms into the read cache BEFORE resetting the tracker,
					// then drop the now-durable pending actions so a retry cannot re-log them.
					// NOTE: no-double-apply on retry depends on clearPendingActions() running for
					// EVERY committed collection here before any re-drive of commit(). If a committed
					// collection kept its pending queue, a subsequent commit() would re-append and
					// re-log its already-durable actions — a duplicate log entry on the winner. The
					// no-double-apply-on-retry test in transaction.spec.ts locks this.
					const rev = collection.recordCommitted(transaction.id, pendedRevs.get(collectionId)!);
					collection.applyCommittedToCache(collectionTransforms.get(collectionId)!, rev);
					collection.tracker.reset();
					collection.clearPendingActions();
				}
				for (const { collectionId, collection } of collectionData) {
					if (committed.has(collectionId)) continue;
					// Failed / never-committed → restore the pre-append snapshot so a retry
					// re-appends cleanly (no duplicate log entry).
					await collection.restorePending(preCommitSnapshots.get(collectionId)!);
				}
				const failed = [...(coordResult.failedCollections ?? new Set<CollectionId>())];
				if (coordResult.staleLoss) {
					// Every failure was a RETURNED refusal: a member behind on the block's base (the
					// durability gate's `commit-not-durable`, from a replica that has not caught up —
					// the writer's own, on a node that has just joined), or a rival that took the
					// revision slot. The siblings above have landed and cannot be rolled back, so
					// FORWARD recovery — finishing this collection — is the only way back to
					// all-or-nothing, and the retry loop already does it: the refresh between attempts
					// finds this transaction's own log entry where the tail landed and re-sends the
					// retained attempt at the same revision (Collection.completeOwnEntry), or the next
					// attempt re-pends afresh when nothing of it landed. The committed siblings are
					// recorded as saved, so every failure that still escapes is reported as the partial
					// landing it is (reportSaved), and the next attempt commits only what is still
					// staged (stagedCollections) — the durable half is never re-logged. The stamp stays
					// open for the retry; reportSaved or the success path releases it.
					// The committed siblings keep their in-flight mark until the cycle ends, so the
					// blanket refresh between attempts WALKS their log (the mark disables the tail
					// shortcut) but cannot find their own entry: recordCommitted above advanced each
					// one's held revision to the entry's own, and Log.getFrom returns only entries
					// ABOVE the held revision. Collection.consumeOwnEntry is therefore unreachable for
					// a sibling committed here, and no attempt was retained for it (the loop above
					// skips committed participants) — the refresh is a reader's, at a cost of one walk.
					for (const [collectionId, durability] of committed) {
						recordCollectionDurability(cycle.saved, collectionId, durability);
					}
					log('commit:partial-retry tx=%s committed=%o failed=%o reason=%s', transaction.id, [...committed.keys()], failed, coordResult.error);
					throw new CoordinatorStaleLossError(failed, coordResult.error);
				}
				// Half-landed on a HARD failure (the transport budget spent on a thrown fault, a
				// structural rejection): neither cleanly retryable nor cleanly abortable, so drop the
				// stamp tracking (the success path does the same at the end) and surface the
				// structured signal for reconciliation at once.
				this.stampData.delete(transaction.stamp.id);
				throw new CoordinatorPartialCommitError(committed, failed, coordResult.expired ?? coordResult.error);
			}

			// EMPTY committed set: PEND failed, or the whole commit failed cleanly with
			// nothing durable. Restore every tracker so each is pristine for retry.
			for (const { collectionId, collection } of collectionData) {
				await collection.restorePending(preCommitSnapshots.get(collectionId)!);
			}
			// Distinguish a genuine optimistic-concurrency conflict (a stale loss / pending
			// contention — retryable after a re-read) from a hard failure (unavailable transactor,
			// storage rejection, expired). Only the former is worth re-driving; the retry wrapper in
			// commit() catches CoordinatorStaleLossError and re-attempts, while a plain Error escapes
			// immediately (preserving the historical fail-fast behaviour for hard failures).
			if (coordResult.staleLoss) {
				throw new CoordinatorStaleLossError([...(coordResult.failedCollections ?? new Set(allCollectionIds))], coordResult.error);
			}
			// A validity rejection is surfaced by name and never re-driven: the retry's pend would send
			// the same content to the same checks.
			if (coordResult.rejected !== undefined) {
				throw coordResult.rejected;
			}
			// An expiry is surfaced by name and never re-driven: the retry's pend would carry an
			// expiration from the same clock.
			if (coordResult.expired !== undefined) {
				throw coordResult.expired;
			}
			// So is a promise shortfall: the retry's pend would meet the same silent members.
			if (coordResult.shortfall !== undefined) {
				throw coordResult.shortfall;
			}
			if (coordResult.tooLarge !== undefined) {
				throw coordResult.tooLarge;
			}
			throw new Error(`Transaction commit failed: ${coordResult.error}`);
		}

		// Advance actionContext, fold the committed transforms into each
		// collection's read cache, reset the tracker, and drop the now-committed
		// pending actions. Order matters: cache the committed blocks BEFORE
		// resetting the tracker (the transforms are read live), so a collection
		// with prior committed state (a pre-synced index, or any second commit)
		// serves the new revision instead of the stale cached one. Clearing
		// pending keeps a subsequent commit from re-logging these actions.
		// NOTE: this fold loop must stay await-free — session-mode publish relies on it being
		// event-loop-atomic across collections (see OptimysticModule's readCommittedSnapshot audit).
		for (const { collectionId, collection } of collectionData) {
			const rev = collection.recordCommitted(transaction.id, pendedRevs.get(collectionId)!);
			collection.applyCommittedToCache(collectionTransforms.get(collectionId)!, rev);
			collection.tracker.reset();
			collection.clearPendingActions();
		}

		// Clean up stamp tracking data. The reset+clear above is collection-wide, which is safe
		// precisely because the coordinator enforces at most ONE open stamp (the invariant on
		// stampData): no sibling stamp's snapshot exists to go stale against this commit.
		this.stampData.delete(transaction.stamp.id);
		return coordResult.committedCollections;
	}

	/**
	 * Rollback a transaction (undo only the given stampId's applied actions).
	 *
	 * Restores each collection's staged state — tracker transforms and the pending action
	 * queue — to the snapshot taken before the stampId's first applyActions call. Because the
	 * coordinator allows at most ONE open stamp (the invariant on {@link stampData}), there is
	 * never a sibling stamp whose staged state that restore could clobber, so rewinding is the
	 * whole of rollback.
	 *
	 * Rolling back a stamp with no tracked entry — never opened, or already released by a commit
	 * or an earlier rollback — is a no-op.
	 *
	 * NOTE: this method is complete only while that invariant holds. If the guard is ever relaxed
	 * to permit concurrent stamps, a plain rewind stops being enough — it would discard a sibling
	 * stamp's staged state along with this one — and the per-collection-earliest-capture plus
	 * survivor-replay this method used to carry has to come back. Recover it from commit 26718f8a
	 * (`ticket(implement): coordinator-drop-multi-stamp-replay-machinery`) rather than re-deriving.
	 *
	 * @param stampId - The transaction stamp ID to rollback
	 */
	async rollback(stampId: string): Promise<void> {
		// NOTE: unlike the commit path, this overwrites BOTH halves of each participant's staged
		// state — tracker transforms AND the pending action queue — WITHOUT holding their instance
		// latches. Safe today because a session drives abort and commit from one call path, so a
		// rollback cannot overlap a commit span on the same collections. The hazard class is the
		// same one the transforms-only reset already carried: a concurrent act/sync would already
		// have raced `tracker.reset`. If rollback ever becomes reachable concurrently with a commit
		// (a background abort, a second coordinator sharing collection instances), latch the
		// participants here the way commitOnce does.
		const data = this.stampData.get(stampId);
		if (!data) return;

		this.stampData.delete(stampId);

		// Restore each captured collection — transforms AND pending queue together, so the
		// rolled-back stamp's actions leave the queue instead of being written into the next
		// transaction's durable log entry. `restorePending` deep-copies the transforms itself,
		// so no structuredClone here. Restoring through the CAPTURED instance (rather than
		// re-looking-up by id) is what keeps a mid-transaction instance swap under one id from
		// pushing the old instance's staged state onto the new one.
		// NOTE: this also discards actions staged OUTSIDE any tracked stamp (the Tree.stage /
		// deferred-DML path, which calls Collection.act directly and creates no stampData entry)
		// that landed after that collection's capture — including on a collection registered
		// mid-transaction, whose capture is simply later than the eagerly-captured ones.
		// Accepted: the tracker half already discards their transforms, and symmetric is the safer
		// state — leaving such an action queued while its transforms are gone is exactly the
		// phantom that a conflicting sync's replayActions would resurrect as live data.
		// Awaited: a restore across a change to the collection's sealed segments replays them
		// (Collection.restorePending), and the single-call-path assumption above is what keeps a
		// stage from landing on the collection while that replay runs.
		for (const [collection, snapshot] of data.preSnapshot) {
			await collection.restorePending(snapshot);
		}
	}

	/**
	 * Get current transforms from all collections.
	 *
	 * This collects transforms from each collection's tracker. Useful for
	 * validation scenarios where transforms need to be extracted after
	 * engine execution.
	 */
	getTransforms(): Map<CollectionId, Transforms> {
		const transforms = new Map<CollectionId, Transforms>();
		for (const [collectionId, collection] of this.collections.entries()) {
			const collectionTransforms = collection.tracker.transforms;
			const hasChanges =
				Object.keys(collectionTransforms.inserts ?? {}).length > 0 ||
				Object.keys(collectionTransforms.updates ?? {}).length > 0 ||
				(collectionTransforms.deletes?.length ?? 0) > 0;
			if (hasChanges) {
				transforms.set(collectionId, collectionTransforms);
			}
		}
		return transforms;
	}

	/**
	 * Reset all collection trackers.
	 *
	 * This clears pending transforms from all collections. Useful for
	 * cleaning up after validation or when starting a new transaction.
	 */
	resetTransforms(): void {
		for (const collection of this.collections.values()) {
			collection.tracker.reset();
		}
	}

	/**
	 * Collect read dependencies from all participating collections.
	 */
	getReadDependencies(): ReadDependency[] {
		const reads: ReadDependency[] = [];
		for (const collection of this.collections.values()) {
			reads.push(...collection.getReadDependencies());
		}
		return reads;
	}

	/**
	 * Clear read dependencies from all collections.
	 */
	clearReadDependencies(): void {
		for (const collection of this.collections.values()) {
			collection.clearReadDependencies();
		}
	}

	/**
	 * Execute a fully-formed transaction.
	 *
	 * This is called with a complete transaction (e.g., from Quereus).
	 *
	 * @param transaction - The transaction to execute
	 * @param engine - The engine to use for executing the transaction
	 * @returns Execution result with actions and results
	 */
	async execute(transaction: Transaction, engine: ITransactionEngine): Promise<ExecutionResult> {
		const trxId = transaction.id;
		const t0 = Date.now();

		if (isTransactionExpired(transaction.stamp)) {
			return { success: false, error: `Transaction expired at ${transaction.stamp.expiration}` };
		}

		// 1. Validate engine matches transaction
		// Note: We don't enforce this strictly since the engine is passed in explicitly
		// The caller is responsible for ensuring the correct engine is used

		const tEngine = Date.now();
		const result = await engine.execute(transaction);
		const engineMs = Date.now() - tEngine;
		if (!result.success) {
			log('execute:done trxId=%s engine=%dms success=false total=%dms', trxId, engineMs, Date.now() - t0);
			return result;
		}

		if (!result.actions || result.actions.length === 0) {
			return { success: true }; // Nothing to do
		}

		// At most one open stamp (see the invariant on stampData). execute() reports failures as
		// results rather than throws (matching its conversion of applyActions' "Collection not
		// found" throw below), so the refusal is a failure result here where applyActions and
		// commit throw.
		//
		// Deliberately BELOW the empty-actions short-circuit above: a transaction that stages
		// nothing cannot mix its state with the open stamp's, so a read-only execute is allowed to
		// run alongside one. Hoisting this to the top of the method would refuse those too — see
		// the "does not refuse a second stamp that stages nothing" case in
		// coordinator-single-stamp.spec.ts. The engine has already run by this point, which costs
		// nothing here: reaching this line means the engine was a pure translator (a
		// side-effecting engine returns EMPTY actions and short-circuits above, and its own
		// staging goes through applyActions, which guards).
		const openStamp = this.openStampOtherThan(transaction.stamp.id);
		if (openStamp !== undefined) {
			return { success: false, error: new CoordinatorConcurrentStampError(openStamp, transaction.stamp.id).message };
		}

		// 1b. Stage the returned actions into the collection trackers.
		//
		// Reaching here means the engine RETURNED non-empty actions — i.e. the pure-
		// translator model (see the ITransactionEngine contract): it translated the
		// statements but did NOT apply them. So THIS path owns application — we stage the
		// actions here via applyActions() (which also snapshots/tracks the stamp for
		// rollback) BEFORE the loop below reads each tracker's transforms to materialise
		// the log entry. (Previously ActionsEngine applied as a side effect and this
		// method merely re-read the already-staged trackers; that side effect is gone, so
		// the application must happen explicitly here. A side-effecting engine that
		// applied internally would instead return EMPTY actions and short-circuit at the
		// empty-actions check above.)
		//
		// applyActions() throws if a referenced collection is not registered — the same
		// "Collection not found" the engine's side-effecting apply used to surface. Convert
		// it back into a failure result so execute() keeps its return contract.

		// Pre-staging snapshot, one per DISTINCT participating collection, captured here so the
		// partial-commit branch below can unwind the collections that did NOT land. The unwind
		// point is "before execute() staged anything", not "before the log append": unlike
		// commit(), a re-drive of execute() re-runs the engine and re-stages every collection it
		// names, so leaving this attempt's actions in the pending queue would double-stage them.
		// That is also exactly the state rollback() would have restored, which is why dropping
		// the stamp on that branch loses nothing.
		//
		// snapshotPending() is synchronous and latch-free — keep it that way: NO await may sit
		// between this loop and the applyActions() call below, or an interleaved stage would be
		// captured inside the snapshot. Because the whole loop runs before ANY staging, an engine
		// naming one collection in two batches yields the state before EITHER batch whichever
		// batch wins the key — so the dedupe is a COST guard (snapshotPending deep-copies the
		// transforms and structuredClones the action context), not a correctness one. An
		// unregistered collection is skipped; applyActions throws on it moments later and the
		// catch below converts that to a failure result, so the map is never read.
		//
		// NOTE: this runs unconditionally, so the overwhelmingly common all-succeed execute() pays
		// one deep transforms copy + one structuredClone of the action context per participant to
		// serve a rare branch. Unmeasured, and symmetric with commitOnceLatched, which pays the
		// same on every commit. If execute() ever shows up hot in a profile, the way out is a
		// copy-on-first-stage snapshot, not dropping the restore.
		const preStageSnapshots = new Map<CollectionId, CollectionSnapshot<any>>();
		for (const { collectionId } of result.actions) {
			if (preStageSnapshots.has(collectionId)) continue;
			const collection = this.collections.get(collectionId);
			if (collection) preStageSnapshots.set(collectionId, collection.snapshotPending());
		}

		try {
			await this.applyActions(result.actions, transaction.stamp.id);
		} catch (error) {
			const engineMs = Date.now() - tEngine;
			log('execute:done trxId=%s engine=%dms apply-failed=true total=%dms', trxId, engineMs, Date.now() - t0);
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}

		// 2. Build a log entry per collection from the now-staged tracker transforms.
		//
		// NOTE: like commit(), this loop appends a log entry into each collection's tracker.
		// What happens to that appended-but-uncommitted state on failure depends on whether
		// anything landed durably:
		//
		//  - Failure BEFORE any durable commit (engine failure, log-append failure, or a
		//    coordination failure with an empty committed set): the failure returns below do NOT
		//    restore, so the appended entries survive in the trackers and `stampData` is kept.
		//    That is deliberate — the actions were tracked via applyActions(), so rollback(stampId)
		//    is a valid AND complete recovery there: its capture predates this staging and covers
		//    every registered collection, including ones this call never touched. Do not add blind
		//    restores to these paths.
		//  - PARTIAL landing (some collections durably committed, others lost): the committed half
		//    gets the success-path fold, the failed half is restored to the pre-staging snapshot
		//    captured above, and `stampData` is dropped — because an all-or-nothing rollback() run
		//    after a partial landing would rewind the collection that DID commit, re-staging
		//    already-durable actions. Same disposition as commitOnceLatched. See that branch below.
		const tApply = Date.now();
		const collectionTransforms = new Map<CollectionId, Transforms>();
		const criticalBlocks = new Map<CollectionId, BlockId>();
		const actionResults = new Map<CollectionId, any[]>();

		// Coalesce the engine's batches to ONE per collection. Nothing stops an engine from
		// emitting two `CollectionActions` entries naming the same collection (with the built-in
		// ActionsEngine that is just two statements against one table), but everything downstream
		// of here is written per-PARTICIPANT, not per-batch: the apply loop would append two log
		// entries stamped with the same revision (the revision only advances at recordCommitted),
		// the id-keyed maps below would discard the first batch's entry, and both folds would call
		// recordCommitted twice — the second throwing on the revision it already advanced past,
		// AFTER the transaction committed durably. One log entry per collection per transaction is
		// the invariant commitOnceLatched holds by construction (it appends one entry carrying that
		// collection's whole pending queue), so match it here by grouping instead.
		//
		// First-appearance collection order, and each collection's own actions in the order the
		// engine emitted them. The STAGING above deliberately ran on the original, un-coalesced
		// list: staging order is what a re-executing validator reproduces, so it stays exactly as
		// the engine emitted it. Grouping is only for the log-append and fold phase below.
		const batches = new Map<CollectionId, unknown[]>();
		for (const { collectionId, actions } of result.actions) {
			const existing = batches.get(collectionId);
			if (existing) existing.push(...actions);
			else batches.set(collectionId, [...actions]);
		}
		const allCollectionIds = [...batches.keys()];
		// Same single-capture rev threading as commitOnce: stamped at the log append below,
		// named again at pend, commit, and recordCommitted.
		const pendedRevs = new Map<CollectionId, number>();

		// Hold each participating collection's instance latch for the commit span, same
		// discipline as commitOnce (sorted acquisition; see the comment there). Acquired only
		// AFTER applyActions above: collection.act takes the same non-reentrant instance latch
		// itself, so latching earlier would deadlock. The list must be DISTINCT — taking one
		// instance's latch twice would also deadlock — which the grouping above now guarantees
		// upstream (`allCollectionIds` is `batches.keys()`) instead of at the acquisition.
		// Released in the finally: execute has early failure returns.
		const latchReleases: (() => void)[] = [];
		try {
			// NOTE: deadlock-freedom against a concurrent commitOnce needs BOTH paths to acquire in
			// the SAME order, not merely each in a sorted one. `CollectionId` is a string, so this
			// default `.sort()` and commitOnce's explicit `<`/`>` comparator agree today. If either
			// spelling changes — a custom comparator, a non-string id — change both together.
			for (const collectionId of [...allCollectionIds].sort()) {
				const collection = this.collections.get(collectionId);
				if (collection) {
					latchReleases.push(await collection.acquireLatch());
				}
			}

			// Same pre-pend rule as commitOnceLatched: no participant is pended over a moved base.
			// Under the latches and before the append loop, which a replay's tracker reset would undo.
			for (const collectionId of allCollectionIds) {
				await this.collections.get(collectionId)?.restageIfBasesMoved();
			}

			for (const [collectionId, actions] of batches) {
				const applyResult = await this.applyActionsToCollection(
					{ collectionId, actions },
					transaction,
					allCollectionIds
				);

				if (!applyResult.success) {
					return { success: false, error: applyResult.error };
				}

				collectionTransforms.set(collectionId, applyResult.transforms!);
				criticalBlocks.set(collectionId, applyResult.logTailBlockId!);
				actionResults.set(collectionId, applyResult.results!);
				pendedRevs.set(collectionId, applyResult.rev!);
			}

			// 3. What each pend carries for members to re-check (see pendValidationFor).
			const validation = await this.pendValidationFor(transaction, collectionTransforms);

			const applyMs = Date.now() - tApply;

			// 4. Coordinate (GATHER if multi-collection)
			const tCoord = Date.now();
			const coordResult = await this.coordinateTransaction(
				transaction,
				validation,
				collectionTransforms,
				criticalBlocks,
				pendedRevs
			);

			const coordMs = Date.now() - tCoord;
			if (!coordResult.success) {
				log('execute:done trxId=%s engine=%dms apply=%dms coordinate=%dms success=false total=%dms', trxId, engineMs, applyMs, coordMs, Date.now() - t0);
				// Stop lying to the caller about a partial commit: if some collections durably
				// committed, surface that set. The committed subset gets the full success-path
				// local treatment (the same four steps as commitOnceLatched's partial-commit fold,
				// in the same order — see the success fold below) so its trackers, read caches and
				// pending queues aren't left mis-tracking already-durable state; the failed subset
				// is unwound to its pre-staging snapshot, and the stamp tracking is dropped so no
				// unsafe all-or-nothing undo handle survives (rollback() would rewind the winner).
				// Two passes, as in commitOnceLatched: the committed subset's fold is kept
				// await-free for the same reason the success fold is, and the failed subset's
				// restore comes after it. That restore is awaited — it can replay the collection's
				// sealed segments — and the await admits no interleaved stage, because every
				// participant's latch is held across this span (restorePending stays latch-free by
				// contract and relies on exactly that).
				// NOTE: execute() has no retry loop at all, so a returned refusal after a sibling
				// committed is reported here at once, where commit() would re-drive the refused
				// collection forward (the partial-retry branch of commitOnceLatched). No production
				// caller reaches this today — the plugin's session mode stages through applyActions
				// and commits through commit() — so the split window is documented, not closed
				// (docs/transactions.md). If a host ever commits multi-collection transactions
				// through execute(), route its coordination through commit()'s retry rather than
				// duplicating that recovery here.
				const committed = coordResult.committedCollections ?? new Map<CollectionId, WriteDurability>();
				if (committed.size > 0) {
					for (const collectionId of batches.keys()) {
						const collection = this.collections.get(collectionId);
						if (!collection || !committed.has(collectionId)) continue;
						const rev = collection.recordCommitted(transaction.id, pendedRevs.get(collectionId)!);
						collection.applyCommittedToCache(collectionTransforms.get(collectionId)!, rev);
						collection.tracker.reset();
						collection.clearPendingActions();
					}
					for (const collectionId of batches.keys()) {
						const collection = this.collections.get(collectionId);
						if (!collection || committed.has(collectionId)) continue;
						// NOTE: blind overwrite of this collection's staged state — anything
						// staged on it between the pre-stage snapshot above and here is discarded.
						// No sibling stamp can be that writer (at most one stamp is open), so the
						// only source is the untracked Tree.stage / Collection.act path, and this
						// is the same single-call-path assumption rollback() documents. It cannot
						// be softened by re-applying those actions here: collection.act takes the
						// same non-reentrant instance latch this span already holds.
						const snapshot = preStageSnapshots.get(collectionId);
						if (snapshot) await collection.restorePending(snapshot);
					}
					// The undo handle is now unsafe: rollback() is all-or-nothing and would rewind
					// the collections that DID durably commit. Drop it, matching commitOnceLatched.
					// Dropping outright (no tombstone) is safe because the coordinator enforces at
					// most ONE open stamp (the invariant on stampData): no sibling stamp exists,
					// so nothing else can later look for this entry and be misled by its absence.
					this.stampData.delete(transaction.stamp.id);
				}
				return {
					success: false,
					error: coordResult.error,
					...(committed.size > 0
						? { committedCollections: [...committed.keys()], durability: transactionDurability(committed) }
						: {}),
					failedCollections: coordResult.failedCollections ? [...coordResult.failedCollections] : undefined,
				};
			}

			// 5. Advance actionContext, fold the committed transforms into each collection's read
			// cache, reset the tracker, and drop the now-committed pending actions — the same four
			// steps, in the same order, as commitOnceLatched's success fold. Order matters: cache
			// the committed blocks BEFORE resetting the tracker (the transforms are read live), so a
			// collection with prior committed state serves the new revision instead of the stale
			// cached one. Clearing pending keeps a subsequent commit() on this same collection from
			// re-logging these already-durable actions.
			// NOTE: this fold loop must stay await-free, for the same reason commitOnce's does —
			// session-mode publish relies on it being event-loop-atomic across collections.
			for (const collectionId of batches.keys()) {
				const collection = this.collections.get(collectionId);
				if (collection) {
					const rev = collection.recordCommitted(transaction.id, pendedRevs.get(collectionId)!);
					collection.applyCommittedToCache(collectionTransforms.get(collectionId)!, rev);
					collection.tracker.reset();
					collection.clearPendingActions();
				}
			}

			// Clean up stamp tracking data
			this.stampData.delete(transaction.stamp.id);
			const durability = writtenDurability(coordResult.committedCollections);

			// 6. Return results from actions.
			// `actions` is the engine's ORIGINAL batch list, un-coalesced — the field is documented
			// as "the actions produced by executing the transaction", and the caller's own shape is
			// the honest answer to that. `results` is keyed by collection id, so the two are NOT
			// positionally aligned when an engine named one collection in more than one batch; join
			// them on collectionId, never by index.
			log('execute:done trxId=%s engine=%dms apply=%dms coordinate=%dms total=%dms', trxId, engineMs, applyMs, coordMs, Date.now() - t0);
			return {
				success: true,
				actions: result.actions,
				results: actionResults,
				...(durability === undefined ? {} : { durability })
			};
		} finally {
			for (const release of latchReleases.reverse()) {
				release();
			}
		}
	}

	/**
	 * Apply actions to a collection.
	 *
	 * This runs the action handlers, writes to the log, and collects transforms.
	 */
	private async applyActionsToCollection(
		collectionActions: CollectionActions,
		transaction: Transaction,
		allCollectionIds: CollectionId[]
	): Promise<{
		success: boolean;
		transforms?: Transforms;
		logTailBlockId?: BlockId;
		/** The revision the log entry was stamped with — the ONE number the pend, the commit,
		 * and the local recordCommitted must all repeat (see the pendedRevs maps upstream). */
		rev?: number;
		results?: any[];
		error?: string;
	}> {
		const collection = this.collections.get(collectionActions.collectionId);
		if (!collection) {
			return {
				success: false,
				error: `Collection not found: ${collectionActions.collectionId}`
			};
		}

		// At this point, actions have already been executed through collection.act()
		// (via the engine or the vtab's staging path). The collection's tracker
		// already has the transforms, and the actions are in the pending buffer.

		// Get transforms from the collection's tracker
		const transforms = collection.tracker.transforms;

		// Generate action ID from transaction ID
		const actionId = transaction.id;
		const newRev = collection.getNextRev();

		// Write actions to the collection's log to get the log tail block ID. The append must be a
		// fixed function of this write and the revision it requests, because a refused commit is
		// retried under the same action id and — when nothing else committed in between — at the
		// same revision, and storage keys a saved block revision by `(action id, revision)`. So any
		// data block the append mints takes the id an earlier attempt at this revision minted
		// (Collection.logAppendBlockIds), and the entry is stamped with the transaction's own
		// timestamp, which is fixed at BEGIN and already stable across attempts, rather than with
		// the time of the attempt.
		//
		// NOTE: execute() reaches this method without marking its transaction in flight, so it mints
		// afresh every time — correct today, because it re-runs the engine and re-stages, so a
		// re-drive of it is a DIFFERENT write, and because nothing re-drives it under one transaction
		// (it returns its failure rather than looping). If execute() ever grows a retry that reuses
		// the transaction id, it must mark each participant in flight the way commitOnce does, or it
		// reintroduces exactly the divergence logAppendBlockIds closes.
		const log = await Log.open(collection.tracker, collectionActions.collectionId,
			{ newDataBlockId: collection.logAppendBlockIds(collection.tracker, actionId, newRev) });
		if (!log) {
			return {
				success: false,
				error: `Log not found for collection ${collectionActions.collectionId}`
			};
		}

		// Add actions to log (this updates the tracker with log block changes).
		// Persist the transaction's read set on the entry so a later invalidation cascade can
		// discover this action's read-dependents (see ActionEntry.reads). The whole transaction's
		// reads are recorded on every collection's entry: a read may target a block in another
		// collection, and the cascade matches read-dependents by (blockId, revision) regardless of
		// which collection's log the dependent landed in.
		// NOTE: `allCollectionIds` names the participants of THIS attempt, and a retry's participant
		// set can be SMALLER than the first attempt's. After a torn commit, the participant whose
		// log entry landed finishes that action on the inter-attempt refresh — landing the blocks
		// the refused commit left behind, at the same id and revision — and only then consumes the
		// entry (Collection.completeOwnEntry), emptying its pending queue and resetting its tracker,
		// so commitOnce's non-empty-transforms filter drops it from the next attempt. The retry's
		// entries therefore list only the REMAINING participants, while the torn participant's
		// already-durable entry lists them all — one transaction id, two different
		// `allCollectionIds` values across its entries. Nothing today keys off that list for
		// correctness; a cross-collection invalidation cascade that treats it as "the definitive
		// participant set of this transaction" must union it across the transaction's entries
		// rather than trusting any single one.
		const addResult = await log.addActions(
			collectionActions.actions,
			actionId,
			newRev,
			() => blockIdsForTransforms(transforms),
			{ collectionIds: allCollectionIds, reads: transaction.reads, timestamp: transaction.stamp.timestamp }
		);

		// Return the transforms and log tail block ID
		return {
			success: true,
			transforms,
			logTailBlockId: addResult.tailPath.block.header.id,
			rev: newRev,
			results: [] // TODO: Collect results from action handlers when we support read operations
		};
	}

	/**
	 * Coordinate a transaction across multiple collections.
	 *
	 * @param transaction - The transaction to coordinate
	 * @param validation - What every pend carries for members to re-check, or undefined for an
	 * unvalidated pend (see {@link pendValidationFor})
	 * @param collectionTransforms - Map of collectionId to its transforms
	 * @param criticalBlocks - Map of collectionId to its log tail blockId
	 * @param pendedRevs - Per collection, the revision its log entry was stamped with (from
	 * applyActionsToCollection) — repeated verbatim on the pend and commit requests so storage
	 * and the local record name the same number.
	 */
	private async coordinateTransaction(
		transaction: Transaction,
		validation: PendRequest['validation'],
		collectionTransforms: Map<CollectionId, Transforms>,
		criticalBlocks: Map<CollectionId, BlockId>,
		pendedRevs: ReadonlyMap<CollectionId, number>
	): Promise<CoordinationResult> {
		const trxId = transaction.id;
		const t0 = Date.now();

		// Before anything is sent: one materialization of every block the transaction touches, measured
		// against MAX_BLOCK_BYTES here and declared on the commit below.
		const described = await this.declareTouchedBlocks(collectionTransforms);
		if (!described.success) {
			log('trx:phases trxId=%s refused before sending: %s', trxId, described.error);
			return described;
		}

		// 1. GATHER phase: collect critical cluster nominees (skip if single collection)
		const criticalBlockIds = Array.from(criticalBlocks.values());
		const tGather = Date.now();
		const superclusterNominees = await this.gatherPhase(criticalBlockIds);
		const gatherMs = Date.now() - tGather;

		// 2. PEND phase: distribute to all block clusters
		const tPend = Date.now();
		const pendResult = await this.pendPhase(
			transaction,
			validation,
			collectionTransforms,
			pendedRevs,
			superclusterNominees
		);
		const pendMs = Date.now() - tPend;
		if (!pendResult.success) {
			log('trx:phases trxId=%s gather=%dms pend=%dms (failed) total=%dms', trxId, gatherMs, pendMs, Date.now() - t0);
			return pendResult;
		}

		// 3. COMMIT phase: commit to all critical blocks (with retry for forward recovery)
		const tCommit = Date.now();
		const commitResult = await this.commitPhase(
			transaction.id as ActionId,
			criticalBlockIds,
			pendResult.pendedBlockIds,
			pendedRevs,
			described.declared
		);
		const commitMs = Date.now() - tCommit;
		if (!commitResult.success) {
			// Targeted cancel: only cancel collections that are still pending (not already committed)
			await this.cancelPhase(
				transaction.id as ActionId,
				pendResult.pendedBlockIds,
				commitResult.committedCollections
			);
			log('trx:phases trxId=%s gather=%dms pend=%dms commit=%dms (failed) total=%dms', trxId, gatherMs, pendMs, commitMs, Date.now() - t0);
			// Surface the committed/failed partition so commit()/execute() can report which
			// collections durably landed. A non-empty committedCollections is a PARTIAL commit:
			// those collections cannot be rolled back and the caller must reconcile.
			return {
				success: false,
				error: commitResult.error,
				committedCollections: commitResult.committedCollections,
				failedCollections: commitResult.failedCollections,
				staleLoss: commitResult.staleLoss,
				...(commitResult.expired === undefined ? {} : { expired: commitResult.expired }),
			};
		}

		// 4. PROPAGATE and CHECKPOINT phases are handled by clusters automatically
		// (as per user's note: "managed by each cluster, the client doesn't have to worry about them")

		log('trx:phases trxId=%s gather=%dms pend=%dms commit=%dms total=%dms', trxId, gatherMs, pendMs, commitMs, Date.now() - t0);
		return { success: true, committedCollections: commitResult.committedCollections };
	}

	/**
	 * GATHER phase: Collect nominees from critical clusters.
	 *
	 * Skip if only one collection affected (single-collection consensus).
	 *
	 * @param criticalBlockIds - Block IDs of all log tails
	 * @returns Set of peer IDs to use for consensus, or null for single-collection
	 */
	private async gatherPhase(
		criticalBlockIds: readonly BlockId[]
	): Promise<ReadonlySet<PeerId> | null> {
		// Skip GATHER if only one collection affected
		if (criticalBlockIds.length === 1) {
			return null; // Use normal single-collection consensus
		}

		// Check if transactor supports cluster queries (optional method)
		if (!this.transactor.queryClusterNominees) {
			// Transactor doesn't support cluster queries - proceed without supercluster
			return null;
		}

		// Query each critical cluster for their nominees and merge into supercluster
		const nomineePromises = criticalBlockIds.map(blockId =>
			this.transactor.queryClusterNominees!(blockId)
		);
		const results = await Promise.all(nomineePromises);

		// Merge all nominees into a single set, deduped by peer identity. Each
		// queryClusterNominees builds a fresh PeerId object per call (peerIdFromString),
		// so a Set keyed by object reference would keep the same physical peer twice when
		// it nominates for two critical clusters. Key by toString() to collapse duplicates.
		const byId = results.reduce(
			(acc, result) => {
				result.nominees.forEach(nominee => acc.set(nominee.toString(), nominee));
				return acc;
			},
			new Map<string, PeerId>()
		);

		return new Set(byId.values());
	}

	/**
	 * One local materialization of every block each collection's transforms touch
	 * ({@link describeTouchedBlocks}), taken before anything is sent. A block the write would leave
	 * over `MAX_BLOCK_BYTES` refuses the transaction here, as a pend-phase failure carrying the
	 * {@link BlockTooLargeError} — the same shape as a pend too large to send, so `commit` throws it by
	 * name and `execute` reports it as a failure. Otherwise each collection's digests are kept as its
	 * commit's declaration ({@link commitRequestFor}), so the commit does not materialize again.
	 *
	 * Purely local: each collection's tracker holds this transaction's staged transforms until the commit
	 * succeeds, under the instance latch the commit span holds, and the pend names its bases from the
	 * same pins ({@link pendRequestFor}). A collection missing from the registry is skipped, for the pend
	 * to report as it always has.
	 */
	private async declareTouchedBlocks(
		collectionTransforms: ReadonlyMap<CollectionId, Transforms>
	): Promise<{ success: true; declared: DeclaredDigests } | PendPhaseFailure> {
		const declared = new Map<CollectionId, BlockContentDigests>();
		for (const [collectionId, transforms] of collectionTransforms) {
			const collection = this.collections.get(collectionId);
			if (!collection) continue;
			const touched = await describeTouchedBlocks(collection.tracker, blockIdsForTransforms(transforms));
			const tooLarge = oversizedBlock(touched.bytes);
			if (tooLarge) return pendFailure([tooLarge]);
			declared.set(collectionId, touched.digests);
		}
		return { success: true, declared };
	}

	/**
	 * PEND phase: Distribute transaction to all affected block clusters.
	 *
	 * Two or more collections go as ONE request when the transactor can send them so
	 * ({@link pendTogether}); otherwise, and for one collection, each collection is pended on its own.
	 *
	 * @param transaction - The transaction being pended (its id names the action; its aged
	 * priority rides on an unvalidated pend)
	 * @param validation - What every pend carries for members to re-check, or undefined for an
	 * unvalidated pend (see {@link pendValidationFor})
	 * @param collectionTransforms - Map of collectionId to its transforms
	 * @param pendedRevs - Per collection, the revision its log entry was stamped with — the pend
	 * request repeats it verbatim rather than recomputing from the collection (a recompute after
	 * the append could name a different number if the collection refreshed in between).
	 * @param superclusterNominees - Nominees for multi-collection consensus (null for single-collection)
	 */
	private async pendPhase(
		transaction: Transaction,
		validation: PendRequest['validation'],
		collectionTransforms: ReadonlyMap<CollectionId, Transforms>,
		pendedRevs: ReadonlyMap<CollectionId, number>,
		superclusterNominees: ReadonlySet<PeerId> | null
	): Promise<{ success: true; pendedBlockIds: Map<CollectionId, BlockId[]> } | PendPhaseFailure> {
		if (collectionTransforms.size === 0) {
			return { success: false, error: 'No transforms to pend' };
		}

		const actionId = transaction.id as ActionId;
		const nominees = superclusterNominees ? Array.from(superclusterNominees) : undefined;
		// Both methods, never the pend alone: the batched pend's mark promises that the commit goes as one
		// request too (`PendRequest.soleReservation`), which only `commitMany` can keep.
		if (collectionTransforms.size > 1 && this.transactor.pendMany && this.transactor.commitMany) {
			const together = await this.pendTogether(transaction, validation, collectionTransforms, pendedRevs, actionId, nominees);
			if (together !== undefined) return together;
		}

		// A one-collection transaction pends once and commits that one collection (commitPhase), as a
		// `Collection.sync` write does, so its pend may say so (`PendRequest.soleReservation`). Two or
		// more pended one by one never may: each collection's commit can land on its own, and a late
		// refusal of another collection's pend would surface after it.
		const sole = collectionTransforms.size === 1;

		// Fan out the independent per-collection pends concurrently. Each settles to a
		// { collectionId, blockIds } on success, or rejects with the per-collection reason.
		// NOTE: unbounded fan-out — one concurrent coordinator round-trip per collection.
		// Transactions touch few collections today; if one ever spans very many, bound this
		// with a concurrency limiter so peak in-flight round-trips stays sane. Same for commitPhase.
		const outcomes = await Promise.allSettled(
			Array.from(collectionTransforms.entries()).map(([collectionId, transforms]) =>
				this.pendCollection(transaction, validation, collectionId, transforms, pendedRevs.get(collectionId)!, actionId, nominees, sole)
			)
		);

		// Partition settled results: every collection that DID pend (keyed with its block ids), and
		// every reason one did not, classified together (pendFailure) independent of iteration order.
		const pendedBlockIds = new Map<CollectionId, BlockId[]>();
		const reasons: unknown[] = [];
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') {
				pendedBlockIds.set(outcome.value.collectionId, outcome.value.blockIds);
			} else {
				reasons.push(outcome.reason);
			}
		}

		if (reasons.length > 0) {
			// Any failure aborts the whole pend. With concurrency several collections may
			// have pended in parallel, so cancel EVERY successfully-pended collection — not
			// only those started before the failure. Cancels are best-effort (cancelPhase
			// swallows their errors) so they cannot mask the original pend failure.
			await this.cancelPhase(actionId, pendedBlockIds);
			return pendFailure(reasons);
		}

		return { success: true, pendedBlockIds };
	}

	/**
	 * Pends every collection as ONE request ({@link ITransactor.pendMany}): one consensus record,
	 * answered together. Every request is marked the action's only reservation
	 * (`PendRequest.soleReservation`) — together they are, and their commit goes as one request to the
	 * same coordinator ({@link commitTogether}) — so a coordinator may hold the pend's decision back for
	 * the commit to carry, and a member that refuses any collection's pend late refuses the action's one
	 * commit record before anything of it is durable.
	 *
	 * - **Success**: every collection is pended, with its own blocks.
	 * - **Refusal**: classified as one collection's refusal is ({@link pendRefusalError}), once for the
	 *   batch. `pendMany` cancelled every block, so nothing is left pended.
	 * - **Throw** (a transactor other than `NetworkTransactor`, which answers a throw with `undefined`):
	 *   a hard failure, as a thrown pend is. What was pended is unknown, so every collection's blocks are
	 *   cancelled.
	 * - **`undefined`**: they could not go as one, and nothing of them is pended. {@link pendPhase} then
	 *   pends each collection on its own with requests rebuilt WITHOUT the mark. The marked requests are
	 *   never re-sent one by one: each carries every block of its collection, so `NetworkTransactor.pend`
	 *   would keep the mark, and one collection's late refusal could then surface after a sibling's commit
	 *   landed — the tear the mark exists to prevent. Also `undefined` when a collection is missing from
	 *   the registry, so that the per-collection path reports it as it always has.
	 */
	private async pendTogether(
		transaction: Transaction,
		validation: PendRequest['validation'],
		collectionTransforms: ReadonlyMap<CollectionId, Transforms>,
		pendedRevs: ReadonlyMap<CollectionId, number>,
		actionId: ActionId,
		nominees: PeerId[] | undefined
	): Promise<{ success: true; pendedBlockIds: Map<CollectionId, BlockId[]> } | PendPhaseFailure | undefined> {
		const requests: PendRequest[] = [];
		for (const [collectionId, transforms] of collectionTransforms) {
			const collection = this.collections.get(collectionId);
			if (!collection) return undefined;
			requests.push(this.pendRequestFor(transaction, validation, collection, transforms, pendedRevs.get(collectionId)!, actionId, nominees, true));
		}
		const blockIds = new Map(Array.from(collectionTransforms, ([collectionId, transforms]) => [collectionId, blockIdsForTransforms(transforms)]));

		let result: PendResult | undefined;
		try {
			result = await this.transactor.pendMany!(requests);
		} catch (e) {
			await this.cancelPhase(actionId, blockIds);
			return pendFailure([e]);
		}
		if (result === undefined) return undefined;
		return result.success
			? { success: true, pendedBlockIds: blockIds }
			: pendFailure([pendRefusalError(Array.from(collectionTransforms.keys()), result)]);
	}

	/**
	 * Pend a single collection's transforms. Resolves with the collection id and its
	 * pended block ids on success; throws with a per-collection reason on failure so the
	 * fan-out in {@link pendPhase} can settle it as a rejection.
	 */
	private async pendCollection(
		transaction: Transaction,
		validation: PendRequest['validation'],
		collectionId: CollectionId,
		transforms: Transforms,
		/** The revision the log entry was stamped with (threaded from applyActionsToCollection),
		 * NOT recomputed here: a `getNextRev()` after the append round trips could name a number
		 * a concurrent refresh already moved past. */
		rev: number,
		actionId: ActionId,
		nominees: PeerId[] | undefined,
		/** Whether this is the transaction's only collection (see {@link pendPhase}). */
		sole: boolean
	): Promise<{ collectionId: CollectionId; blockIds: BlockId[] }> {
		const collection = this.collections.get(collectionId);
		if (!collection) {
			throw new Error(`Collection not found: ${collectionId}`);
		}

		const pendResult = await this.transactor.pend(
			this.pendRequestFor(transaction, validation, collection, transforms, rev, actionId, nominees, sole)
		);
		if (!pendResult.success) {
			throw pendRefusalError([collectionId], pendResult);
		}

		return { collectionId, blockIds: pendResult.blockIds };
	}

	/**
	 * The pend request for one collection's transforms — the one place a pend request is built, whether it
	 * goes on its own ({@link pendCollection}) or with its siblings ({@link pendTogether}).
	 */
	private pendRequestFor(
		transaction: Transaction,
		validation: PendRequest['validation'],
		collection: Collection<any>,
		transforms: Transforms,
		/** The revision the log entry was stamped with (see {@link pendCollection}). */
		rev: number,
		actionId: ActionId,
		nominees: PeerId[] | undefined,
		/** Whether this request is the action's whole reservation, alone or with the siblings it is sent
		 * with (`PendRequest.soleReservation`). */
		sole: boolean
	): PendRequest {
		// This is the only producer of PendRequest.validation, and it always sends the pair whole
		// (transaction + operations hash) or not at all. The aged priority has one carrier per shape —
		// inside the transaction when the pend carries it, on the pend itself when it does not — because a
		// member's race resolution reads the transaction's priority first and falls back to the pend's
		// (recordPriority in db-p2p's race-resolution.ts); an unvalidated pend that left both empty would
		// never age. Omitted at 0, exactly as the single-collection path sends it
		// (TransactorSource.transact), so the common first-attempt pend is indistinguishable from a
		// Collection.sync pend.
		const priority = clampPriority(transaction.priority);
		// The base each update-only block's operations were computed against, read from the same
		// tracker the commit's declaration was taken from (declareTouchedBlocks); it still holds this
		// transaction's staged transforms and pins. Storage keeps it with the pending record so the
		// record is never applied to a different version of the block (see PendRequest.baseRevs).
		// Omitted when empty.
		const baseRevs = collection.tracker.stagedBaseRevs(blockIdsForTransforms(transforms));
		return {
			actionId,
			rev,
			transforms,
			policy: 'r', // Return policy: fail but return pending actions
			...(validation === undefined
				? (priority > 0 ? { priority } : {})
				: { validation }),
			...baseRevsField(baseRevs),
			superclusterNominees: nominees,
			...(sole ? { soleReservation: true as const } : {})
		};
	}

	/**
	 * COMMIT phase: Commit to all critical blocks with retry for transient failures.
	 *
	 * Once all collections are pended (Phase 1 passes), the coordinator has decided
	 * to commit. Two or more collections go as ONE request when the transactor can send them so
	 * ({@link commitTogether}); otherwise each collection commits on its own, its transient failures
	 * retried (forward recovery) before giving up. Returns which collections committed vs failed so
	 * the caller can do targeted cancel.
	 */
	private async commitPhase(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		pendedBlockIds: Map<CollectionId, BlockId[]>,
		pendedRevs: ReadonlyMap<CollectionId, number>,
		declared: DeclaredDigests
	): Promise<{
		success: boolean;
		error?: string;
		/** Who holds each collection that committed. */
		committedCollections: Map<CollectionId, WriteDurability>;
		failedCollections: Set<CollectionId>;
		staleLoss?: boolean;
		expired?: TransactionExpiredError;
	}> {
		const together = pendedBlockIds.size > 1 && this.transactor.commitMany
			? await this.commitTogether(actionId, criticalBlockIds, pendedBlockIds, pendedRevs, declared)
			: undefined;
		// NOTE: a fallback after a batched pend leaves the multi-collection residual in place: the
		// pend's decision may have been held back for a commit that now goes per collection, so a member
		// that refuses one collection's pend late can do so after a sibling collection's commit landed —
		// reported by forward recovery or `CoordinatorPartialCommitError`. Reached through a thrown
		// batched commit (`NetworkTransactor.commitMany` answers `undefined` for that). Anything else that
		// keeps a batch from going as one would have kept the batched pend from going too, except one
		// case: the coordinator `pendMany` cached for every block evicted before the commit ran (the
		// cache's TTL is at least a minute, its size cap 1000 transactions), so a live lookup can split
		// the blocks. If that ever shows up, pin the commit to the coordinator the batched pend answered
		// from. See docs/correctness.md §2 Definitions.
		const outcomes = together ?? await this.commitEach(actionId, criticalBlockIds, pendedBlockIds, pendedRevs, declared);

		const committedCollections = new Map<CollectionId, WriteDurability>();
		const failedCollections = new Set<CollectionId>();
		const errors = new Set<string>();
		// Classify failures: a returned stale loss (someone committed a newer rev) is retryable after
		// a re-read; a thrown/transient-exhausted or structural failure is not. staleLoss holds only
		// if EVERY failure was a stale loss — a single hard failure makes the whole attempt not worth
		// re-driving.
		let anyStale = false;
		let anyHard = false;
		let expired: TransactionExpiredError | undefined;
		for (const result of outcomes) {
			if (result.committed) {
				committedCollections.set(result.collectionId, result.durability);
			} else {
				failedCollections.add(result.collectionId);
				// A set: a batched refusal answers every collection with the one reason.
				errors.add(result.error);
				if (result.stale) anyStale = true; else anyHard = true;
				expired ??= result.expired;
			}
		}

		if (failedCollections.size > 0) {
			return {
				success: false,
				error: Array.from(errors).join('; ') || 'Commit failed',
				committedCollections,
				failedCollections,
				staleLoss: anyStale && !anyHard,
				...(expired === undefined ? {} : { expired }),
			};
		}

		return { success: true, committedCollections, failedCollections };
	}

	/**
	 * Commits every collection as ONE request ({@link ITransactor.commitMany}): one consensus record,
	 * decided together — the commit half of {@link pendTogether}. Every collection gets the batch's one
	 * answer ({@link collectionCommitOutcome}): committed, each stamped with its own blocks and revision;
	 * or refused, every collection alike. A refused collection's attempt is then retained by
	 * `commitOnceLatched`, and the refresh between attempts finishes any collection whose log entry did
	 * land (`Collection.completeOwnEntry`) — the path a refused one-collection commit already takes.
	 *
	 * `undefined` when they could not go as one, when the request threw, or when a collection's request
	 * could not be built (missing from the registry, or no log tail among its pended blocks):
	 * {@link commitPhase} then commits each collection on its own, which re-sends everything and reports
	 * a request it cannot build as it always has. The batch is never retried here: a returned refusal
	 * cannot be won by the identical request, and a throw is the per-collection path's to retry.
	 */
	private async commitTogether(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		pendedBlockIds: Map<CollectionId, BlockId[]>,
		pendedRevs: ReadonlyMap<CollectionId, number>,
		declared: DeclaredDigests
	): Promise<CollectionCommitOutcome[] | undefined> {
		const requests: { collectionId: CollectionId; request: CommitRequest }[] = [];
		for (const [collectionId, blockIds] of pendedBlockIds) {
			const request = this.commitRequestFor(actionId, criticalBlockIds, collectionId, blockIds, pendedRevs.get(collectionId)!, declared);
			if (typeof request === 'string') return undefined;
			requests.push({ collectionId, request });
		}

		let result: CommitResult | undefined;
		try {
			result = await this.transactor.commitMany!(requests.map(({ request }) => request));
		} catch (e) {
			log('commitTogether: batched commit threw; committing each collection on its own actionId=%s: %o', actionId, e);
			return undefined;
		}
		return result === undefined
			? undefined
			: requests.map(({ collectionId, request }) => collectionCommitOutcome(collectionId, request, result));
	}

	/** Commits each collection on its own, concurrently ({@link commitCollection}), one outcome per collection. */
	private async commitEach(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		pendedBlockIds: Map<CollectionId, BlockId[]>,
		pendedRevs: ReadonlyMap<CollectionId, number>,
		declared: DeclaredDigests
	): Promise<CollectionCommitOutcome[]> {
		const entries = Array.from(pendedBlockIds.entries());
		const settled = await Promise.allSettled(entries.map(([collectionId, blockIds]) =>
			this.commitCollection(actionId, criticalBlockIds, collectionId, blockIds, pendedRevs.get(collectionId)!, declared)
		));
		// commitCollection resolves rather than rejects, but treat any unexpected rejection as a (hard)
		// failure of its collection so the partitioned sets stay honest.
		return settled.map((outcome, i) => outcome.status === 'fulfilled'
			? outcome.value
			: { collectionId: entries[i]![0], committed: false, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
	}

	/**
	 * Commit a single collection's pended blocks, retrying transient failures up to three
	 * times (forward recovery). Always resolves — success is carried in the returned
	 * `committed` flag, with the commit's `durability` beside it — so the fan-out in
	 * {@link commitEach} can aggregate every result.
	 */
	private async commitCollection(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		collectionId: CollectionId,
		blockIds: BlockId[],
		/** The revision this collection PENDED at (see {@link commitRequestFor}). */
		rev: number,
		declared: DeclaredDigests
	): Promise<CollectionCommitOutcome> {
		const commitRequest = this.commitRequestFor(actionId, criticalBlockIds, collectionId, blockIds, rev, declared);
		if (typeof commitRequest === 'string') {
			return { collectionId, committed: false, error: commitRequest };
		}

		// Retry ONLY transient/thrown failures (unreachable peers, timeout) — forward recovery.
		// A returned { success:false } is a refusal the IDENTICAL request can never win (a rival
		// committed a newer rev, or a member behind on the base refused and dropped its pending
		// record), so return immediately without retrying it here. The refusal is retried at the
		// coordinator level instead, as a DIFFERENT request: the retry loop refreshes, finishes the
		// collection's own log entry where the tail landed, or re-pends afresh — and it does so even
		// when a sibling collection has already committed (the partial-retry branch of
		// commitOnceLatched). Either way cancelPhase (run by coordinateTransaction on commitPhase
		// failure) releases the pend exactly once — commit itself no longer self-cancels.
		let lastTransientError: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return collectionCommitOutcome(collectionId, commitRequest, await this.transactor.commit(commitRequest));
			} catch (e) {
				lastTransientError = e instanceof Error ? e.message : String(e);
			}
		}
		return { collectionId, committed: false, error: `Commit failed for collection ${collectionId} after 3 attempts: ${lastTransientError}` };
	}

	/**
	 * The commit request for one collection's pended blocks — the one place a commit request is built,
	 * whether it goes on its own ({@link commitCollection}) or with its siblings ({@link commitTogether})
	 * — or, as a string, why there is none.
	 */
	private commitRequestFor(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		collectionId: CollectionId,
		blockIds: BlockId[],
		/** The revision this collection PENDED at, threaded from the log append — the same bug
		 * family as pendCollection's: recomputing `getNextRev()` here, after the pend round
		 * trips, could stamp the CommitRequest with a different number than the pend named. */
		rev: number,
		declared: DeclaredDigests
	): CommitRequest | string {
		const collection = this.collections.get(collectionId);
		if (!collection) {
			return `Collection not found: ${collectionId}`;
		}

		// Find the critical block (log tail) for this collection
		const logTailBlockId = criticalBlockIds.find(blockId => blockIds.includes(blockId));
		if (!logTailBlockId) {
			return `Log tail block not found for collection ${collectionId}`;
		}

		// Declare what each pended block will contain once committed: the description taken before the
		// pend (declareTouchedBlocks), over the blocks the pend carried. An id whose base was not cached
		// is omitted and falls back to corroboration on the member side. Only the client can declare
		// this — CoordinatorRepo.commit forwards without materializing.
		return {
			actionId,
			blockIds,
			tailId: logTailBlockId,
			rev,
			...blockDigestsField(declared.get(collectionId))
		};
	}

	/**
	 * CANCEL phase: Cancel pending actions on affected blocks.
	 *
	 * Uses the authoritative pended block IDs from pendPhase rather than
	 * recomputing from transforms. Optionally skips already-committed collections.
	 */
	private async cancelPhase(
		actionId: ActionId,
		pendedBlockIds: Map<CollectionId, BlockId[]>,
		excludeCollections?: ReadonlyMap<CollectionId, unknown>
	): Promise<void> {
		// Fan out the per-collection cancels concurrently. Each is best-effort: a cancel
		// fault is logged and swallowed so it cannot mask the pend/commit failure that
		// triggered this sweep, and so one failed cancel does not abort the others.
		// The log line has to be enough to IDENTIFY the stranded pend on its own — action id and
		// the exact blocks — because `NetworkTransactor.cancel` only throws here once it has
		// retried and still reached nobody, which means those blocks' pending records are standing
		// and will refuse every later write to them until something removes them by hand.
		const cancels = Array.from(pendedBlockIds.entries())
			.filter(([collectionId]) => !excludeCollections?.has(collectionId))
			.map(([collectionId, blockIds]) =>
				this.transactor.cancel({ actionId, blockIds }).catch(err => {
					log('cancelPhase: cancel did not discharge — pending records may be stranded actionId=%s collection=%s blocks=%o: %o', actionId, collectionId, blockIds, err);
				})
			);
		await Promise.all(cancels);
	}

}

