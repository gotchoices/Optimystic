/**
 * Quereus-specific transaction validator factory.
 *
 * Creates a TransactionValidator configured for Quereus SQL transactions.
 * The validator re-executes SQL statements and compares operations hashes.
 */

import type { Database } from '@quereus/quereus';
import type {
	TransactionCoordinator,
	ITransactionValidator,
	CollectionActions,
	BlockStateProvider,
	ClientSignatureVerifier,
} from '@optimystic/db-core';
import { TransactionValidator, type EngineRegistration, type ValidationCoordinatorFactory, b64urlToBytes } from '@optimystic/db-core';
import { verifyPeerSig } from '@optimystic/db-p2p';
import { QuereusEngine, QUEREUS_ENGINE_ID } from './quereus-engine.js';

/**
 * Options for creating a Quereus transaction validator.
 */
export interface QuereusValidatorOptions {
	/** The Quereus database instance (with same schema as transactions being validated) */
	db: Database;
	/** The transaction coordinator for the database */
	coordinator: TransactionCoordinator;
	/** Optional provider for looking up current block state (for read dependency validation) */
	blockStateProvider?: BlockStateProvider;
	/**
	 * Enforce client transaction signatures. When `true`, the validator wires a verifier port so
	 * `validate()` rejects a transaction that is unsigned (`Missing client signature`) or whose
	 * signature does not verify against `stamp.peerId` (`Invalid client signature`). When `false`
	 * (the default — phased rollout), the port is omitted and unsigned AND signed transactions both
	 * pass the signature step, keeping single-node / dev / not-yet-migrated deployments working.
	 *
	 * Migration order: land this (clients with a node key start signing immediately), observe clients
	 * signing in the field, THEN flip this to `true` to start rejecting. Flipping it on before clients
	 * sign rejects every legacy (unsigned) client at pend.
	 */
	requireClientSignature?: boolean;
}

/**
 * The p2p-backed {@link ClientSignatureVerifier}: derive the signer's Ed25519 public key from the
 * peer-id string embedded in `stamp.peerId` and verify the base64url signature over the canonical
 * payload. `verifyPeerSig` is total (returns `false`, never throws, on a non-Ed25519 / malformed
 * peer-id or bad signature); the try/catch additionally makes the base64url decode total, so the
 * whole verifier honors the "never throws" contract even on adversarial input.
 */
function createClientSignatureVerifier(): ClientSignatureVerifier {
	return (peerId: string, payload: Uint8Array, signature: string): boolean => {
		try {
			return verifyPeerSig(peerId, payload, b64urlToBytes(signature));
		} catch {
			return false;
		}
	};
}

/**
 * Create a TransactionValidator configured for Quereus SQL transactions.
 *
 * The validator:
 * 1. Checks engine ID matches QUEREUS_ENGINE_ID
 * 2. Compares schema hash against local Quereus schema
 * 3. Re-executes SQL statements through the provided Database
 * 4. Compares operations hash
 *
 * For Quereus, SQL execution flows through:
 *   QuereusEngine.execute() → db.exec() → virtual table → coordinator
 *
 * Transforms are collected from the coordinator after execution.
 * The coordinator is reset before each validation to ensure isolation.
 *
 * @param options - Configuration for the validator
 * @returns A TransactionValidator instance
 */
export function createQuereusValidator(options: QuereusValidatorOptions): ITransactionValidator {
	const { db, coordinator } = options;

	// Create QuereusEngine for re-execution
	const engine = new QuereusEngine(db, coordinator);

	// Register Quereus engine
	const engines = new Map<string, EngineRegistration>();
	engines.set(QUEREUS_ENGINE_ID, {
		engine,
		getSchemaHash: () => engine.getSchemaHash(),
	});

	// Create validation coordinator factory
	// For Quereus, transforms are collected by the coordinator during SQL execution,
	// not from returned actions. We reset the coordinator before validation and
	// extract transforms after execution.
	const createValidationCoordinator: ValidationCoordinatorFactory = () => {
		// Reset coordinator transforms before validation to ensure isolation
		coordinator.resetTransforms();

		return {
			applyActions: async (_actions: CollectionActions[], _stampId: string) => {
				// For Quereus, actions are applied directly through the coordinator
				// during SQL execution (via virtual table module). This is a no-op.
			},
			getTransforms: () => {
				// Collect transforms from the coordinator after SQL execution
				return coordinator.getTransforms();
			},
			dispose: () => {
				// Reset transforms after validation to clean up
				coordinator.resetTransforms();
			},
		};
	};

	// Wire the client-signature verifier port ONLY when enforcement is requested. Omitting it (the
	// default) means the validator's signature step accepts both unsigned and signed transactions —
	// the phased-rollout posture (see requireClientSignature).
	const verifyClientSignature = options.requireClientSignature ? createClientSignatureVerifier() : undefined;

	return new TransactionValidator(engines, createValidationCoordinator, options.blockStateProvider, verifyClientSignature);
}

