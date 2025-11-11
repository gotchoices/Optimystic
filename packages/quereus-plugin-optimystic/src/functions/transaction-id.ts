import type { SqlValue } from '@quereus/quereus';
import type { TransactionBridge } from '../optimystic-adapter/txn-bridge.js';

/**
 * TransactionId() SQL function
 * 
 * Returns the current transaction ID if a transaction is active, NULL otherwise.
 * The transaction ID is unique across the distributed system and stable within
 * a transaction, cycling between transactions.
 * 
 * Format: 32 bytes base64url encoded
 * - First 16 bytes: SHA-256 hash of peer ID (for distributed uniqueness)
 * - Last 16 bytes: Random bytes (for collision resistance)
 * 
 * @returns The current transaction ID string, or NULL if no transaction is active
 */
export function createTransactionIdFunction(txnBridge: TransactionBridge) {
	return function transactionId(): SqlValue {
		const currentTxn = txnBridge.getCurrentTransaction();
		
		if (!currentTxn || !currentTxn.isActive) {
			return null;
		}
		
		return currentTxn.transactionId;
	};
}

