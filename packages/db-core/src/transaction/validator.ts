import type { BlockId, CollectionId, Transforms } from '../index.js';
import type { Transaction, ITransactionEngine, ITransactionValidator, ValidationResult, CollectionActions, ClientSignatureVerifier } from './transaction.js';
import type { BlockActionState } from '../network/struct.js';
import { isTransactionExpired, clientSignaturePayload, computeStampId } from './transaction.js';
import { collectOperations, hashOperations, opsHashVersion, OPS_HASH_VERSION } from './operations-hash.js';

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
		private readonly blockStateProvider?: BlockStateProvider,
		private readonly verifyClientSignature?: ClientSignatureVerifier
	) {}

	async validate(transaction: Transaction, operationsHash: string): Promise<ValidationResult> {
		const { stamp } = transaction;

		// 0.0. Integrity: the id must be the true hash of the stamp fields. Runs FIRST because
		// every later step (expiration, signature, engine/schema selection) trusts a stamp field.
		// Always-on (one SHA-256, cheap) and independent of whether a signature verifier is wired —
		// a tampered stamp corrupts expiration and engine selection regardless of signatures.
		const expectedId = await computeStampId(stamp);
		if (expectedId !== stamp.id) {
			return { valid: false, reason: 'Tampered transaction stamp' };
		}

		// 0. Check expiration before any other work. Ordered BEFORE the signature check so
		// an attacker cannot learn signature-validity for an already-expired transaction.
		if (isTransactionExpired(stamp)) {
			return {
				valid: false,
				reason: `Transaction expired at ${stamp.expiration}`
			};
		}

		// 0.5. Verify the client signature, if a verifier port is wired. When the port is
		// absent (migration / single-node-dev posture) unsigned AND signed transactions
		// both pass — the p2p enforcement flag decides whether to inject the port at all.
		if (this.verifyClientSignature) {
			if (transaction.signature === undefined) {
				return { valid: false, reason: 'Missing client signature' };
			}
			const payload = clientSignaturePayload(stamp.id, transaction.statements, transaction.reads);
			if (!this.verifyClientSignature(stamp.peerId, payload, transaction.signature)) {
				return { valid: false, reason: 'Invalid client signature' };
			}
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

			// 9. Compare with sender's hash. Split the failure into two distinct causes so
			// version skew is diagnosable rather than looking like a content fault:
			//   - VERSION SKEW: the sender's token carries a format version this node does not
			//     produce (a foreign vN, a bare legacy `ops:`, or an unparseable token → null).
			//     These bytes are not even comparable, so surface a clear "unsupported format
			//     version" error. This is DETECTION only — the node cannot cross-compute the
			//     peer's format, so a mixed-version cluster fails legibly, not silently.
			//   - CONTENT MISMATCH: same format version, different bytes — a genuine operations
			//     disagreement (or a Byzantine lie); the existing error is unchanged.
			if (computedHash !== operationsHash) {
				const senderVersion = opsHashVersion(operationsHash);
				if (senderVersion !== OPS_HASH_VERSION) {
					return {
						valid: false,
						reason: `Unsupported operations-hash format version: local=${OPS_HASH_VERSION}, sender=${senderVersion ?? 'unrecognized'}`,
						computedHash
					};
				}
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

