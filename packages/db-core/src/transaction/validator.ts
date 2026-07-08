import type { BlockId, CollectionId, Transforms } from '../index.js';
import type { Transaction, ITransactionEngine, ITransactionValidator, ValidationResult, CollectionActions } from './transaction.js';
import type { BlockActionState } from '../network/struct.js';
import { isTransactionExpired } from './transaction.js';
import { collectOperations, hashOperations } from './operations-hash.js';

/**
 * Engine registration for validation.
 */
export type EngineRegistration = {
	/** The transaction engine instance */
	engine: ITransactionEngine;
	/** Get the current schema hash for this engine */
	getSchemaHash: () => Promise<string>;
};

/**
 * Factory function to create a validation coordinator.
 * This allows isolated execution of transactions for validation.
 */
export type ValidationCoordinatorFactory = () => {
	/** Apply actions to collections in isolated state */
	applyActions(actions: CollectionActions[], stampId: string): Promise<void>;
	/** Get all transforms from the validation state */
	getTransforms(): Map<CollectionId, Transforms>;
	/** Dispose of the validation coordinator */
	dispose(): void;
};

/**
 * Provides current block state for read dependency validation.
 * Returns the latest BlockActionState for a given block, or undefined if the block doesn't exist.
 */
export type BlockStateProvider = (blockId: BlockId) => Promise<BlockActionState | undefined>;

/**
 * Transaction validator implementation.
 *
 * Validates transactions by re-executing them and comparing operations hash.
 * Used by cluster participants when receiving PendRequests.
 */
export class TransactionValidator implements ITransactionValidator {
	constructor(
		private readonly engines: Map<string, EngineRegistration>,
		private readonly createValidationCoordinator: ValidationCoordinatorFactory,
		private readonly blockStateProvider?: BlockStateProvider
	) {}

	async validate(transaction: Transaction, operationsHash: string): Promise<ValidationResult> {
		const { stamp } = transaction;

		// 0. Check expiration before any other work
		if (isTransactionExpired(stamp)) {
			return {
				valid: false,
				reason: `Transaction expired at ${stamp.expiration}`
			};
		}

		// 1. Verify engine exists
		const registration = this.engines.get(stamp.engineId);
		if (!registration) {
			return {
				valid: false,
				reason: `Unknown engine: ${stamp.engineId}`
			};
		}

		// 2. Verify schema hash matches
		const localSchemaHash = await registration.getSchemaHash();
		if (localSchemaHash !== stamp.schemaHash) {
			return {
				valid: false,
				reason: `Schema mismatch: local=${localSchemaHash}, sender=${stamp.schemaHash}`
			};
		}

		// 3. Verify read dependencies (optimistic concurrency)
		if (this.blockStateProvider && transaction.reads.length > 0) {
			for (const read of transaction.reads) {
				const currentState = await this.blockStateProvider(read.blockId);
				const currentRev = currentState?.latest?.rev ?? 0;
				if (currentRev !== read.revision) {
					return {
						valid: false,
						reason: `Stale read: block ${read.blockId} was at revision ${read.revision} but is now at ${currentRev}`
					};
				}
			}
		}

		// 4. Create isolated validation coordinator
		const validationCoordinator = this.createValidationCoordinator();

		try {
			// 5. Re-execute transaction through engine.
			//
			// Which of the two ITransactionEngine models the registered engine uses decides
			// where isolation comes from (see the contract in transaction.ts):
			//
			//   (a) PURE TRANSLATOR (ActionsEngine) — execute() parses statements into
			//       actions and mutates NOTHING, so even an engine constructed against the
			//       MAIN coordinator cannot leak into main state here. The returned actions
			//       are applied once, on the isolated validationCoordinator at step 6.
			//
			//   (b) SIDE-EFFECT APPLY (QuereusEngine) — execute() applies while translating
			//       (db.exec drives the vtab into coordinator.applyActions) and returns EMPTY
			//       actions. That application lands on whatever coordinator the engine/vtab is
			//       bound to, NOT on validationCoordinator, so isolation is the caller's job:
			//       the createValidationCoordinator wiring must bind/reset an isolated world
			//       (see quereus-validator, which resets the coordinator before each run and
			//       makes its validationCoordinator.applyActions a no-op). Step 6 is then
			//       skipped by the empty-actions guard.
			const result = await registration.engine.execute(transaction);
			if (!result.success) {
				return {
					valid: false,
					reason: `Re-execution failed: ${result.error}`
				};
			}

			// 6. Apply actions to the isolated validation coordinator (builds transforms).
			// Reached only for pure-translator engines that RETURNED actions; a side-effect
			// engine returns empty and already applied during execute() (see above).
			if (result.actions && result.actions.length > 0) {
				await validationCoordinator.applyActions(result.actions, stamp.id);
			}

			// 7. Collect operations from validation coordinator
			const transforms = validationCoordinator.getTransforms();

			// 8. Compute hash via the shared operations-hash module — the SAME collect +
			// canonicalise + hash the coordinator ran, so an honest sender and this
			// validator cannot diverge on ordering.
			const computedHash = await hashOperations(collectOperations(transforms));

			// 9. Compare with sender's hash
			if (computedHash !== operationsHash) {
				return {
					valid: false,
					reason: `Operations hash mismatch`,
					computedHash
				};
			}

			return { valid: true, computedHash };
		} finally {
			validationCoordinator.dispose();
		}
	}

	async getSchemaHash(engineId: string): Promise<string | undefined> {
		const registration = this.engines.get(engineId);
		return registration ? await registration.getSchemaHash() : undefined;
	}
}

