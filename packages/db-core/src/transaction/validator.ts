import type { BlockId, CollectionId, IBlock, BlockOperations, Transforms, ITransactor } from '../index.js';
import type { Transaction, ITransactionEngine, ITransactionValidator, ValidationResult, CollectionActions } from './transaction.js';
import type { Collection } from '../collection/collection.js';
import { Tracker } from '../transform/tracker.js';
import { hashString } from '../utility/hash-string.js';

/**
 * Represents an operation on a block within a collection.
 * Must match the Operation type in coordinator.ts for consistent hashing.
 */
type Operation =
	| { readonly type: 'insert'; readonly collectionId: CollectionId; readonly blockId: BlockId; readonly block: IBlock }
	| { readonly type: 'update'; readonly collectionId: CollectionId; readonly blockId: BlockId; readonly operations: BlockOperations }
	| { readonly type: 'delete'; readonly collectionId: CollectionId; readonly blockId: BlockId };

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
 * Transaction validator implementation.
 *
 * Validates transactions by re-executing them and comparing operations hash.
 * Used by cluster participants when receiving PendRequests.
 */
export class TransactionValidator implements ITransactionValidator {
	constructor(
		private readonly engines: Map<string, EngineRegistration>,
		private readonly createValidationCoordinator: ValidationCoordinatorFactory
	) {}

	async validate(transaction: Transaction, operationsHash: string): Promise<ValidationResult> {
		const { stamp, statements } = transaction;

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
		// TODO: Implement read dependency validation
		// For now, we skip this check - will be implemented with proper block versioning

		// 4. Create isolated validation coordinator
		const validationCoordinator = this.createValidationCoordinator();

		try {
			// 5. Re-execute transaction through engine
			const result = await registration.engine.execute(transaction);
			if (!result.success) {
				return {
					valid: false,
					reason: `Re-execution failed: ${result.error}`
				};
			}

			// 6. Apply actions to validation coordinator (builds transforms)
			if (result.actions && result.actions.length > 0) {
				await validationCoordinator.applyActions(result.actions, stamp.id);
			}

			// 7. Collect operations from validation coordinator
			const transforms = validationCoordinator.getTransforms();
			const allOperations = this.collectOperations(transforms);

			// 8. Compute hash
			const computedHash = this.hashOperations(allOperations);

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

	/**
	 * Collect all operations from transforms.
	 */
	private collectOperations(transforms: Map<CollectionId, Transforms>): readonly Operation[] {
		return Array.from(transforms.entries()).flatMap(([collectionId, t]) => [
			...Object.entries(t.inserts).map(([blockId, block]) =>
				({ type: 'insert' as const, collectionId, blockId, block })
			),
			...Object.entries(t.updates).map(([blockId, operations]) =>
				({ type: 'update' as const, collectionId, blockId, operations })
			),
			...t.deletes.map(blockId =>
				({ type: 'delete' as const, collectionId, blockId })
			)
		]);
	}

	/**
	 * Compute hash of all operations.
	 * Must match TransactionCoordinator.hashOperations for consistent validation.
	 */
	private hashOperations(operations: readonly Operation[]): string {
		const operationsData = JSON.stringify(operations);
		return `ops:${hashString(operationsData)}`;
	}
}

