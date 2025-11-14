import type { ITransactor, BlockId, CollectionId, Transforms, ActionId } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions } from "./transaction.js";
import type { PeerId } from "@libp2p/interface";
import type { Collection } from "../collection/collection.js";
import { TransactionContext } from "./context.js";
import { createActionsPayload, createTransactionId, createTransactionCid } from "./actions-engine.js";
import { blockIdsForTransforms } from "../index.js";

/**
 * Coordinates multi-collection transactions.
 *
 * This is the ONLY interface for all mutations (single or multi-collection).
 *
 * Responsibilities:
 * - Provide transaction context for accumulating actions
 * - Execute transaction through engine to get actions
 * - Apply actions to collections (run handlers, write to logs)
 * - Group block operations by cluster
 * - Identify critical clusters (log tail clusters)
 * - GATHER phase: collect nominees from critical clusters (multi-collection only)
 * - PEND/COMMIT/PROPAGATE/CHECKPOINT phases
 */
export class TransactionCoordinator {
	constructor(
		private readonly transactor: ITransactor,
		private readonly engines: Map<string, ITransactionEngine>,
		private readonly collections: Map<CollectionId, Collection<any>>
	) {}

	/**
	 * Begin a new transaction.
	 *
	 * @param engine - The engine to use (default: 'actions@1.0.0')
	 * @returns A new transaction context
	 */
	begin(engine: string = 'actions@1.0.0'): TransactionContext {
		const transactionId = createTransactionId('local', Date.now());
		return new TransactionContext(this, transactionId, engine);
	}

	/**
	 * Commit a transaction context.
	 *
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

		// Create transaction payload
		const transaction: Transaction = {
			engine: context.engine,
			payload: createActionsPayload(collectionActions),
			reads: context.getReads(),
			transactionId: context.transactionId,
			cid: '' // Will be computed
		};
		transaction.cid = createTransactionCid(transaction);

		// Execute through standard path
		return await this.execute(transaction);
	}

	/**
	 * Execute a fully-formed transaction.
	 *
	 * This can be called directly with a complete transaction (e.g., from Quereus),
	 * or indirectly via commitTransaction().
	 *
	 * @param transaction - The transaction to execute
	 * @returns Execution result with actions and results
	 */
	async execute(transaction: Transaction): Promise<ExecutionResult> {
		// 1. Get engine and execute to get actions
		const engine = this.getEngine(transaction.engine);
		if (!engine) {
			return {
				success: false,
				error: `Unknown engine: ${transaction.engine}`
			};
		}

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
		// TODO: Implement action application
		// For now, return placeholder
		return {
			success: false,
			error: 'applyActionsToCollection not yet implemented'
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
			collectionTransforms,
			superclusterNominees
		);
		if (!pendResult.success) {
			return pendResult;
		}

		// 3. COMMIT phase: commit to all critical blocks
		const commitResult = await this.commitPhase(
			criticalBlockIds,
			transaction.transactionId
		);
		if (!commitResult.success) {
			// Cancel pending actions on failure
			await this.cancelPhase(collectionTransforms, transaction.transactionId);
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
		collectionTransforms: Map<CollectionId, Transforms>,
		_superclusterNominees: Set<PeerId> | null
	): Promise<{ success: boolean; error?: string }> {
		// TODO: Implement multi-collection pend
		// For now, just validate that we have transforms
		if (collectionTransforms.size === 0) {
			return { success: false, error: 'No transforms to pend' };
		}

		return { success: true };
	}

	/**
	 * COMMIT phase: Commit to all critical blocks.
	 */
	private async commitPhase(
		_criticalBlockIds: BlockId[],
		_transactionId: string
	): Promise<{ success: boolean; error?: string }> {
		// TODO: Implement multi-collection commit
		return { success: true };
	}

	/**
	 * CANCEL phase: Cancel pending actions on all affected blocks.
	 */
	private async cancelPhase(
		_collectionTransforms: Map<CollectionId, Transforms>,
		_transactionId: string
	): Promise<void> {
		// TODO: Implement multi-collection cancel
	}

	/**
	 * Get the engine for a given engine identifier.
	 */
	private getEngine(engineId: string): ITransactionEngine | undefined {
		return this.engines.get(engineId);
	}
}

