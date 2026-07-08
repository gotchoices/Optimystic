import { randomBytes } from "@noble/hashes/utils.js";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import type { BlockId } from "../blocks/index.js";
import type { CollectionId } from "../collection/index.js";
import { hashString } from "../utility/hash-string.js";

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

	/** Absolute ms epoch after which transaction is invalid */
	expiration: number;

	/**
	 * Random per-transaction nonce, folded into {@link TransactionStamp.id}.
	 *
	 * Anti-replay for read-free transactions: a transaction with no reads has nothing
	 * binding it to a point in history beyond {@link expiration}, so without this a
	 * captured signed read-free transaction could be re-submitted within the TTL window.
	 * The nonce makes two otherwise-identical transactions from the same peer at the
	 * same millisecond produce different ids (hence different signed bytes).
	 */
	nonce: string;

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

	/**
	 * Optional client signature (base64url) over {@link clientSignaturePayload}
	 * `(stamp.id, statements, reads)`, produced at commit by an injected
	 * {@link TransactionSigner}.
	 *
	 * A node that wires a {@link ClientSignatureVerifier} into its
	 * {@link TransactionValidator} verifies this at pend; where no verifier is wired,
	 * unsigned transactions are still accepted (migration / single-node-dev posture).
	 * Plain field on the transaction, so it rides along through serialization/persistence
	 * for later recovery-time re-verification.
	 */
	signature?: string;
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

/** Default transaction time-to-live in milliseconds (30 seconds). */
export const DEFAULT_TRANSACTION_TTL_MS = 30_000;

/** Check whether a transaction stamp has expired. */
export function isTransactionExpired(stamp: TransactionStamp): boolean {
	return Date.now() > stamp.expiration;
}

/**
 * Create a transaction stamp with computed id.
 * The id is a hash of the stamp fields (including expiration).
 */
export async function createTransactionStamp(
	peerId: string,
	timestamp: number,
	schemaHash: string,
	engineId: string,
	ttlMs: number = DEFAULT_TRANSACTION_TTL_MS
): Promise<TransactionStamp> {
	const expiration = timestamp + ttlMs;
	// Cross-platform CSPRNG (Node + browser) via @noble/hashes — matches the rest of
	// db-core (see collection.ts, transactor-source.ts). The nonce is folded into the
	// id hash so two otherwise-identical stamps diverge.
	const nonce = uint8ArrayToString(randomBytes(16), 'base64url');
	const stampData = JSON.stringify({ peerId, timestamp, schemaHash, engineId, expiration, nonce });
	const id = `stamp:${await hashString(stampData)}`;
	return { peerId, timestamp, schemaHash, engineId, expiration, nonce, id };
}

/**
 * Create a transaction id from stamp id, statements, and reads.
 * This is the final transaction identity used in logs.
 *
 * NOTE: reads are serialized in their given order here (non-canonical). This differs
 * from {@link clientSignaturePayload}, which canonicalises reads before hashing. That is
 * intentional for this ticket — the signature payload is self-contained — but the
 * non-canonical ordering here is a separate hygiene concern (see
 * design-consensus-hygiene-notes), NOT fixed here to avoid changing existing tx ids.
 */
export async function createTransactionId(
	stampId: string,
	statements: string[],
	reads: ReadDependency[]
): Promise<string> {
	const txData = JSON.stringify({ stampId, statements, reads });
	return `tx:${await hashString(txData)}`;
}

/**
 * Version prefix for the client-signature payload, so the signed form can evolve
 * without ambiguity. Distinct from (but consistent in spirit with) the operations-hash
 * canonical form — this covers transaction INPUTS, not operations.
 */
export const CLIENT_SIG_VERSION = 'txsig:v1';

/**
 * Canonical bytes a client signs and a node verifies. Deterministic: reads are sorted
 * (blockId, then revision); statements keep their sequential order.
 *
 * Binds three things at once: the CLIENT IDENTITY (via `stampId`, which hashes peerId +
 * nonce), the EXACT statements, and the OCC read set (blockId + revision — "tail
 * binding" for anti-replay). Both signer and verifier derive the bytes from
 * `transaction.stamp.id` + `transaction.statements` + `transaction.reads` through this
 * one function, so they reproduce identical bytes regardless of read ordering.
 */
