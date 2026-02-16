import type { ITransactor, BlockId, CollectionId, Transforms, PendRequest, CommitRequest, ActionId, IBlock, BlockOperations } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions } from "./transaction.js";
import type { PeerId } from "../network/types.js";
import type { Collection } from "../collection/collection.js";
import { TransactionContext } from "./context.js";
import { ActionsEngine } from "./actions-engine.js";
import { createActionsStatements, createTransactionStamp, createTransactionId } from "./transaction.js";
import { Log, blockIdsForTransforms, transformsFromTransform, hashString } from "../index.js";

/**
 * Represents an operation on a block within a collection.
 */
type Operation =
	| { readonly type: 'insert'; readonly collectionId: CollectionId; readonly blockId: BlockId; readonly block: IBlock }
	| { readonly type: 'update'; readonly collectionId: CollectionId; readonly blockId: BlockId; readonly operations: BlockOperations }
	| { readonly type: 'delete'; readonly collectionId: CollectionId; readonly blockId: BlockId };

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
		// Collect transforms and determine critical blocks for each affected collection
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

		// Get critical block IDs (log tail) for each affected collection
		// The critical block is the current log tail that must participate in consensus
		const collectionTransforms = new Map<CollectionId, Transforms>();
		const criticalBlocks = new Map<CollectionId, BlockId>();

		for (const { collectionId, collection, transforms } of collectionData) {
			collectionTransforms.set(collectionId, transforms);

			// Get the current log tail block ID (critical block)
			const log = await Log.open(collection.tracker, collectionId);
			if (!log) {
				throw new Error(`Log not found for collection ${collectionId}`);
			}

			const tailPath = await (log as unknown as { chain: { getTail: () => Promise<{ block: { header: { id: BlockId } } } | undefined> } }).chain.getTail();
			if (tailPath) {
				criticalBlocks.set(collectionId, tailPath.block.header.id);
			}
		}

		// Compute hash of ALL operations across ALL collections
		// This hash is used for validation - validators re-execute the transaction
		// and compare their computed operations hash with this one
		const allOperations = collectionData.flatMap(({ collectionId, transforms }) => [
			...Object.entries(transforms.inserts ?? {}).map(([blockId, block]) =>
				({ type: 'insert' as const, collectionId, blockId, block })
			),
			...Object.entries(transforms.updates ?? {}).map(([blockId, operations]) =>
				({ type: 'update' as const, collectionId, blockId, operations })
			),
			...(transforms.deletes ?? []).map(blockId =>
				({ type: 'delete' as const, collectionId, blockId })
			)
		]);

		const operationsHash = this.hashOperations(allOperations);

		// Execute consensus phases (GATHER, PEND, COMMIT)
		const coordResult = await this.coordinateTransaction(
			transaction,
			operationsHash,
			collectionTransforms,
			criticalBlocks
		);

		if (!coordResult.success) {
			throw new Error(`Transaction commit failed: ${coordResult.error}`);
		}
	}

	/**
	 * Rollback a transaction (undo applied actions).
	 *
	 * This is called by TransactionSession.rollback() to undo all actions
	 * that were applied via applyActions().
	 *
	 * @param _stampId - The transaction stamp ID to rollback (currently unused - we clear all trackers)
	 */
	async rollback(_stampId: string): Promise<void> {
		// Clear trackers for all collections
		// This discards all pending changes that were applied via applyActions()
		// TODO: In the future, we may want to track which collections were affected by
		// a specific stampId and only reset those trackers
		for (const collection of this.collections.values()) {
			// Reset the tracker to discard all pending transforms
			collection.tracker.reset();
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
	 * Compute hash of all operations in a transaction.
	 * This hash is used for validation - validators re-execute the transaction
	 * and compare their computed operations hash with this one.
	 */
	private hashOperations(operations: readonly Operation[]): string {
		const operationsData = JSON.stringify(operations);
		return `ops:${hashString(operationsData)}`;
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

		// 3. Compute operations hash for validation
		const allOperations = Array.from(collectionTransforms.entries()).flatMap(([collectionId, transforms]) => [
			...Object.entries(transforms.inserts ?? {}).map(([blockId, block]) =>
				({ type: 'insert' as const, collectionId, blockId, block })
			),
			...Object.entries(transforms.updates ?? {}).map(([blockId, operations]) =>
				({ type: 'update' as const, collectionId, blockId, operations })
			),
			...(transforms.deletes ?? []).map(blockId =>
				({ type: 'delete' as const, collectionId, blockId })
			)
		]);
		const operationsHash = this.hashOperations(allOperations);

		// 4. Coordinate (GATHER if multi-collection)
		const coordResult = await this.coordinateTransaction(
			transaction,
			operationsHash,
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
	 * @param operationsHash - Hash of all operations for validation
	 * @param collectionTransforms - Map of collectionId to its transforms
	 * @param criticalBlocks - Map of collectionId to its log tail blockId
	 */
	private async coordinateTransaction(
		transaction: Transaction,
		operationsHash: string,
		collectionTransforms: Map<CollectionId, Transforms>,
		criticalBlocks: Map<CollectionId, BlockId>
	): Promise<{ success: boolean; error?: string }> {
		// 1. GATHER phase: collect critical cluster nominees (skip if single collection)
		const criticalBlockIds = Array.from(criticalBlocks.values());
		const superclusterNominees = await this.gatherPhase(criticalBlockIds);

		// 2. PEND phase: distribute to all block clusters
		const pendResult = await this.pendPhase(
			transaction,
			operationsHash,
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

		// Merge all nominees into a single set
		const supercluster = results.reduce(
			(acc, result) => {
				result.nominees.forEach(nominee => acc.add(nominee));
				return acc;
			},
			new Set<PeerId>()
		);

		return supercluster;
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

		const pendedBlockIds = new Map<CollectionId, BlockId[]>();
		const actionId = transaction.id as ActionId;
		const nominees = superclusterNominees ? Array.from(superclusterNominees) : undefined;

		// Pend each collection's transforms
		for (const [collectionId, transforms] of collectionTransforms.entries()) {
			const collection = this.collections.get(collectionId);
			if (!collection) {
				return { success: false, error: `Collection not found: ${collectionId}` };
			}

			// Get revision from the collection's source
			const rev = (collection['source'].actionContext?.rev ?? 0) + 1;

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

