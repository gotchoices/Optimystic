import type { CollectionId, ActionId } from "../index.js";
import type { TransactionCoordinator } from "./coordinator.js";
import type { ReadDependency, ExecutionResult } from "./transaction.js";
import type { Action } from "../collection/action.js";

/**
 * Transaction context for accumulating actions and reads.
 *
 * Usage:
 *   const txn = coordinator.begin();
 *   txn.addAction('users', { type: 'insert', data: {...} });
 *   txn.addAction('users', { type: 'get', data: { key: 1 } });
 *   const result = await txn.commit();
 */
export class TransactionContext {
	private readonly collectionActions: Map<CollectionId, Action<any>[]> = new Map();
	private readonly reads: ReadDependency[] = [];

	constructor(
		private readonly coordinator: TransactionCoordinator,
		public readonly transactionId: string,
		public readonly engine: string
	) {}

	/**
	 * Add an action to a collection.
	 *
	 * Actions are collection-specific:
	 * - Tree: 'insert', 'delete', 'get', 'scan'
	 * - Diary: 'append', 'read'
	 * - etc.
	 */
	async addAction(collectionId: CollectionId, action: Action<any>): Promise<void> {
		// Tag action with transaction reference
		const taggedAction = {
			...action,
			transaction: this.transactionId
		};

		// Get the collection and immediately execute the action to update local snapshot
		const collection = this.coordinator['collections'].get(collectionId);
		if (collection) {
			// Execute through collection to update tracker and pending buffer
			await collection.act(taggedAction);
		}
		// If no collection registered, just buffer the action (for testing or deferred collection creation)

		// Record in transaction context
		if (!this.collectionActions.has(collectionId)) {
			this.collectionActions.set(collectionId, []);
		}
		this.collectionActions.get(collectionId)!.push(taggedAction);
	}

	/**
	 * Add a read dependency for optimistic concurrency control.
	 */
	addRead(read: ReadDependency): void {
		this.reads.push(read);
	}

	/**
	 * Commit the transaction.
	 *
	 * This executes all accumulated actions across all affected collections,
	 * coordinating with the network as needed.
	 */
	async commit(): Promise<ExecutionResult> {
		return await this.coordinator.commitTransaction(this);
	}

	/**
	 * Rollback the transaction (just discard accumulated state).
	 */
	rollback(): void {
		this.collectionActions.clear();
		this.reads.length = 0;
	}

	/**
	 * Get all accumulated actions by collection.
	 * Used by coordinator during commit.
	 */
	getCollectionActions(): Map<CollectionId, Action<any>[]> {
		return this.collectionActions;
	}

	/**
	 * Get all accumulated read dependencies.
	 * Used by coordinator during commit.
	 */
	getReads(): ReadDependency[] {
		return this.reads;
	}

	/**
	 * Get the set of affected collection IDs.
	 */
	getAffectedCollections(): Set<CollectionId> {
		return new Set(this.collectionActions.keys());
	}
}

