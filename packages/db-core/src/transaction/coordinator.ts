import type { ITransactor, BlockId, CollectionId, Transforms, PendRequest, CommitRequest, ActionId } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions } from "./transaction.js";
import type { PeerId } from "@libp2p/interface";
import type { Collection } from "../collection/collection.js";
import { TransactionContext } from "./context.js";
import { createActionsStatements } from "./actions-engine.js";
import { createTransactionStamp, createTransactionId } from "./transaction.js";
import { Log, blockIdsForTransforms, transformsFromTransform } from "../index.js";

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
		for (const { collectionId, actions: collectionActions } of actions) {
			// Get collection
			const collection = this.collections.get(collectionId);
			if (!collection) {
				throw new Error(`Collection not found: ${collectionId}`);
			}

			// Apply each action (tagged with stampId)
			for (const action of collectionActions) {
				const taggedAction = { ...(action as any), transaction: stampId };
				await collection.act(taggedAction);
			}
		}
	}

	/**
	 * Commit a transaction (actions already applied, orchestrate PEND/COMMIT).
	 *
	 * This is called by TransactionSession.commit() after all statements have been executed.
	 * Actions have already been applied to collections via applyActions(), so this method
	 * just orchestrates the distributed consensus.
	 *
	 * @param transaction - The transaction to commit
	 */
	async commit(transaction: Transaction): Promise<void> {
		// TODO: Implement the new commit flow
		// 1. Collect operations from collection trackers
		// 2. Compute hash of ALL operations
		// 3. Group operations by block
		// 4. Identify critical clusters
		// 5. Execute consensus phases (GATHER, PEND, COMMIT)

		// For now, throw an error to indicate this is not yet implemented
		throw new Error('New commit() method not yet implemented - use execute() for now');
	}

	/**
	 * Rollback a transaction (undo applied actions).
	 *
	 * This is called by TransactionSession.rollback() to undo all actions
	 * that were applied via applyActions().
	 *
	 * @param stampId - The transaction stamp ID to rollback
	 */
	async rollback(stampId: string): Promise<void> {
		// TODO: Implement rollback
		// Clear trackers for this transaction
		// For now, throw an error to indicate this is not yet implemented
		throw new Error('rollback() not yet implemented');
	}

	/**
	 * Commit a transaction context.
	 *
	 * @deprecated Use TransactionSession instead of TransactionContext
	 * This is called by TransactionContext.commit().
	 *
	 * @param context - The transaction context to commit
	 * @returns Execution result with actions and results
	 */
	async commitTransaction(context: TransactionContext): Promise<ExecutionResult> {
		const collectionActions = Array.from(context.getCollectionActions().entries()).map(
			([collectionId, actions]) => ({ collectionId, actions })
		);

		if (collectionActions.length === 0) {
			return { success: true }; // Nothing to commit
		}

		// Create transaction statements
		const statements = createActionsStatements(collectionActions);
		const reads = context.getReads();

		// Create stamp from context
		const stamp = createTransactionStamp(
			'local', // TODO: Get from context or coordinator
			Date.now(),
			'', // TODO: Get from engine
			context.engine
		);

		const transaction: Transaction = {
			stamp,
			statements,
			reads,
			id: createTransactionId(stamp.id, statements, reads)
		};

		// Create ActionsEngine for execution (TransactionContext only supports actions)
		const { ActionsEngine } = await import('./actions-engine.js');
		const engine = new ActionsEngine(this);

		// Execute through standard path
		return await this.execute(transaction, engine);
	}

	/**
	 * Execute a fully-formed transaction.
	 *
	 * This can be called directly with a complete transaction (e.g., from Quereus),
	 * or indirectly via commitTransaction().
	 *
	 * @param transaction - The transaction to execute
	 * @param engine - The engine to use for executing the transaction
	 * @returns Execution result with actions and results
	 */
	async execute(transaction: Transaction, engine: ITransactionEngine): Promise<ExecutionResult> {
		// 1. Validate engine matches transaction
		// Note: We don't enforce this strictly since the engine is passed in explicitly
		// The caller is responsible for ensuring the correct engine is used

		const result = await engine.execute(transaction);
		if (!result.success) {
			return result;
		}

		if (!result.actions || result.actions.length === 0) {
			return { success: true }; // Nothing to do
		}

		// 2. Apply actions to collections and collect transforms
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

		// 3. Coordinate (GATHER if multi-collection)
		const coordResult = await this.coordinateTransaction(
			transaction,
			collectionTransforms,
			criticalBlocks
		);

		if (!coordResult.success) {
			return coordResult;
		}

		// 4. Return results from actions
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
		// when they were added to the TransactionContext. The collection's tracker
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
		const newRev = (collection['source'].actionContext?.rev ?? 0) + 1;

		// Add actions to log (this updates the tracker with log block changes)
		const addResult = await log.addActions(
			collectionActions.actions,
			actionId,
			newRev,
			() => blockIdsForTransforms(transforms),
			allCollectionIds
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
	 * @param collectionTransforms - Map of collectionId to its transforms
	 * @param criticalBlocks - Map of collectionId to its log tail blockId
	 */
	private async coordinateTransaction(
		transaction: Transaction,
		collectionTransforms: Map<CollectionId, Transforms>,
		criticalBlocks: Map<CollectionId, BlockId>
	): Promise<{ success: boolean; error?: string }> {
		// 1. GATHER phase: collect critical cluster nominees (skip if single collection)
		const criticalBlockIds = Array.from(criticalBlocks.values());
		const superclusterNominees = await this.gatherPhase(criticalBlockIds);

		// 2. PEND phase: distribute to all block clusters
		const pendResult = await this.pendPhase(
			transaction.id as ActionId,
			collectionTransforms,
			superclusterNominees
		);
		if (!pendResult.success) {
			return pendResult;
		}

		// 3. COMMIT phase: commit to all critical blocks
		const commitResult = await this.commitPhase(
			transaction.id as ActionId,
			criticalBlockIds,
			pendResult.pendedBlockIds!
		);
		if (!commitResult.success) {
			// Cancel pending actions on failure
			await this.cancelPhase(transaction.id as ActionId, collectionTransforms);
			return commitResult;
		}

		// 4. PROPAGATE and CHECKPOINT phases are handled by clusters automatically
		// (as per user's note: "managed by each cluster, the client doesn't have to worry about them")

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
		criticalBlockIds: BlockId[]
	): Promise<Set<PeerId> | null> {
		// Skip GATHER if only one collection affected
		if (criticalBlockIds.length === 1) {
			return null; // Use normal single-collection consensus
		}

		// TODO: Query each critical cluster for nominees
		// For now, return empty set (will be implemented in Phase 3 with network support)
		return new Set<PeerId>();
	}

	/**
	 * PEND phase: Distribute transaction to all affected block clusters.
	 */
	private async pendPhase(
		actionId: ActionId,
		collectionTransforms: Map<CollectionId, Transforms>,
		_superclusterNominees: Set<PeerId> | null
	): Promise<{ success: boolean; error?: string; pendedBlockIds?: Map<CollectionId, BlockId[]> }> {
		if (collectionTransforms.size === 0) {
			return { success: false, error: 'No transforms to pend' };
		}

		const pendedBlockIds = new Map<CollectionId, BlockId[]>();

		// Pend each collection's transforms
		for (const [collectionId, transforms] of collectionTransforms.entries()) {
			const collection = this.collections.get(collectionId);
			if (!collection) {
				return { success: false, error: `Collection not found: ${collectionId}` };
			}

			// Get revision from the collection's source
			const rev = (collection['source'].actionContext?.rev ?? 0) + 1;

			// Create pend request
			const pendRequest: PendRequest = {
				actionId,
				rev,
				transforms,
				policy: 'r' // Return policy: fail but return pending actions
			};

			// Pend the transaction
			const pendResult = await this.transactor.pend(pendRequest);
			if (!pendResult.success) {
				return {
					success: false,
					error: `Pend failed for collection ${collectionId}: ${pendResult.reason}`
				};
			}

			// Store the pended block IDs for commit phase
			pendedBlockIds.set(collectionId, pendResult.blockIds);
		}

		return { success: true, pendedBlockIds };
	}

	/**
	 * COMMIT phase: Commit to all critical blocks.
	 */
	private async commitPhase(
		actionId: ActionId,
		criticalBlockIds: BlockId[],
		pendedBlockIds: Map<CollectionId, BlockId[]>
	): Promise<{ success: boolean; error?: string }> {
		// Commit each collection's transaction
		for (const [collectionId, blockIds] of pendedBlockIds.entries()) {
			const collection = this.collections.get(collectionId);
			if (!collection) {
				return { success: false, error: `Collection not found: ${collectionId}` };
			}

			// Get revision
			const rev = (collection['source'].actionContext?.rev ?? 0) + 1;

			// Find the critical block (log tail) for this collection
			const logTailBlockId = criticalBlockIds.find(blockId =>
				blockIds.includes(blockId)
			);

			if (!logTailBlockId) {
				return {
					success: false,
					error: `Log tail block not found for collection ${collectionId}`
				};
			}

			// Create commit request
			const commitRequest: CommitRequest = {
				actionId,
				blockIds,
				tailId: logTailBlockId,
				rev
			};

			// Commit the transaction
			const commitResult = await this.transactor.commit(commitRequest);
			if (!commitResult.success) {
				return {
					success: false,
					error: `Commit failed for collection ${collectionId}`
				};
			}
		}

		return { success: true };
	}

	/**
	 * CANCEL phase: Cancel pending actions on all affected blocks.
	 */
	private async cancelPhase(
		actionId: ActionId,
		collectionTransforms: Map<CollectionId, Transforms>
	): Promise<void> {
		// Cancel each collection's pending transaction
		for (const [collectionId, transforms] of collectionTransforms.entries()) {
			const collection = this.collections.get(collectionId);
			if (!collection) {
				continue; // Skip if collection not found
			}

			// Get the block IDs from transforms
			const blockIds = blockIdsForTransforms(transforms);

			// Cancel the transaction
			await this.transactor.cancel({
				actionId,
				blockIds
			});
		}
	}

}

