/**
 * VirtualTableConnection implementation for Optimystic tables.
 * Wraps the TransactionBridge to provide the generic VirtualTableConnection interface.
 */

import type { VirtualTableConnection } from '@quereus/quereus';
import type { TransactionBridge } from './txn-bridge.js';
import type { ParsedOptimysticOptions } from '../types.js';

let connectionCounter = 0;

/**
 * Connection wrapper that bridges Quereus transaction lifecycle to Optimystic TransactionBridge
 */
export class OptimysticVirtualTableConnection implements VirtualTableConnection {
	public readonly connectionId: string;
	public readonly tableName: string;
	private txnBridge: TransactionBridge;
	private options: ParsedOptimysticOptions;

	constructor(tableName: string, txnBridge: TransactionBridge, options: ParsedOptimysticOptions) {
		this.connectionId = `optimystic-${tableName}-${++connectionCounter}`;
		this.tableName = tableName;
		this.txnBridge = txnBridge;
		this.options = options;
	}

	/** Begins a transaction on this connection */
	async begin(): Promise<void> {
		await this.txnBridge.beginTransaction(this.options);
	}

	/** Commits the current transaction */
	async commit(): Promise<void> {
		// For implicit transactions, Quereus may call commit() without calling begin() first
		// In this case, we need to start a transaction before committing
		//
		// NOTE: this is also the path every connection AFTER the first takes at each commit —
		// Quereus broadcasts commit to all of them, the first one ends the bridge's transaction,
		// and the rest arrive to find it inactive and begin-and-commit an empty one. So each extra
		// registered connection adds one empty begin and commit to every later transaction, which
		// in session mode includes a `TransactionSession.create`. Cheap per connection, and the
		// reason `hydrateCatalog` registers exactly one (see `registerBridgeConnection`) rather
		// than one per hydrated table; if a host ever ends up with many Optimystic connections on
		// one Database and commits show the cost, make this a no-op for a transaction already
		// committed by a sibling connection instead of opening a fresh one.
		const currentTxn = this.txnBridge.getCurrentTransaction();
		if (!currentTxn?.isActive) {
			await this.txnBridge.beginTransaction(this.options);
		}
		await this.txnBridge.commitTransaction();
	}

	/** Rolls back the current transaction */
	async rollback(): Promise<void> {
		await this.txnBridge.rollbackTransaction();
	}

	/**
	 * Savepoint lifecycle. Quereus broadcasts these (by numeric depth) to every
	 * connection for statement-, row-, and user-level atomicity; each connection
	 * delegates to the shared {@link TransactionBridge}, which does the actual
	 * snapshot/restore once (idempotent per depth). Create and release are
	 * synchronous in-memory ops; rollback is awaited, because a restore can replay
	 * the collection's staged actions (see {@link rollbackToSavepoint}).
	 */
	createSavepoint(index: number): void {
		this.txnBridge.createSavepoint(index);
	}

	/** Releases a savepoint with the given index (see {@link createSavepoint}) */
	releaseSavepoint(index: number): void {
		this.txnBridge.releaseSavepoint(index);
	}

	/**
	 * Rolls back to a savepoint with the given index (see {@link createSavepoint}).
	 * Quereus types the hook as `MaybePromise<void>` and awaits it for each connection
	 * before the statement continues (`_rollbackToSavepointBroadcast` in
	 * `@quereus/quereus/src/core/database.ts`), so the restore — which replays the
	 * collection's sealed segments when they changed while the savepoint was open — is
	 * complete before the next statement runs.
	 */
	async rollbackToSavepoint(index: number): Promise<void> {
		await this.txnBridge.rollbackToSavepoint(index);
	}

	/** Disconnects and cleans up this connection */
	async disconnect(): Promise<void> {
		// If there's an active transaction, roll it back
		const currentTxn = this.txnBridge.getCurrentTransaction();
		if (currentTxn?.isActive) {
			await this.txnBridge.rollbackTransaction();
		}
	}
}

