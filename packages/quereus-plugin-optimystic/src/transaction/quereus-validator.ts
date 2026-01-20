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
	Transforms,
	CollectionId,
	CollectionActions,
} from '@optimystic/db-core';
import { TransactionValidator, type EngineRegistration, type ValidationCoordinatorFactory } from '@optimystic/db-core';
import { QuereusEngine, QUEREUS_ENGINE_ID } from './quereus-engine.js';

/**
 * Options for creating a Quereus transaction validator.
 */
export interface QuereusValidatorOptions {
	/** The Quereus database instance (with same schema as transactions being validated) */
	db: Database;
	/** The transaction coordinator for the database */
	coordinator: TransactionCoordinator;
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

	return new TransactionValidator(engines, createValidationCoordinator);
}

