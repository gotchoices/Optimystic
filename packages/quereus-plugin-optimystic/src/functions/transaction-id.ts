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
 * What counts as "a transaction is active":
 *
 * - Inside an explicit `begin`: that transaction's stamp.
 * - In an autocommit WRITE statement, once any Optimystic connection is registered with the
 *   `Database` — any Optimystic table created, touched or hydrated in it: the stamp of the
 *   transaction Quereus opens for that statement. Quereus begins it before it evaluates the
 *   statement, so `insert … values (StampId(), …)` stores the stamp rather than NULL, and that
 *   holds whether or not the statement writes an Optimystic table.
 * - In an autocommit READ (`select StampId()` on its own): NULL. Quereus opens no transaction for
 *   a statement with no side effects, so there is none to name.
 * - On a `Database` with no Optimystic table at all: NULL. There is no Optimystic transaction.
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

