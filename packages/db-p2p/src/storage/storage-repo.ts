import type {
	IRepo, MessageOptions, BlockId, CommitRequest, CommitResult, GetBlockResults, PendRequest, PendResult, ActionBlocks,
	ActionId, BlockGets, ActionPending, PendSuccess, ActionTransform, ActionTransforms,
	Transforms,
	GetBlockResult,
	PendValidationHook
} from "@optimystic/db-core";
import {
	Latches, transformForBlockId, applyTransform, groupBy, concatTransform, emptyTransforms,
	blockIdsForTransforms, transformsFromTransform
} from "@optimystic/db-core";
import { asyncIteratorToArray } from "../it-utility.js";
import type { IBlockStorage } from "./i-block-storage.js";

export type StorageRepoOptions = {
	/** Optional hook to validate transactions in PendRequests */
	validatePend?: PendValidationHook;
};

export class StorageRepo implements IRepo {
	private readonly validatePend?: PendValidationHook;

	constructor(
		private readonly createBlockStorage: (blockId: BlockId) => IBlockStorage,
		options?: StorageRepoOptions
	) {
		this.validatePend = options?.validatePend;
	}

	async get({ blockIds, context }: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		const distinctBlockIds = Array.from(new Set(blockIds));
		const results = await Promise.all(distinctBlockIds.map(async (blockId) => {
			const blockStorage = this.createBlockStorage(blockId);

			// Ensure that all outstanding transactions in the context are committed
			if (context) {
				const latest = await blockStorage.getLatest();
				const missing = latest
					? context.committed.filter(c => c.rev > latest.rev)
					: context.committed;
				for (const { actionId, rev } of missing.sort((a, b) => a.rev - b.rev)) {
					const pending = await blockStorage.getPendingTransaction(actionId);
					if (pending) {
						await this.internalCommit(blockId, actionId, rev, blockStorage);
					}
				}
			}

			const blockRev = await blockStorage.getBlock(context?.rev);
			if (!blockRev) {
				return [blockId, { state: {} } as GetBlockResult];
			}

			// Include pending action if requested
			if (context?.actionId !== undefined) {
				const pendingTransform = await blockStorage.getPendingTransaction(context.actionId);
				if (!pendingTransform) {
					throw new Error(`Pending action ${context.actionId} not found`);
				}
				const block = applyTransform(blockRev.block, pendingTransform);
				return [blockId, {
					block,
					state: {
						latest: await blockStorage.getLatest(),
						pendings: [context.actionId]
					}
				}];
			}

			const pendings = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			return [blockId, {
				block: blockRev.block,
				state: {
					latest: await blockStorage.getLatest(),
					pendings
				}
			}];
		}));
		return Object.fromEntries(results);
	}

