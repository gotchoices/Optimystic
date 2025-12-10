import type { TransactionCoordinator } from "./coordinator.js";
import type { Transaction, ExecutionResult, ITransactionEngine, TransactionStamp, CollectionActions } from "./transaction.js";
import { createTransactionStamp, createTransactionId } from "./transaction.js";

/**
 * TransactionSession manages incremental transaction building.
 *
 * This is the high-level API for building transactions incrementally:
 * - Stamp is created at BEGIN (stable throughout transaction)
 * - Execute statements one at a time
 * - Engine translates statements to actions (if not already provided)
 * - Actions are immediately applied to collections via coordinator.applyActions()
 * - On commit, all statements are compiled into a complete Transaction
 * - The Transaction is then committed through coordinator.commit() for PEND/COMMIT orchestration
 *
 * Usage:
 *   const session = new TransactionSession(coordinator, engine);
 *   await session.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);
 *   await session.execute('SELECT * FROM orders WHERE user_id = ?', [1]);
 *   const result = await session.commit();
 *
 * For validation/replay, use engine.execute() directly with a complete Transaction.
 */
export class TransactionSession {
	private readonly statements: string[] = [];
	private readonly stamp: TransactionStamp;
	private committed = false;
	private rolledBack = false;

	constructor(
		private readonly coordinator: TransactionCoordinator,
		private readonly engine: ITransactionEngine,
		peerId: string = 'local', // TODO: Get from coordinator or config
		schemaHash: string = '' // TODO: Get from engine
	) {
		// Create stamp at BEGIN (stable throughout transaction)
		this.stamp = createTransactionStamp(
			peerId,
			Date.now(),
			schemaHash,
			'unknown' // TODO: Get engine ID from engine
		);
	}

	/**
	 * Execute a statement.
	 *
	 * If actions are provided, they are applied directly.
	 * Otherwise, the engine translates the statement to actions.
	 *
	 * @param statement - The statement to execute (engine-specific, e.g., SQL statement)
	 * @param actions - Optional pre-computed actions (for Quereus module case)
	 * @returns Execution result with any returned values
	 */
	async execute(statement: string, actions?: CollectionActions[]): Promise<{ success: boolean; error?: string }> {
		if (this.committed) {
			return { success: false, error: 'Transaction already committed' };
		}
		if (this.rolledBack) {
			return { success: false, error: 'Transaction already rolled back' };
		}

		try {
			// If actions not provided, enlist engine to translate statement
			let actionsToApply: CollectionActions[];
			if (actions) {
				actionsToApply = actions;
			} else {
				// Create a temporary transaction with just this statement for translation
				const tempTransaction: Transaction = {
					stamp: this.stamp,
					statements: [statement],
					reads: [],
					id: 'temp' // Temporary ID for translation only
				};
				const result = await this.engine.execute(tempTransaction);
				if (!result.success || !result.actions) {
					return { success: false, error: result.error || 'Failed to translate statement' };
				}
				actionsToApply = result.actions;
			}

			// Apply actions through coordinator
			await this.coordinator.applyActions(actionsToApply, this.stamp.id);

			// Accumulate the statement for later compilation
			this.statements.push(statement);

			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: `Failed to execute statement: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	/**
	 * Commit the transaction.
	 *
	 * Compiles all statements into a complete Transaction and commits through coordinator.
	 */
	async commit(): Promise<ExecutionResult> {
		if (this.committed) {
			return { success: false, error: 'Transaction already committed' };
		}
		if (this.rolledBack) {
			return { success: false, error: 'Transaction already rolled back' };
		}

		// Create the complete transaction
		const transaction: Transaction = {
			stamp: this.stamp,
			statements: this.statements,
			reads: [], // TODO: Track reads during statement execution
			id: createTransactionId(this.stamp.id, this.statements, [])
		};

		// Commit through coordinator (which will orchestrate PEND/COMMIT)
		await this.coordinator.commit(transaction);

		this.committed = true;
		return { success: true };
	}

	/**
	 * Rollback the transaction (discard local state).
	 *
	 * Note: Actions have already been applied to collections' trackers.
	 * Rollback just prevents commit and clears session state.
	 * Collections will discard tracker state when they sync or update.
	 */
	async rollback(): Promise<void> {
		if (this.committed) {
			throw new Error('Cannot rollback: transaction already committed');
		}
		if (this.rolledBack) {
			throw new Error('Transaction already rolled back');
		}

		// Rollback through coordinator
		await this.coordinator.rollback(this.stamp.id);
		this.rolledBack = true;
		this.statements.length = 0;
	}

	/**
	 * Get the transaction stamp ID (stable throughout transaction).
	 */
	getStampId(): string {
		return this.stamp.id;
	}

	/**
	 * Get the transaction stamp (full metadata).
	 */
	getStamp(): TransactionStamp {
		return this.stamp;
	}

	/**
	 * Get the list of accumulated statements.
	 */
	getStatements(): readonly string[] {
		return this.statements;
	}

	/**
	 * Check if the transaction has been committed.
	 */
	isCommitted(): boolean {
		return this.committed;
	}

	/**
	 * Check if the transaction has been rolled back.
	 */
	isRolledBack(): boolean {
		return this.rolledBack;
	}
}

