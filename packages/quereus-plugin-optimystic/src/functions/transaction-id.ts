import type { SqlValue } from '@quereus/quereus';
import type { TransactionBridge } from '../optimystic-adapter/txn-bridge.js';

/**
 * StampId() SQL function
 *
 * Returns the current transaction (stamp) ID if a transaction is active, NULL otherwise.
 * The stamp ID is unique across the distributed system and stable within
 * a transaction, cycling between transactions. It is primarily used for passing
 * to `WITH CONTEXT` clauses to track transaction provenance.
 *
 * Format: 32 bytes base64url encoded
 * - First 16 bytes: SHA-256 hash of peer ID (for distributed uniqueness)
 * - Last 16 bytes: Random bytes (for collision resistance)
 *
 * @returns The current stamp ID string, or NULL if no transaction is active
 */
export function createStampIdFunction(txnBridge: TransactionBridge) {
	return function stampId(): SqlValue {
		const currentTxn = txnBridge.getCurrentTransaction();

		if (!currentTxn || !currentTxn.isActive) {
			return null;
		}

		return currentTxn.stampId;
	};
}

