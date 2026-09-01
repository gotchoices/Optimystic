import type { ITransactor, BlockId, CollectionId, Transforms, PendRequest, CommitRequest, ActionId } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions, ReadDependency } from "./transaction.js";
import type { PeerId } from "../network/types.js";
import { isConflictFailure } from "../network/stale-failure.js";
import type { Collection } from "../collection/collection.js";
import type { SyncOptions } from "../collection/index.js";
import { isTransactionExpired, clampPriority } from "./transaction.js";
import { Log } from "../log/log.js";
import { blockIdsForTransforms } from "../transform/helpers.js";
import { computeBlockContentDigests, blockDigestsField } from "../transform/digest.js";
import { collectOperations, hashOperations } from "./operations-hash.js";
import { CoordinatorPartialCommitError, CoordinatorStaleLossError } from "./errors.js";
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
 * rejection (storage full, policy) is NOT a conflict and is not worth re-driving. Thrown by
 * {@link TransactionCoordinator.pendCollection} so the fan-out in pendPhase can settle it and read
 * the flag off the rejection.
 */
class PendRejectedError extends Error {
	constructor(
		collectionId: CollectionId,
		readonly conflict: boolean,
		reason?: string,
		/** Confirmed revision the responder holds, from `StaleFailure.staleAt`. Folded into the
		 * message because pendPhase collapses this error to its `.message` string, which is the only
		 * form that reaches an embedder through the transaction result's `error` field. */
		staleAt?: { blockId: BlockId; rev: number },
	) {
		super(`Pend failed for collection ${collectionId}: ${reason ?? (conflict ? 'stale conflict' : 'rejected')}`
			+ (staleAt ? ` (block ${staleAt.blockId} at rev ${staleAt.rev})` : ''));
		this.name = 'PendRejectedError';
	}
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
	/** Per-stampId tracking: snapshot before first apply + accumulated actions for replay */
	private stampData = new Map<string, {
		order: number;
		preSnapshot: Map<CollectionId, Transforms>;
		actionBatches: CollectionActions[][];
	}>();
	private nextStampOrder = 0;

	constructor(
		private readonly transactor: ITransactor,
		private readonly collections: Map<CollectionId, Collection<any>>
	) {}

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
		// On first call for this stampId, snapshot all collections for potential rollback
		if (!this.stampData.has(stampId)) {
			const snapshot = new Map<CollectionId, Transforms>();
			for (const [id, col] of this.collections) {
				snapshot.set(id, structuredClone(col.tracker.transforms));
			}
			this.stampData.set(stampId, {
				order: this.nextStampOrder++,
				preSnapshot: snapshot,
				actionBatches: []
			});
		}
		this.stampData.get(stampId)!.actionBatches.push(actions);