	async pend(request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		// Validate transaction if present and validation hook is configured
		if (this.validatePend && request.transaction && request.operationsHash) {
			const validationResult = await this.validatePend(request.transaction, request.operationsHash);
			if (!validationResult.valid) {
				return {
					success: false,
					reason: validationResult.reason ?? 'Transaction validation failed'
				};
			}
		}

		const blockIds = blockIdsForTransforms(request.transforms);
		const pendings: ActionPending[] = [];
		const missing: ActionTransforms[] = [];

		// Potential race condition: A concurrent commit operation could complete
		// between the conflict checks (latest.rev, listPendingTransactions) and the
		// savePendingTransaction call below. This pend operation might succeed based on
		// stale information, but the subsequent commit for this pend would likely
		// fail correctly later if a conflict arose. Locking here could make the initial
		// check more accurate but adds overhead. The current approach prioritizes
		// letting the commit be the final arbiter.
		for (const blockId of blockIds) {
			const blockStorage = this.createBlockStorage(blockId);
			const transforms = transformForBlockId(request.transforms, blockId);

			// First handle any pending actions
			const pending = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			pendings.push(...pending.map(actionId => ({ blockId, actionId })));

			// Handle any conflicting revisions
			if (request.rev !== undefined || transforms.insert) {
				const latest = await blockStorage.getLatest();
				if (latest && latest.rev >= (request.rev ?? 0)) {
					const transforms = await asyncIteratorToArray(blockStorage.listRevisions(request.rev ?? 0, latest.rev));
					for (const actionRev of transforms) {
						const transform = await blockStorage.getTransaction(actionRev.actionId);
						if (!transform) {
							throw new Error(`Missing action ${actionRev.actionId} for block ${blockId}`);
						}
						missing.push({
							actionId: actionRev.actionId,
							rev: actionRev.rev,
							transforms: transformsFromTransform(transform, blockId)
						});
					}
				}
			}
		}

		if (missing.length) {
			return {
				success: false,
				missing
			};
		}

		if (pendings.length > 0) {
			if (request.policy === 'f') {	// Fail on pending actions
				return { success: false, pending: pendings };
			} else if (request.policy === 'r') {	// Return populated pending actions
				return {
					success: false,
					pending: await Promise.all(pendings.map(async action => {
						const blockStorage = this.createBlockStorage(action.blockId);
						return {
							blockId: action.blockId,
							actionId: action.actionId,
							transform: (await blockStorage.getPendingTransaction(action.actionId))
								?? (await blockStorage.getTransaction(action.actionId))!	// Possible that since enumeration, the action has been promoted
						}
					}))
				};
			}
		}


		// Simultaneously save pending action for each block
		// Note: that this is not atomic, after we checked for conflicts and pending actions
		// new pending or committed actions may have been added.  This is okay, because
		// this check during pend is conservative.
		await Promise.all(blockIds.map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			const blockTransform = transformForBlockId(request.transforms, blockId);
			return blockStorage.savePendingTransaction(request.actionId, blockTransform);
		}));

		return {
			success: true,
			pending: pendings,
			blockIds
		} as PendSuccess;
	}

	async cancel(actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> {
		await Promise.all(actionRef.blockIds.map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			return blockStorage.deletePendingTransaction(actionRef.actionId);
		}));
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		const uniqueBlockIds = Array.from(new Set(request.blockIds)).sort();
		const releases: (() => void)[] = [];

		try {
			// Acquire locks sequentially based on sorted IDs to prevent deadlocks
			for (const id of uniqueBlockIds) {
				const lockId = `StorageRepo.commit:${id}`;
				const release = await Latches.acquire(lockId);
				releases.push(release);
			}

			// --- Start of Critical Section ---

			const blockStorages = request.blockIds.map(blockId => ({
				blockId,
				storage: this.createBlockStorage(blockId)
			}));

			// Check for stale revisions and collect missing actions
			const missedCommits: { blockId: BlockId, transforms: ActionTransform[] }[] = [];
			for (const { blockId, storage } of blockStorages) {
				const latest = await storage.getLatest();
				if (latest && latest.rev >= request.rev) {
					const transforms: ActionTransform[] = [];
					for await (const actionRev of storage.listRevisions(request.rev, latest.rev)) {
						const transform = await storage.getTransaction(actionRev.actionId);
						if (!transform) {
							throw new Error(`Missing action ${actionRev.actionId} for block ${blockId}`);
						}
						transforms.push({
							actionId: actionRev.actionId,
							rev: actionRev.rev,
							transform
						});
					}
					missedCommits.push({ blockId, transforms });	// Push, even if transforms is empty, because we want to reject the older version
				}
			}

			if (missedCommits.length) {
				return { // Return directly, locks will be released in finally
					success: false,
					missing: perBlockActionTransformsToPerAction(missedCommits)
				};
			}

			// Check for missing pending actions
			const missingPends: { blockId: BlockId, actionId: ActionId }[] = [];
			for (const { blockId, storage } of blockStorages) {
				const pendingAction = await storage.getPendingTransaction(request.actionId);
				if (!pendingAction) {
					missingPends.push({ blockId, actionId: request.actionId });
				}
			}

			if (missingPends.length) {
				throw new Error(`Pending action ${request.actionId} not found for block(s): ${missingPends.map(p => p.blockId).join(', ')}`);
			}

			// Commit the action for each block
			// This loop will execute atomically for all blocks due to the acquired locks
			for (const { blockId, storage } of blockStorages) {
				try {
					// internalCommit will throw if it encounters an issue
					await this.internalCommit(blockId, request.actionId, request.rev, storage);
				} catch (err) {
					// TODO: Recover as best we can. Rollback or handle partial commit? For now, return failure.
					return {
						success: false,
						reason: err instanceof Error ? err.message : 'Unknown error during commit'
					};
				}
			}
		}
		finally {
			// Release locks in reverse order of acquisition
			releases.reverse().forEach(release => release());
		}

		return { success: true };
	}

	private async internalCommit(blockId: BlockId, actionId: ActionId, rev: number, storage: IBlockStorage): Promise<void> {
		// Note: This method is called within the locked critical section of commit()
		// So, operations like getPendingTransaction, getLatest, getBlock, saveMaterializedBlock,
		// saveRevision, promotePendingTransaction, setLatest are protected against
		// concurrent commits for the *same blockId*.

		const transform = await storage.getPendingTransaction(actionId);
		// No need to check if !transform here, as the caller (commit) already verified this.
		// If it's null here, it indicates a logic error or race condition bypassed the lock (unlikely).
		if (!transform) {
			throw new Error(`Consistency Error: Pending action ${actionId} disappeared for block ${blockId} within critical section.`);
		}

		// Get prior materialized block if it exists
		const latest = await storage.getLatest();
		const priorBlock = latest
			? (await storage.getBlock(latest.rev))?.block
			: undefined;

		// Apply transform and save materialized block
		// applyTransform handles undefined priorBlock correctly for inserts
		const newBlock = applyTransform(priorBlock, transform);
		if (newBlock) {
			await storage.saveMaterializedBlock(actionId, newBlock);
		}

		// Save revision and promote action *before* updating latest
		// This ensures that if the process crashes between these steps,
		// the 'latest' pointer doesn't point to a revision that hasn't been fully recorded.
		await storage.saveRevision(rev, actionId);
		await storage.promotePendingTransaction(actionId);

		// Update latest revision *last*
		await storage.setLatest({ actionId, rev });
	}
}

/** Converts list of missing actions per block into a list of missing actions across blocks. */
function perBlockActionTransformsToPerAction(missing: { blockId: BlockId; transforms: ActionTransform[]; }[]) {
	const missingFlat = missing.flatMap(({ blockId, transforms }) =>
		transforms.map(transform => ({ blockId, transform }))
	);
	const missingByActionId = groupBy(missingFlat, ({ transform }) => transform.actionId);
	return Object.entries(missingByActionId).map(([actionId, items]) =>
		items.reduce((acc, { blockId, transform }) => {
			concatTransform(acc.transforms, blockId, transform.transform);
			return acc;
		}, {
			actionId: actionId as ActionId,
			rev: items[0]!.transform.rev,	// Assumption: all missing actionIds share the same revision
			transforms: emptyTransforms()
		})
	);
}
