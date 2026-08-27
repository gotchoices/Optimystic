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
} from '@optimystic/db-core';
import { TransactionValidator, type EngineRegistration, type ValidationCoordinatorFactory } from '@optimystic/db-core';
import { createPeerClientSignatureVerifier } from '@optimystic/db-p2p';
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
	 *
	 * NOTE: accepted tradeoff — this flag is deliberately NOT surfaced as a deployment-configurable
	 * option, because it would be a switch on a code path no deployment reaches. `createQuereusValidator`
	 * has no production caller: nothing supplies `NodeOptions.validator`, so every deployed cluster
	 * member runs `ClusterMember.validatePendOperations` with no validator and re-validates nothing at
	 * all. A config knob here would read as a working rollout path that does not exist. Tracked as
	 * backlog `feat-no-deployment-validates-transactions-at-pend`; enforcement itself IS proven end to
	 * end across a live cluster PEND in db-p2p's `mesh-client-signature-enforcement.spec.ts`. Revisit
	 * when a composition root starts supplying `NodeOptions.validator`.
	 */
	requireClientSignature?: boolean;
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
	const verifyClientSignature = options.requireClientSignature ? createPeerClientSignatureVerifier() : undefined;

	return new TransactionValidator(engines, createValidationCoordinator, options.blockStateProvider, verifyClientSignature);
}

