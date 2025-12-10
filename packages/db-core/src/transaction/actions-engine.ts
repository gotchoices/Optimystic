import type { ITransactionEngine, Transaction, ExecutionResult, CollectionActions } from './transaction.js';
import type { TransactionCoordinator } from './coordinator.js';

export const ACTIONS_ENGINE_ID = "actions@1.0.0";

/**
 * Built-in action-based transaction engine for testing.
 *
 * This engine treats each statement as a JSON-encoded CollectionActions object.
 * It's useful for testing the transaction infrastructure without needing SQL.
 *
 * Each statement format:
 * ```json
 * {
 *   "collectionId": "users",
 *   "actions": [
 *     { "type": "insert", "data": { "id": 1, "name": "Alice" } }
 *   ]
 * }
 * ```
 */
export class ActionsEngine implements ITransactionEngine {
	constructor(private coordinator: TransactionCoordinator) {}

	async execute(transaction: Transaction): Promise<ExecutionResult> {
		try {
			// Parse each statement as a CollectionActions object
			const allActions: CollectionActions[] = [];

			for (const statement of transaction.statements) {
				const collectionActions = JSON.parse(statement) as CollectionActions;

				// Validate structure
				if (!collectionActions.collectionId || typeof collectionActions.collectionId !== 'string') {
					return {
						success: false,
						error: 'Invalid statement: missing collectionId'
					};
				}

				if (!collectionActions.actions || !Array.isArray(collectionActions.actions)) {
					return {
						success: false,
						error: `Invalid statement: collection ${collectionActions.collectionId} missing or invalid actions array`
					};
				}

				allActions.push(collectionActions);

				// Apply actions through coordinator (for validation/replay)
				await this.coordinator.applyActions([collectionActions], transaction.stamp.id);
			}

			// Return success (actions already applied)
			return {
				success: true,
				actions: allActions
			};
		} catch (error) {
			return {
				success: false,
				error: `Failed to execute transaction: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
}

/**
 * Statement format for the actions engine (array of CollectionActions).
 * @deprecated Use CollectionActions[] directly
 */
export type ActionsStatement = {
	collections: CollectionActions[];
};

/**
 * Helper to create an actions-based transaction statements array.
 * Each CollectionActions becomes a separate statement.
 */
export function createActionsStatements(collections: CollectionActions[]): string[] {
	return collections.map(c => JSON.stringify(c));
}

