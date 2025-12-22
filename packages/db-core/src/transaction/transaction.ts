import type { BlockId } from "../blocks/index.js";
import type { CollectionId } from "../collection/index.js";

/**
 * Transaction Stamp: Created at BEGIN, stable throughout transaction lifecycle.
 *
 * The stamp contains metadata about the transaction's origin and context.
 * The id is computed as a hash of these fields.
 */
export type TransactionStamp = {
	/** Peer that initiated the transaction */
	peerId: string;

	/** When transaction started (milliseconds since epoch) */
	timestamp: number;

	/** Hash of schema version(s) for validation */
	schemaHash: string;

	/** Which engine (e.g., 'quereus@0.5.3', 'actions@1.0.0') */
	engineId: string;

	/** Hash of the stamp fields (computed) - stable identifier throughout transaction */
	id: string;
};

/**
 * Transaction: Finalized at COMMIT with complete statement history.
 *
 * Transactions span multiple collections and use pluggable engines for interpreting the statements.
 * The engine re-executes the statements to verify the resulting operations match what was proposed.
 */
export type Transaction = {
	/** The transaction stamp (includes stable id) */
	stamp: TransactionStamp;

	/** Engine-specific statements (for replay/validation)
	 * Array of statements executed during the transaction.
	 * - For Quereus: SQL statements
	 * - For ActionsEngine: JSON-encoded actions
	 */
	statements: string[];

	/** Read dependencies for optimistic concurrency control */
	reads: ReadDependency[];

	/** Transaction identifier (hash of stamp.id + statements + reads)
	 * Final transaction identity, used in logs
	 */
	id: string;
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
 * Just the transaction ID - full transaction can be looked up separately if needed.
 */
export type TransactionRef = string; // The transaction ID

/**
 * Create a transaction stamp with computed id.
 * The id is a hash of the stamp fields.
 */
export function createTransactionStamp(
	peerId: string,
	timestamp: number,
	schemaHash: string,
	engineId: string
): TransactionStamp {
	const stampData = JSON.stringify({ peerId, timestamp, schemaHash, engineId });
	const id = `stamp:${hashString(stampData)}`;
	return { peerId, timestamp, schemaHash, engineId, id };
}

/**
 * Create a transaction id from stamp id, statements, and reads.
 * This is the final transaction identity used in logs.
 */
export function createTransactionId(
	stampId: string,
	statements: string[],
	reads: ReadDependency[]
): string {
	const txData = JSON.stringify({ stampId, statements, reads });
	return `tx:${hashString(txData)}`;
}

/**
 * Simple hash function for creating IDs.
 * Uses a basic hash for now - can be replaced with proper cryptographic hash later.
 */
function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash).toString(36);
}

/**
 * Transaction engine interface.
 * Pluggable engines implement this to process transaction statements.
 *
 * Engines are responsible for:
 * 1. Parsing the engine-specific statements
 * 2. Executing/re-executing to produce actions
 * 3. Returning the resulting actions per collection
 */
export interface ITransactionEngine {
	/**
	 * Process a transaction statements to produce actions.
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

/**
 * Result of transaction validation.
 */
export type ValidationResult = {
	/** Whether validation succeeded */
	valid: boolean;
	/** Reason for validation failure (if valid=false) */
	reason?: string;
	/** The operations hash computed during validation (for debugging) */
	computedHash?: string;
};

/**
 * Transaction validator interface.
 * Pluggable validators implement this to verify transaction integrity.
 *
 * Validators are invoked when a node receives a PendRequest with a transaction.
 * They re-execute the transaction and verify the operations match.
 */
export interface ITransactionValidator {
	/**
	 * Validate a transaction by re-executing and comparing operations hash.
	 *
	 * Validation steps:
	 * 1. Verify stamp.engineId matches a known engine
	 * 2. Verify stamp.schemaHash matches local schema
	 * 3. Verify read dependencies (no stale reads)
	 * 4. Re-execute transaction.statements through engine (isolated state)
	 * 5. Collect operations from re-execution
	 * 6. Compute hash of operations
	 * 7. Compare with sender's operationsHash
	 *
	 * @param transaction - The transaction to validate
	 * @param operationsHash - The hash to compare against
	 * @returns Validation result
	 */
	validate(transaction: Transaction, operationsHash: string): Promise<ValidationResult>;

	/**
	 * Get the schema hash for a given engine.
	 * Used to verify the sender's schema matches local schema.
	 *
	 * @param engineId - The engine identifier
	 * @returns The schema hash, or undefined if engine not found
	 */
	getSchemaHash(engineId: string): Promise<string | undefined>;
}