export function clientSignaturePayload(
	stampId: string,
	statements: readonly string[],
	reads: readonly ReadDependency[]
): Uint8Array {
	const canonicalReads = [...reads].sort(
		(a, b) => a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1
			: a.revision - b.revision
	);
	const body = JSON.stringify({ stampId, statements, reads: canonicalReads });
	return new TextEncoder().encode(`${CLIENT_SIG_VERSION}:${body}`);
}

/**
 * Signs the canonical client-signature payload, returning base64url. Async to allow
 * libp2p `PrivateKey.sign`; tests pass a synchronous fake.
 */
export type TransactionSigner = (payload: Uint8Array) => Promise<string> | string;

/**
 * Returns true iff `signature` (base64url) is a valid client signature over `payload`
 * for signer identity `peerId`. Total: returns false, never throws, on any malformed
 * input. The p2p wiring backs this with verifyPeerSig + peerIdBindsPublicKey; tests
 * pass a fake.
 */
export type ClientSignatureVerifier =
	(peerId: string, payload: Uint8Array, signature: string) => boolean;



/**
 * Transaction engine interface.
 * Pluggable engines implement this to process transaction statements.
 *
 * Engines are responsible for:
 * 1. Parsing the engine-specific statements
 * 2. Executing/re-executing to produce actions
 * 3. Returning the resulting actions per collection
 *
 * CONTRACT — an engine must never cause the same action to be applied twice. The
 * caller (a {@link TransactionSession} on the no-pre-supplied-actions branch, or a
 * {@link TransactionCoordinator} in `execute()`) applies whatever non-empty
 * `CollectionActions[]` this method RETURNS. Therefore `execute()` must satisfy
 * exactly ONE of:
 *
 *   (a) PURE TRANSLATOR (preferred; how {@link ActionsEngine} works) — parse the
 *       statements, RETURN the actions, and do NOT apply them / do NOT call
 *       `coordinator.applyActions` / do NOT mutate any collection state. The caller
 *       applies them exactly once.
 *
 *   (b) SIDE-EFFECT APPLY — apply the actions itself while translating (e.g. the
 *       Quereus vtab path stages rows into the coordinator during `db.exec`) and then
 *       RETURN an EMPTY actions array, so the caller re-applies nothing.
 *
 * An engine that BOTH applies as a side effect AND returns those same actions
 * double-applies (the caller re-applies the returned actions). Additionally, a
 * side-effecting engine used for validation must apply only to the validator's
 * ISOLATED coordinator — applying to the main coordinator leaks into the validating
 * node's live state.
 */
export interface ITransactionEngine {
	/**
	 * Stable identifier for this engine.
	 *
	 * This is the value stamped into {@link TransactionStamp.engineId} when a
	 * {@link TransactionSession} builds a transaction, and the key a
	 * {@link TransactionValidator} resolves the engine by. It MUST match the key the
	 * engine is registered under in the validator's `engines` map — otherwise a
	 * validating node rejects the transaction as `Unknown engine: <id>` before it
	 * ever re-executes.
	 */
	readonly id: string;

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
	/**
	 * On a PARTIAL multi-collection commit failure, the collections that DID durably
	 * commit through consensus before the failure (and thus CANNOT be rolled back —
	 * reconciliation is required). Absent/empty means nothing durably committed, so
	 * the caller may treat the failure as a clean abort. See
	 * {@link CoordinatorPartialCommitError} for the session-mode (commit) analog.
	 */
	committedCollections?: CollectionId[];
	/** On a partial multi-collection commit failure, the collections that failed to commit. */
	failedCollections?: CollectionId[];
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
 * Helper to create an actions-based transaction statements array.
 * Each CollectionActions becomes a separate JSON-encoded statement.
 */
export function createActionsStatements(collections: CollectionActions[]): string[] {
	return collections.map(c => JSON.stringify(c));
}

/**
 * Statement format for the actions engine (array of CollectionActions).
 * @deprecated Use CollectionActions[] directly
 */
export type ActionsStatement = {
	collections: CollectionActions[];
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