		await this.applyActionsRaw(actions, stampId);
	}

	/**
	 * Apply actions without tracking (used internally and for replay during rollback).
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
	 * The single-attempt work lives in {@link commitOnce}; this wrapper re-drives it when the attempt
	 * fails as a clean optimistic-concurrency loss ({@link CoordinatorStaleLossError} — nothing
	 * durably committed, every tracker restored to its pre-append state). Before each re-attempt it
	 * re-reads each collection to fresh revisions (so the retry pends against current state rather
	 * than immediately re-failing stale), then backs off with the same jitter policy as
	 * {@link Collection.sync}. Retry is bounded by `maxAttempts` and an optional wall-clock
	 * `deadlineMs`, and honours an abort `signal`.
	 *
	 * A {@link CoordinatorPartialCommitError} (a partial landing — some collection durably committed)
	 * is NOT retryable and escapes immediately: blindly retrying would re-log already-durable actions.
	 * Any other failure (expired transaction, unavailable transactor, unreachable cluster) also
	 * propagates without retry — only genuine clean stale losses are re-driven.
	 *
	 * Defaults are safe out of the box: a caller that passes no options gets bounded, jittered retry.
	 *
	 * @param transaction - The transaction to commit
	 * @param options - Retry knobs; shares the {@link SyncOptions} vocabulary with `Collection.sync`.
	 */
	async commit(transaction: Transaction, options?: SyncOptions): Promise<void> {
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

		// Disposers for the in-flight marks {@link commitOnce} sets on each participant it latches.
		// They must outlive the individual attempt: the inter-attempt refresh below is the ONLY
		// reader of the mark, and it deliberately runs after the commit span released its latches
		// (`Latches` is non-reentrant), so a clear tied to the latch would already have run. Hence
		// the finally spans the WHOLE retry loop — every exit clears: return, stale-loss exhaustion,
		// a partial landing, a hard error, an abort. Each disposer is id-guarded, so re-marking on a
		// later attempt is harmless and a stale disposer cannot wipe a newer mark.
		const inFlightDisposers: (() => void)[] = [];
		try {
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
					await this.commitOnce(transaction, inFlightDisposers);
					return;
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
					const delay = jitteredBackoffMs(staleLosses - 1, { baseMs: baseBackoffMs, capMs: maxBackoffMs }, options?.rand);
					await abortableDelay(delay, signal);
					// Re-read fresh state before re-attempting so the next commit pends against current
					// revisions (mirrors how Collection.sync calls updateInternal() before retrying).
					// NOTE: refreshes EVERY registered collection, not only the participants of this
					// transaction. Not free: a non-participant's update() throws CollectionHeaderVanishedError
					// if its header momentarily reads absent while it holds a committed revision, aborting
					// this retry. The registered set is small today; if that (or retry latency) ever bites,
					// narrow this to the transaction's participating collections.
					for (const collection of this.collections.values()) {
						await collection.update();
					}
				}
			}
		} finally {
			for (const dispose of inFlightDisposers) {
				dispose();
			}
		}
	}

	/**
	 * Commit a transaction (single attempt): materialise a log entry from each collection's staged
	 * pending actions, then orchestrate the distributed consensus (GATHER/PEND/COMMIT).
	 *
	 * Called by {@link commit} (which wraps it in the backoff+jitter retry loop). The
	 * staged mutations already live in each collection's tracker — applied either via
	 * applyActions() (engine-driven path) or directly via Collection.act()/Tree.stage
	 * (the vtab's deferred-DML path) — but in BOTH cases without a log entry yet, so
	 * this method appends that entry here (see the inline note below) before pending,
	 * and folds the committed transforms back into each collection's read cache.
	 *
	 * On a clean stale loss (nothing durable, every tracker restored) it throws
	 * {@link CoordinatorStaleLossError} so the caller can retry; on a partial landing it throws
	 * {@link CoordinatorPartialCommitError} (not retryable).
	 *
	 * @param transaction - The transaction to commit
	 * @param inFlightDisposers - Collects one disposer per participant marked in flight under this
	 * transaction's id (see {@link Collection.beginInFlightAction}). REQUIRED, so a future caller
	 * cannot silently reintroduce the unmarked refresh this parameter exists to prevent: a caller
	 * that never refreshes between attempts passes a throwaway array and simply ignores it. The
	 * caller owns clearing them, because the mark has to survive past this attempt — see the
	 * array's declaration in {@link commit}.
	 */
	private async commitOnce(transaction: Transaction, inFlightDisposers: (() => void)[]): Promise<void> {
		if (isTransactionExpired(transaction.stamp)) {
			throw new Error(`Transaction expired at ${transaction.stamp.expiration}`);
		}

		// Collect collections with staged (un-synced) changes.
		const collectionData = Array.from(this.collections.entries())
			.map(([collectionId, collection]) => ({
				collectionId,
				collection,
				transforms: collection.tracker.transforms
			}))
			.filter(({ transforms }) =>
				Object.keys(transforms.inserts ?? {}).length +
				Object.keys(transforms.updates ?? {}).length +
				(transforms.deletes?.length ?? 0) > 0
			);

		if (collectionData.length === 0) {
			return; // Nothing to commit
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
		// participant — the retry loop's blanket collection.update() in commit() runs OUTSIDE
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
				// inter-attempt refresh in commit() recognises a log entry this transaction itself
				// made durable (a torn commit: header and log tail committed, a later sweep block
				// reported the conflict) and consumes it instead of replaying it into a second entry
				// under the same id. `transaction.id` is stable across retries, so re-marking on a
				// later attempt re-states the same fact. Only participants are marked; a registered
				// non-participant is left unmarked and its refresh behaves exactly as a reader's.
				inFlightDisposers.push(collection.beginInFlightAction(transaction.id));
			}
			await this.commitOnceLatched(transaction, collectionData);
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
	 */
	private async commitOnceLatched(
		transaction: Transaction,
		collectionData: { collectionId: CollectionId; collection: Collection<any> }[]
	): Promise<void> {
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

		// Snapshot EVERY participating collection's staged state (transforms + pending
		// queue) BEFORE the append loop mutates any tracker. The loop appends log
		// entries sequentially, so a failure on the Nth collection must also undo the
		// 0..N-1 collections that already appended — and coordinateTransaction can fail
		// after ALL of them appended. On any throw below we restore every snapshot, so a
		// failed commit leaves each tracker exactly as it was: a retry re-appends cleanly
		// (no duplicate log entry) and a directly-staged tree's rollback (which no-ops
		// when the stamp was never tracked via applyActions) has nothing poisoned to undo.
		const preCommitSnapshots = new Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>();
		for (const { collectionId, collection } of collectionData) {
			preCommitSnapshots.set(collectionId, collection.snapshotPending());
		}

		let coordResult: {
			success: boolean;
			error?: string;
			committedCollections?: Set<CollectionId>;
			failedCollections?: Set<CollectionId>;
			staleLoss?: boolean;
		};
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

			// Compute hash of ALL operations across ALL collections (post-log-append).
			// Validators re-execute the transaction and compare their computed hash.
			// The shared operations-hash module canonicalises (sort + canonical JSON) so
			// this order-independent fingerprint matches what a validator recomputes.
			const operationsHash = await hashOperations(collectOperations(collectionTransforms));

			// Execute consensus phases (GATHER, PEND, COMMIT)
			coordResult = await this.coordinateTransaction(
				transaction,
				operationsHash,
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
				collection.restorePending(preCommitSnapshots.get(collectionId)!);
			}
			throw err;
		}

		if (!coordResult.success) {
			const committed = coordResult.committedCollections ?? new Set<CollectionId>();
			if (committed.size > 0) {
				// PARTIAL COMMIT: at least one collection durably committed via consensus
				// while another failed permanently. A uniform pre-append restore would
				// corrupt the committed half — re-staging its already-durable actions as
				// still-pending, so tracker memory would disagree with cluster storage.
				// Split the local handling instead:
				for (const { collectionId, collection } of collectionData) {
					if (committed.has(collectionId)) {
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
					} else {
						// Failed / never-committed → restore the pre-append snapshot so a retry
						// re-appends cleanly (no duplicate log entry).
						collection.restorePending(preCommitSnapshots.get(collectionId)!);
					}
				}
				// The transaction half-landed, so it is neither cleanly retryable nor
				// cleanly abortable: drop its stamp tracking (the success path does the
				// same at the end) and surface the structured signal for reconciliation.
				this.stampData.delete(transaction.stamp.id);
				throw new CoordinatorPartialCommitError(
					[...committed],
					[...(coordResult.failedCollections ?? new Set<CollectionId>())],
					coordResult.error
				);
			}

			// EMPTY committed set: PEND failed, or the whole commit failed cleanly with
			// nothing durable. Restore every tracker so each is pristine for retry.
			for (const { collectionId, collection } of collectionData) {
				collection.restorePending(preCommitSnapshots.get(collectionId)!);
			}
			// Distinguish a genuine optimistic-concurrency conflict (a stale loss / pending
			// contention — retryable after a re-read) from a hard failure (unavailable transactor,
			// storage rejection, expired). Only the former is worth re-driving; the retry wrapper in
			// commit() catches CoordinatorStaleLossError and re-attempts, while a plain Error escapes
			// immediately (preserving the historical fail-fast behaviour for hard failures).
			if (coordResult.staleLoss) {
				throw new CoordinatorStaleLossError([...(coordResult.failedCollections ?? new Set(allCollectionIds))], coordResult.error);
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

		// Clean up stamp tracking data
		this.stampData.delete(transaction.stamp.id);
	}

	/**
	 * Rollback a transaction (undo only the given stampId's applied actions).
	 *
	 * Restores tracker state to the snapshot taken before the stampId's first
	 * applyActions call, then replays any later stamps' actions to preserve
	 * other sessions' transforms.
	 *
	 * @param stampId - The transaction stamp ID to rollback
	 */
	async rollback(stampId: string): Promise<void> {
		// NOTE: unlike the commit path, this resets and replays into participant trackers WITHOUT
		// holding their instance latches. Safe today because a session drives abort and commit from
		// one call path, so a rollback cannot overlap a commit span on the same collections. If
		// rollback ever becomes reachable concurrently with a commit (a background abort, a second
		// session sharing collection instances), latch the participants here the way commitOnce does.
		const data = this.stampData.get(stampId);
		if (!data) return;

		this.stampData.delete(stampId);

		// Collect all remaining stamps to replay
		const toReplay = [...this.stampData.entries()]
			.sort(([, a], [, b]) => a.order - b.order);

		// Find the earliest snapshot among the rolled-back stamp and all remaining stamps.
		// This is necessary because interleaved execution means a lower-order stamp
		// may have batches applied after a higher-order stamp's snapshot was taken.
		let earliestSnapshot = data.preSnapshot;
		let earliestOrder = data.order;
		for (const [, d] of toReplay) {
			if (d.order < earliestOrder) {
				earliestSnapshot = d.preSnapshot;
				earliestOrder = d.order;
			}
		}

		// Restore to the earliest snapshot
		for (const [collectionId, transforms] of earliestSnapshot) {
			const collection = this.collections.get(collectionId);
			if (collection) {
				collection.tracker.reset(structuredClone(transforms));
			}
		}

		// Replay all remaining stamps' batches in order
		for (const [replayStampId, replayData] of toReplay) {
			// Update the snapshot to reflect current (post-replay) state
			const newSnapshot = new Map<CollectionId, Transforms>();
			for (const [id, col] of this.collections) {
				newSnapshot.set(id, structuredClone(col.tracker.transforms));
			}
			replayData.preSnapshot = newSnapshot;

			for (const actionBatch of replayData.actionBatches) {
				await this.applyActionsRaw(actionBatch, replayStampId);
			}
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
		// guard above.)
		//
		// applyActions() throws if a referenced collection is not registered — the same
		// "Collection not found" the engine's side-effecting apply used to surface. Convert
		// it back into a failure result so execute() keeps its return contract.
		try {
			await this.applyActions(result.actions, transaction.stamp.id);
		} catch (error) {
			const engineMs = Date.now() - tEngine;
			log('execute:done trxId=%s engine=%dms apply-failed=true total=%dms', trxId, engineMs, Date.now() - t0);
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}

		// 2. Build a log entry per collection from the now-staged tracker transforms.
		//
		// NOTE: like commit(), this loop appends a log entry into each collection's
		// tracker and these failure returns do NOT restore that state — so a partially
		// applied engine transaction leaves appended-but-uncommitted entries in the
		// trackers. This is deliberately NOT snapshot/restore-wrapped the way commit()
		// is, because execute()'s asymmetry makes it lower risk: it is not the retryable
		// session.commit() entry point (a failed execute() is not re-driven through the
		// same loop), and its actions were tracked via applyActions() so rollback(stampId)
		// CAN unwind them (unlike commit()'s directly-staged path). If execute() ever
		// becomes retryable, mirror the commit() snapshot/restore fix here.
		const tApply = Date.now();
		const collectionTransforms = new Map<CollectionId, Transforms>();
		const criticalBlocks = new Map<CollectionId, BlockId>();
		const actionResults = new Map<CollectionId, any[]>();
		const allCollectionIds = result.actions.map(ca => ca.collectionId);
		// Same single-capture rev threading as commitOnce: stamped at the log append below,
		// named again at pend, commit, and recordCommitted.
		const pendedRevs = new Map<CollectionId, number>();

		// Hold each participating collection's instance latch for the commit span, same
		// discipline as commitOnce (sorted acquisition; see the comment there). Acquired only
		// AFTER applyActions above: collection.act takes the same non-reentrant instance latch
		// itself, so latching earlier would deadlock. Deduped before acquiring — taking one
		// instance's latch twice would also deadlock. Released in the finally: execute has
		// early failure returns.
		const latchReleases: (() => void)[] = [];
		try {
			for (const collectionId of [...new Set(allCollectionIds)].sort()) {
				const collection = this.collections.get(collectionId);
				if (collection) {
					latchReleases.push(await collection.acquireLatch());
				}
			}

			for (const collectionActions of result.actions) {
				const applyResult = await this.applyActionsToCollection(
					collectionActions,
					transaction,
					allCollectionIds
				);

				if (!applyResult.success) {
					return { success: false, error: applyResult.error };
				}

				collectionTransforms.set(collectionActions.collectionId, applyResult.transforms!);
				criticalBlocks.set(collectionActions.collectionId, applyResult.logTailBlockId!);
				actionResults.set(collectionActions.collectionId, applyResult.results!);
				pendedRevs.set(collectionActions.collectionId, applyResult.rev!);
			}

			// 3. Compute operations hash for validation (order-independent; see commit()).
			const operationsHash = await hashOperations(collectOperations(collectionTransforms));

			const applyMs = Date.now() - tApply;

			// 4. Coordinate (GATHER if multi-collection)
			const tCoord = Date.now();
			const coordResult = await this.coordinateTransaction(
				transaction,
				operationsHash,
				collectionTransforms,
				criticalBlocks,
				pendedRevs
			);

			const coordMs = Date.now() - tCoord;
			if (!coordResult.success) {
				log('execute:done trxId=%s engine=%dms apply=%dms coordinate=%dms success=false total=%dms', trxId, engineMs, applyMs, coordMs, Date.now() - t0);
				// Stop lying to the caller about a partial commit: if some collections durably
				// committed, surface that set. execute() is not snapshot/restore-wrapped (see the
				// note above), but the committed subset must still get the success-path local
				// treatment (recordCommitted + tracker.reset, as on the success path below) so its
				// trackers aren't left mis-tracking already-durable state.
				const committed = coordResult.committedCollections ?? new Set<CollectionId>();
				if (committed.size > 0) {
					for (const collectionActions of result.actions) {
						const collection = this.collections.get(collectionActions.collectionId);
						if (collection && committed.has(collectionActions.collectionId)) {
							collection.recordCommitted(transaction.id, pendedRevs.get(collectionActions.collectionId)!);
							collection.tracker.reset();
						}
					}
				}
				return {
					success: false,
					error: coordResult.error,
					committedCollections: committed.size > 0 ? [...committed] : undefined,
					failedCollections: coordResult.failedCollections ? [...coordResult.failedCollections] : undefined,
				};
			}

			// 5. Update actionContext and reset trackers after successful commit
			// NOTE: this iterates `result.actions`, not the DISTINCT participant set the latch
			// acquisition above deduped to — so a transaction whose actions name one collection
			// twice folds that collection twice, and the second recordCommitted throws on the
			// revision it already advanced past. Dormant today (no caller emits duplicate
			// CollectionActions entries); tracked as
			// `debt-execute-duplicate-collection-actions-double-record`, and pinned meanwhile by the
			// duplicate-collection case in test/coordinator-latch-span.spec.ts, which deliberately
			// does not assert this method's outcome.
			for (const collectionActions of result.actions) {
				const collection = this.collections.get(collectionActions.collectionId);
				if (collection) {
					collection.recordCommitted(transaction.id, pendedRevs.get(collectionActions.collectionId)!);
					collection.tracker.reset();
				}
			}

			// Clean up stamp tracking data
			this.stampData.delete(transaction.stamp.id);

			// 6. Return results from actions
			log('execute:done trxId=%s engine=%dms apply=%dms coordinate=%dms total=%dms', trxId, engineMs, applyMs, coordMs, Date.now() - t0);
			return {
				success: true,
				actions: result.actions,
				results: actionResults
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

		// Write actions to the collection's log to get the log tail block ID
		const log = await Log.open(collection.tracker, collectionActions.collectionId);
		if (!log) {
			return {
				success: false,
				error: `Log not found for collection ${collectionActions.collectionId}`
			};
		}

		// Generate action ID from transaction ID
		const actionId = transaction.id;
		const newRev = collection.getNextRev();

		// Add actions to log (this updates the tracker with log block changes).
		// Persist the transaction's read set on the entry so a later invalidation cascade can
		// discover this action's read-dependents (see ActionEntry.reads). The whole transaction's
		// reads are recorded on every collection's entry: a read may target a block in another
		// collection, and the cascade matches read-dependents by (blockId, revision) regardless of
		// which collection's log the dependent landed in.
		// NOTE: `allCollectionIds` names the participants of THIS attempt, and a retry's participant
		// set can be SMALLER than the first attempt's. After a torn commit, the participant whose
		// entry landed durably consumes that entry on the inter-attempt refresh
		// (Collection.inFlightActionId), empties its pending queue and resets its tracker, so
		// commitOnce's non-empty-transforms filter drops it from the next attempt. The retry's
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
			allCollectionIds,
			transaction.reads
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
	 * @param operationsHash - Hash of all operations for validation
	 * @param collectionTransforms - Map of collectionId to its transforms
	 * @param criticalBlocks - Map of collectionId to its log tail blockId
	 * @param pendedRevs - Per collection, the revision its log entry was stamped with (from
	 * applyActionsToCollection) — repeated verbatim on the pend and commit requests so storage
	 * and the local record name the same number.
	 */
	private async coordinateTransaction(
		transaction: Transaction,
		operationsHash: string,
		collectionTransforms: Map<CollectionId, Transforms>,
		criticalBlocks: Map<CollectionId, BlockId>,
		pendedRevs: ReadonlyMap<CollectionId, number>
	): Promise<{
		success: boolean;
		error?: string;
		committedCollections?: Set<CollectionId>;
		failedCollections?: Set<CollectionId>;
		/** True when the failure was a clean optimistic-concurrency conflict (stale loss / pending
		 * contention) with nothing durable — i.e. safe to re-drive after a re-read. */
		staleLoss?: boolean;
	}> {
		const trxId = transaction.id;
		const t0 = Date.now();

		// 1. GATHER phase: collect critical cluster nominees (skip if single collection)
		const criticalBlockIds = Array.from(criticalBlocks.values());
		const tGather = Date.now();
		const superclusterNominees = await this.gatherPhase(criticalBlockIds);
		const gatherMs = Date.now() - tGather;

		// 2. PEND phase: distribute to all block clusters
		const tPend = Date.now();
		const pendResult = await this.pendPhase(
			transaction,
			operationsHash,
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
			pendResult.pendedBlockIds!,
			pendedRevs
		);
		const commitMs = Date.now() - tCommit;
		if (!commitResult.success) {
			// Targeted cancel: only cancel collections that are still pending (not already committed)
			await this.cancelPhase(
				transaction.id as ActionId,
				pendResult.pendedBlockIds!,
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
			};
		}

		// 4. PROPAGATE and CHECKPOINT phases are handled by clusters automatically
		// (as per user's note: "managed by each cluster, the client doesn't have to worry about them")

		log('trx:phases trxId=%s gather=%dms pend=%dms commit=%dms total=%dms', trxId, gatherMs, pendMs, commitMs, Date.now() - t0);
		return { success: true };
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
	 * PEND phase: Distribute transaction to all affected block clusters.
	 *
	 * @param transaction - The full transaction for replay/validation
	 * @param operationsHash - Hash of all operations for validation
	 * @param collectionTransforms - Map of collectionId to its transforms
	 * @param pendedRevs - Per collection, the revision its log entry was stamped with — the pend
	 * request repeats it verbatim rather than recomputing from the collection (a recompute after
	 * the append could name a different number if the collection refreshed in between).
	 * @param superclusterNominees - Nominees for multi-collection consensus (null for single-collection)
	 */
	private async pendPhase(
		transaction: Transaction,
		operationsHash: string,
		collectionTransforms: ReadonlyMap<CollectionId, Transforms>,
		pendedRevs: ReadonlyMap<CollectionId, number>,
		superclusterNominees: ReadonlySet<PeerId> | null
	): Promise<{ success: boolean; error?: string; pendedBlockIds?: Map<CollectionId, BlockId[]>; staleLoss?: boolean }> {
		if (collectionTransforms.size === 0) {
			return { success: false, error: 'No transforms to pend' };
		}

		const actionId = transaction.id as ActionId;
		const nominees = superclusterNominees ? Array.from(superclusterNominees) : undefined;

		// Fan out the independent per-collection pends concurrently. Each settles to a
		// { collectionId, blockIds } on success, or rejects with the per-collection reason.
		// NOTE: unbounded fan-out — one concurrent coordinator round-trip per collection.
		// Transactions touch few collections today; if one ever spans very many, bound this
		// with a concurrency limiter so peak in-flight round-trips stays sane. Same for commitPhase.
		const outcomes = await Promise.allSettled(
			Array.from(collectionTransforms.entries()).map(([collectionId, transforms]) =>
				this.pendCollection(transaction, operationsHash, collectionId, transforms, pendedRevs.get(collectionId)!, actionId, nominees)
			)
		);

		// Partition settled results: every collection that DID pend (keyed with its block
		// ids), plus the first failure reason if any collection failed.
		const pendedBlockIds = new Map<CollectionId, BlockId[]>();
		let failure: string | undefined;
		// Classify across ALL failures (mirroring commitPhase, and independent of iteration order):
		// the pend is a retryable clean stale loss only if at least one failure was a conflicting pend
		// (PendRejectedError.conflict) AND none was a hard failure. A single hard failure (storage/
		// policy rejection, or a thrown/unavailable transactor) will not clear on a re-read, so
		// re-driving it would just burn the retry budget — fail fast instead.
		let anyConflict = false;
		let anyHard = false;
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') {
				pendedBlockIds.set(outcome.value.collectionId, outcome.value.blockIds);
			} else {
				if (failure === undefined) {
					failure = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				}
				if (outcome.reason instanceof PendRejectedError && outcome.reason.conflict) anyConflict = true;
				else anyHard = true;
			}
		}

		if (failure !== undefined) {
			// Any failure aborts the whole pend. With concurrency several collections may
			// have pended in parallel, so cancel EVERY successfully-pended collection — not
			// only those started before the failure. Cancels are best-effort (cancelPhase
			// swallows their errors) so they cannot mask the original pend failure.
			await this.cancelPhase(actionId, pendedBlockIds);
			return { success: false, error: failure, staleLoss: anyConflict && !anyHard };
		}

		return { success: true, pendedBlockIds };
	}

	/**
	 * Pend a single collection's transforms. Resolves with the collection id and its
	 * pended block ids on success; throws with a per-collection reason on failure so the
	 * fan-out in {@link pendPhase} can settle it as a rejection.
	 */
	private async pendCollection(
		transaction: Transaction,
		operationsHash: string,
		collectionId: CollectionId,
		transforms: Transforms,
		/** The revision the log entry was stamped with (threaded from applyActionsToCollection),
		 * NOT recomputed here: a `getNextRev()` after the append round trips could name a number
		 * a concurrent refresh already moved past. */
		rev: number,
		actionId: ActionId,
		nominees: PeerId[] | undefined
	): Promise<{ collectionId: CollectionId; blockIds: BlockId[] }> {
		const collection = this.collections.get(collectionId);
		if (!collection) {
			throw new Error(`Collection not found: ${collectionId}`);
		}

		// Create pend request with the validation payload (transaction + operations hash) —
		// always BOTH, as one pair: this is the only producer of PendRequest.validation.
		const pendRequest: PendRequest = {
			actionId,
			rev,
			transforms,
			policy: 'r', // Return policy: fail but return pending actions
			validation: { transaction, operationsHash },
			superclusterNominees: nominees
		};

		const pendResult = await this.transactor.pend(pendRequest);
		if (!pendResult.success) {
			// Retryability comes from the response itself: a producer that classified the failure sets
			// `conflict`, and only where no producer set it do we fall back to inferring from
			// `missing`/`pending`. Either way a conflict is an optimistic-concurrency loss, clearable
			// by a re-read; anything else is a hard rejection (storage/policy) that re-driving won't fix.
			throw new PendRejectedError(collectionId, isConflictFailure(pendResult), pendResult.reason, pendResult.staleAt);
		}

		return { collectionId, blockIds: pendResult.blockIds };
	}

	/**
	 * COMMIT phase: Commit to all critical blocks with retry for transient failures.
	 *
	 * Once all collections are pended (Phase 1 passes), the coordinator has decided
	 * to commit. Failed commits are retried (forward recovery) before giving up.
	 * Returns which collections committed vs failed so the caller can do targeted cancel.
	 */
	private async commitPhase(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		pendedBlockIds: Map<CollectionId, BlockId[]>,
		pendedRevs: ReadonlyMap<CollectionId, number>
	): Promise<{
		success: boolean;
		error?: string;
		committedCollections: Set<CollectionId>;
		failedCollections: Set<CollectionId>;
		staleLoss?: boolean;
	}> {
		// Fan out the independent per-collection commit-with-retry concurrently, then
		// aggregate the committed/failed partition from the settled results.
		const outcomes = await Promise.allSettled(
			Array.from(pendedBlockIds.entries()).map(([collectionId, blockIds]) =>
				this.commitCollection(actionId, criticalBlockIds, collectionId, blockIds, pendedRevs.get(collectionId)!)
			)
		);

		const committedCollections = new Set<CollectionId>();
		const failedCollections = new Set<CollectionId>();
		const errors: string[] = [];
		// Classify failures: a returned stale loss (someone committed a newer rev) is retryable after
		// a re-read; a thrown/transient-exhausted or structural failure is not. staleLoss holds only
		// if EVERY failure was a stale loss — a single hard failure makes the whole attempt not worth
		// re-driving.
		let anyStale = false;
		let anyHard = false;
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') {
				const { collectionId, committed, error, stale } = outcome.value;
				if (committed) {
					committedCollections.add(collectionId);
				} else {
					failedCollections.add(collectionId);
					if (error) errors.push(error);
					if (stale) anyStale = true; else anyHard = true;
				}
			} else {
				// commitCollection resolves rather than rejects, but treat any unexpected
				// rejection as a (hard) failure so the partitioned sets stay honest.
				errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
				anyHard = true;
			}
		}

		if (failedCollections.size > 0 || errors.length > 0) {
			return {
				success: false,
				error: errors.join('; ') || 'Commit failed',
				committedCollections,
				failedCollections,
				staleLoss: anyStale && !anyHard,
			};
		}

		return { success: true, committedCollections, failedCollections };
	}

	/**
	 * Commit a single collection's pended blocks, retrying transient failures up to three
	 * times (forward recovery). Always resolves — success is carried in the returned
	 * `committed` flag — so the fan-out in {@link commitPhase} can aggregate every result.
	 */
	private async commitCollection(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		collectionId: CollectionId,
		blockIds: BlockId[],
		/** The revision this collection PENDED at, threaded from the log append — the same bug
		 * family as pendCollection's: recomputing `getNextRev()` here, after the pend round
		 * trips, could stamp the CommitRequest with a different number than the pend named. */
		rev: number
	): Promise<{ collectionId: CollectionId; committed: boolean; error?: string; stale?: boolean }> {
		const collection = this.collections.get(collectionId);
		if (!collection) {
			return { collectionId, committed: false, error: `Collection not found: ${collectionId}` };
		}

		// Find the critical block (log tail) for this collection
		const logTailBlockId = criticalBlockIds.find(blockId => blockIds.includes(blockId));
		if (!logTailBlockId) {
			return { collectionId, committed: false, error: `Log tail block not found for collection ${collectionId}` };
		}

		// Declare what each pended block will contain once committed. The collection's tracker still
		// holds this transaction's staged transforms (it is reset only after commit succeeds) and
		// layers over the collection's CacheSource, so this is a purely local computation; an id whose
		// base is not cached is omitted and falls back to corroboration on the member side. Only the
		// client can declare this — CoordinatorRepo.commit forwards without materializing.
		const blockDigests = await computeBlockContentDigests(collection.tracker, blockIds);

		// Create commit request
		const commitRequest: CommitRequest = {
			actionId,
			blockIds,
			tailId: logTailBlockId,
			rev,
			...blockDigestsField(blockDigests)
		};

		// Retry ONLY transient/thrown failures (unreachable peers, timeout) — forward recovery.
		// A returned { success:false } is a permanent stale loss (someone committed a newer rev);
		// the identical request can never win, so return immediately without retrying. Either way
		// cancelPhase (run by coordinateTransaction on commitPhase failure) releases the pend
		// exactly once — commit itself no longer self-cancels.
		let lastTransientError: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const commitResult = await this.transactor.commit(commitRequest);
				if (commitResult.success) {
					return { collectionId, committed: true };
				}
				// Permanent stale failure: do not retry here. It IS a clean stale loss, though, so
				// mark it retryable at the coordinator level (after a re-read advances the rev).
				// NOTE: deliberately does NOT consult `isConflictFailure` / `StaleFailure.conflict`
				// like the pend path does. Once the pend succeeded, a returned commit failure means
				// the revision slot moved. One commit producer DOES set `conflict` now —
				// db-p2p's CoordinatorRepo.commit returns lost commit-consensus races and classified
				// stale-commit rejections as `{ success:false, conflict:true }` (returning, not
				// throwing, is what keeps them out of the verbatim retry above) — but every returned
				// failure still maps to `stale: true` here, and `isConflictFailure` covers that new
				// shape, so no behavior change is needed. If a commit producer ever starts returning
				// hard commit rejections (validator policy, storage fault) as results too, gate
				// `stale` on isConflictFailure here.
				return {
					collectionId,
					committed: false,
					stale: true,
					error: commitResult.reason ?? `Stale commit for collection ${collectionId}`
				};
			} catch (e) {
				lastTransientError = e instanceof Error ? e.message : String(e);
			}
		}
		return { collectionId, committed: false, error: `Commit failed for collection ${collectionId} after 3 attempts: ${lastTransientError}` };
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
		excludeCollections?: Set<CollectionId>
	): Promise<void> {
		// Fan out the per-collection cancels concurrently. Each is best-effort: a cancel
		// fault is logged and swallowed so it cannot mask the pend/commit failure that
		// triggered this sweep, and so one failed cancel does not abort the others.
		const cancels = Array.from(pendedBlockIds.entries())
			.filter(([collectionId]) => !excludeCollections?.has(collectionId))
			.map(([collectionId, blockIds]) =>
				this.transactor.cancel({ actionId, blockIds }).catch(err => {
					log('cancelPhase: best-effort cancel failed collection=%s: %o', collectionId, err);
				})
			);
		await Promise.all(cancels);
	}

}

