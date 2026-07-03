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
	 * snapshot/restore once (idempotent per depth). Synchronous: the underlying
	 * collection snapshot/restore are in-memory ops.
	 */
	createSavepoint(index: number): void {
		this.txnBridge.createSavepoint(index);
	}

	/** Releases a savepoint with the given index (see {@link createSavepoint}) */
	releaseSavepoint(index: number): void {
		this.txnBridge.releaseSavepoint(index);
	}

	/** Rolls back to a savepoint with the given index (see {@link createSavepoint}) */
	rollbackToSavepoint(index: number): void {
		this.txnBridge.rollbackToSavepoint(index);
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

