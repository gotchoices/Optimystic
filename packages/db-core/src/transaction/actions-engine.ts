import type { ITransactionEngine, Transaction, ExecutionResult, CollectionActions } from './transaction.js';

export const ACTIONS_ENGINE_ID = "actions@1.0.0";

/**
 * Built-in action-based transaction engine for testing.
 *
 * This engine treats each statement as a JSON-encoded CollectionActions object.
 * It's useful for testing the transaction infrastructure without needing SQL.
 *
 * This is a PURE TRANSLATOR (model (a) of the {@link ITransactionEngine} contract):
 * execute() parses statements into CollectionActions[] and RETURNS them. It never
 * touches a coordinator or mutates any collection state — application is the sole
 * responsibility of the session/coordinator that receives the returned actions.
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
	readonly id = ACTIONS_ENGINE_ID;

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
			}

			// Pure translation: return parsed actions WITHOUT applying them. The caller
			// (session.execute / coordinator.execute) applies them exactly once.
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
