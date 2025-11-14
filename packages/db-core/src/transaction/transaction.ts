import type { BlockId } from "../blocks/index.js";
import type { CollectionId } from "../collection/index.js";

/**
 * Transaction represents a multi-collection mutation with pluggable validation.
 *
 * Transactions span multiple collections and use pluggable engines for validation.
 * The engine re-executes the payload to verify the resulting actions match what was proposed.
 */
export type Transaction = {
	/** Engine identification (e.g., "quereus@0.5.3", "actions@1.0.0") */
	engine: string;

	/** Engine-specific payload
	 * - For Quereus: JSON-encoded SQL statements
	 * - For testing: JSON-encoded actions
	 */
	payload: string;

	/** Read dependencies for optimistic concurrency control */
	reads: ReadDependency[];

	/** Transaction identifier (used for deduplication, auditing)
	 * Hash of peer ID + timestamp
	 */
	transactionId: string;

	/** Content identifier (hash of all above fields)
	 * Cryptographic hash for integrity verification
	 */
	cid: string;
};

/**
 * Read dependency for optimistic concurrency control.
 * Tracks which block revisions were read during transaction execution.
 */
export type ReadDependency = {
	blockId: BlockId;
	/** Expected revision number at time of read */
	revision: number;
};

/**
 * Transaction reference embedded in actions.
 * Just the CID - full transaction can be looked up separately if needed.
 */
export type TransactionRef = string; // The transaction CID

/**
 * Transaction engine interface.
 * Pluggable engines implement this to process transaction payloads.
 *
 * Engines are responsible for:
 * 1. Parsing the engine-specific payload
 * 2. Executing/re-executing to produce actions
 * 3. Returning the resulting actions per collection
 */
export interface ITransactionEngine {
	/**
	 * Process a transaction payload to produce actions.
	 *
	 * Used both for:
	 * - Initial execution (client creating transaction)
	 * - Re-execution (validators verifying transaction)
	 *
	 * @param transaction - The transaction to process
	 * @returns The resulting actions from execution
	 */
	execute(transaction: Transaction): Promise<ExecutionResult>;
}

/**
 * Result of transaction execution.
 */
export type ExecutionResult = {
	/** Whether execution succeeded */
	success: boolean;
	/** Actions produced by executing the transaction */
	actions?: CollectionActions[];
	/** Results from executing actions (e.g., return values from reads) */
	results?: Map<CollectionId, any[]>;
	/** Error message if execution failed */
	error?: string;
};

/**
 * Actions for a specific collection resulting from transaction execution.
 */
export type CollectionActions = {
	/** Collection identifier */
	collectionId: string;
	/** Actions to apply to this collection */
	actions: unknown[];
};

