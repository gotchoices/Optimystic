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

	/** Creates a savepoint with the given index */
	createSavepoint(_index: number): void {
		// Optimystic doesn't currently support savepoints
		// This is a no-op for now
	}

	/** Releases a savepoint with the given index */
	releaseSavepoint(_index: number): void {
		// Optimystic doesn't currently support savepoints
		// This is a no-op for now
	}

	/** Rolls back to a savepoint with the given index */
	rollbackToSavepoint(_index: number): void {
		// Optimystic doesn't currently support savepoints
		// This is a no-op for now
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

