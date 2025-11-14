import type { ITransactionEngine, Transaction, ExecutionResult, CollectionActions } from './transaction.js';

/**
 * Built-in action-based transaction engine for testing.
 *
 * This engine treats the payload as a JSON-encoded list of collection actions.
 * It's useful for testing the transaction infrastructure without needing SQL.
 *
 * Payload format:
 * ```json
 * {
 *   "collections": [
 *     {
 *       "collectionId": "users",
 *       "actions": [
 *         { "type": "insert", "data": { "id": 1, "name": "Alice" } }
 *       ]
 *     }
 *   ]
 * }
 * ```
 */
export class ActionsEngine implements ITransactionEngine {
	async execute(transaction: Transaction): Promise<ExecutionResult> {
		try {
			// Parse the payload
			const payload = JSON.parse(transaction.payload) as ActionsPayload;

			// Validate payload structure
			if (!payload.collections || !Array.isArray(payload.collections)) {
				return {
					success: false,
					error: 'Invalid payload: missing or invalid collections array'
				};
			}

			// Validate each collection
			for (const collection of payload.collections) {
				if (!collection.collectionId || typeof collection.collectionId !== 'string') {
					return {
						success: false,
						error: 'Invalid payload: collection missing collectionId'
					};
				}

				if (!collection.actions || !Array.isArray(collection.actions)) {
					return {
						success: false,
						error: `Invalid payload: collection ${collection.collectionId} missing or invalid actions array`
					};
				}
			}

			// Return the actions as-is (no re-execution needed for this simple engine)
			return {
				success: true,
				actions: payload.collections
			};
		} catch (error) {
			return {
				success: false,
				error: `Failed to parse payload: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
}

/**
 * Payload format for the actions engine.
 */
export type ActionsPayload = {
	collections: CollectionActions[];
};

/**
 * Helper to create an actions-based transaction payload.
 */
export function createActionsPayload(collections: CollectionActions[]): string {
	return JSON.stringify({ collections } satisfies ActionsPayload);
}

/**
 * Helper to create a transaction ID from peer ID and timestamp.
 */
export function createTransactionId(peerId: string, timestamp: number): string {
	return `${peerId}-${timestamp}`;
}

/**
 * Helper to create a content ID (CID) for a transaction.
 * In a real implementation, this would use a cryptographic hash.
 * For now, we use a simple hash of the stringified transaction.
 */
export function createTransactionCid(transaction: Omit<Transaction, 'cid'>): string {
	const content = JSON.stringify({
		engine: transaction.engine,
		payload: transaction.payload,
		reads: transaction.reads,
		transactionId: transaction.transactionId
	});

	// Simple hash for now (in production, use SHA-256 or similar)
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}

	return `cid-${Math.abs(hash).toString(16)}`;
}

