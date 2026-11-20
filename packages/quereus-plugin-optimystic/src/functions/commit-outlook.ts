import type { SqlValue } from '@quereus/quereus';
import type { TransactionBridge } from '../optimystic-adapter/txn-bridge.js';
import type { OfflineMode } from '../optimystic-adapter/offline-mode.js';
import { renderCommitOutlook } from '../optimystic-adapter/commit-outlook.js';

/**
 * CommitOutlook() SQL function (docs/offline-sync.md §Using the outlook before committing)
 *
 * Returns, as JSON, the `CommitOutlook` the current transaction would get if it were committed now:
 * what it has staged so far, judged behind every transaction queued on this machine
 * (`OfflineMode.openTransactionOutlook`). Active exactly when `StampId()` is, by the same rule: an
 * explicit transaction, or the transaction Quereus opens for an autocommit WRITE statement once any
 * Optimystic connection is registered with the `Database`; NULL for an autocommit read such as
 * `select CommitOutlook()` on its own, and on a `Database` with no Optimystic table (see
 * `createStampIdFunction`).
 * It reflects what is staged at the moment it is evaluated, so inside a statement that also writes it
 * sees the rows that statement has staged before it.
 */
export function createCommitOutlookFunction(txnBridge: TransactionBridge, offline: OfflineMode) {
	return function commitOutlook(): SqlValue {
		if (!txnBridge.getCurrentTransaction()?.isActive) return null;
		return renderCommitOutlook(offline.openTransactionOutlook());
	};
}
