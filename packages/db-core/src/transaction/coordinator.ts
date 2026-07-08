import type { ITransactor, BlockId, CollectionId, Transforms, PendRequest, CommitRequest, ActionId } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions, ReadDependency } from "./transaction.js";
import type { PeerId } from "../network/types.js";
import type { Collection } from "../collection/collection.js";
import { isTransactionExpired } from "./transaction.js";
import { Log, blockIdsForTransforms } from "../index.js";
import { collectOperations, hashOperations } from "./operations-hash.js";
import { CoordinatorPartialCommitError } from "./errors.js";
import { createLogger } from "../logger.js";

const log = createLogger('trx:coordinator');

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
	 * Commit a transaction: materialise a log entry from each collection's staged
	 * pending actions, then orchestrate the distributed consensus (GATHER/PEND/COMMIT).
	 *
	 * Called by TransactionSession.commit() after all statements have executed. The
	 * staged mutations already live in each collection's tracker — applied either via
	 * applyActions() (engine-driven path) or directly via Collection.act()/Tree.stage
	 * (the vtab's deferred-DML path) — but in BOTH cases without a log entry yet, so
	 * this method appends that entry here (see the inline note below) before pending,
	 * and folds the committed transforms back into each collection's read cache.
	 *
	 * @param transaction - The transaction to commit
	 */
	async commit(transaction: Transaction): Promise<void> {
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
				criticalBlocks
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
						collection.recordCommitted(transaction.id);
						collection.applyCommittedToCache(collectionTransforms.get(collectionId)!);
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
			// nothing durable. Restore every tracker and throw a plain error, exactly as
			// before — a genuinely clean failure leaves each tracker pristine for retry.
			for (const { collectionId, collection } of collectionData) {
				collection.restorePending(preCommitSnapshots.get(collectionId)!);
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
		for (const { collectionId, collection } of collectionData) {
			collection.recordCommitted(transaction.id);
			collection.applyCommittedToCache(collectionTransforms.get(collectionId)!);
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

		// 2. Apply actions to collections and collect transforms
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
			criticalBlocks
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
						collection.recordCommitted(transaction.id);
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
		for (const collectionActions of result.actions) {
			const collection = this.collections.get(collectionActions.collectionId);
			if (collection) {
				collection.recordCommitted(transaction.id);
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
	 */
	private async coordinateTransaction(
		transaction: Transaction,
		operationsHash: string,
		collectionTransforms: Map<CollectionId, Transforms>,
		criticalBlocks: Map<CollectionId, BlockId>
	): Promise<{
		success: boolean;
		error?: string;
		committedCollections?: Set<CollectionId>;
		failedCollections?: Set<CollectionId>;
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
			pendResult.pendedBlockIds!
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
	 * @param superclusterNominees - Nominees for multi-collection consensus (null for single-collection)
	 */
	private async pendPhase(
		transaction: Transaction,
		operationsHash: string,
		collectionTransforms: ReadonlyMap<CollectionId, Transforms>,
		superclusterNominees: ReadonlySet<PeerId> | null
	): Promise<{ success: boolean; error?: string; pendedBlockIds?: Map<CollectionId, BlockId[]> }> {
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
				this.pendCollection(transaction, operationsHash, collectionId, transforms, actionId, nominees)
			)
		);

		// Partition settled results: every collection that DID pend (keyed with its block
		// ids), plus the first failure reason if any collection failed.
		const pendedBlockIds = new Map<CollectionId, BlockId[]>();
		let failure: string | undefined;
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') {
				pendedBlockIds.set(outcome.value.collectionId, outcome.value.blockIds);
			} else if (failure === undefined) {
				failure = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			}
		}

		if (failure !== undefined) {
			// Any failure aborts the whole pend. With concurrency several collections may
			// have pended in parallel, so cancel EVERY successfully-pended collection — not
			// only those started before the failure. Cancels are best-effort (cancelPhase
			// swallows their errors) so they cannot mask the original pend failure.
			await this.cancelPhase(actionId, pendedBlockIds);
			return { success: false, error: failure };
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
		actionId: ActionId,
		nominees: PeerId[] | undefined
	): Promise<{ collectionId: CollectionId; blockIds: BlockId[] }> {
		const collection = this.collections.get(collectionId);
		if (!collection) {
			throw new Error(`Collection not found: ${collectionId}`);
		}

		// Get revision from the collection's source
		const rev = collection.getNextRev();

		// Create pend request with transaction and operations hash for validation
		const pendRequest: PendRequest = {
			actionId,
			rev,
			transforms,
			policy: 'r', // Return policy: fail but return pending actions
			transaction,
			operationsHash,
			superclusterNominees: nominees
		};

		const pendResult = await this.transactor.pend(pendRequest);
		if (!pendResult.success) {
			throw new Error(`Pend failed for collection ${collectionId}: ${pendResult.reason}`);
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
		pendedBlockIds: Map<CollectionId, BlockId[]>
	): Promise<{
		success: boolean;
		error?: string;
		committedCollections: Set<CollectionId>;
		failedCollections: Set<CollectionId>;
	}> {
		// Fan out the independent per-collection commit-with-retry concurrently, then
		// aggregate the committed/failed partition from the settled results.
		const outcomes = await Promise.allSettled(
			Array.from(pendedBlockIds.entries()).map(([collectionId, blockIds]) =>
				this.commitCollection(actionId, criticalBlockIds, collectionId, blockIds)
			)
		);

		const committedCollections = new Set<CollectionId>();
		const failedCollections = new Set<CollectionId>();
		const errors: string[] = [];
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') {
				const { collectionId, committed, error } = outcome.value;
				if (committed) {
					committedCollections.add(collectionId);
				} else {
					failedCollections.add(collectionId);
					if (error) errors.push(error);
				}
			} else {
				// commitCollection resolves rather than rejects, but treat any unexpected
				// rejection as a failure so the partitioned sets stay honest.
				errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
			}
		}

		if (failedCollections.size > 0 || errors.length > 0) {
			return {
				success: false,
				error: errors.join('; ') || 'Commit failed',
				committedCollections,
				failedCollections
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
		blockIds: BlockId[]
	): Promise<{ collectionId: CollectionId; committed: boolean; error?: string }> {
		const collection = this.collections.get(collectionId);
		if (!collection) {
			return { collectionId, committed: false, error: `Collection not found: ${collectionId}` };
		}

		// Get revision
		const rev = collection.getNextRev();

		// Find the critical block (log tail) for this collection
		const logTailBlockId = criticalBlockIds.find(blockId => blockIds.includes(blockId));
		if (!logTailBlockId) {
			return { collectionId, committed: false, error: `Log tail block not found for collection ${collectionId}` };
		}

		// Create commit request
		const commitRequest: CommitRequest = {
			actionId,
			blockIds,
			tailId: logTailBlockId,
			rev
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
				// Permanent stale failure: do not retry.
				return {
					collectionId,
					committed: false,
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

