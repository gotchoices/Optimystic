import { peerIdFromString } from "../network/types.js";
import type { PeerId } from "../network/types.js";
import type { ActionTransforms, ActionBlocks, BlockActionStatus, ITransactor, PendSuccess, StaleFailure, IKeyNetwork, BlockId, GetBlockResults, PendResult, CommitResult, PendRequest, IRepo, BlockGets, Transforms, CommitRequest, ActionId, RepoCommitRequest, ClusterNomineesResult } from "../index.js";
import { transformForBlockId, groupBy, concatTransforms, concatTransform, transformsFromTransform, blockIdsForTransforms } from "../index.js";
import { blockIdToBytes } from "../utility/block-id-to-bytes.js";
import { isRecordEmpty } from "../utility/is-record-empty.js";
import { type CoordinatorBatch, makeBatchesByPeer, incompleteBatches, everyBatch, allBatches, mergeBlocks, processBatches, createBatchesForPayload } from "../utility/batch-coordinator.js";
import { createLogger, verbose } from "../logger.js";

const log = createLogger('network-transactor');

type NetworkTransactorInit = {
	timeoutMs: number;
	abortOrCancelTimeoutMs: number;
	keyNetwork: IKeyNetwork;
	getRepo: (peerId: PeerId) => IRepo;
}

export class NetworkTransactor implements ITransactor {
	private readonly keyNetwork: IKeyNetwork;
	private readonly timeoutMs: number;
	private readonly abortOrCancelTimeoutMs: number;
	private readonly getRepo: (peerId: PeerId) => IRepo;

	constructor(
		init: NetworkTransactorInit,
	) {
		this.keyNetwork = init.keyNetwork;
		this.timeoutMs = init.timeoutMs;
		this.abortOrCancelTimeoutMs = init.abortOrCancelTimeoutMs;
		this.getRepo = init.getRepo;
	}

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		// Group by block id
		const distinctBlockIds = Array.from(new Set(blockGets.blockIds));
		const t0 = Date.now();
		log('get blockIds=%d', distinctBlockIds.length);

		const batches = await this.batchesForPayload<BlockId[], GetBlockResults>(
			distinctBlockIds,
			distinctBlockIds,
			(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(bid => bid === blockId)],
			[]
		);

		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).get({ blockIds: batch.payload, context: blockGets.context }, { expiration }),
				batch => batch.payload,
				(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(bid => bid === blockId)],
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
			);
		} catch (e) {
			error = e as Error;
		}

		// Second-chance retry: if batch failed to respond OR responded with "not found"
		// Different cluster members may have different views; retry with other coordinators
		const hasValidResponse = (b: CoordinatorBatch<BlockId[], GetBlockResults>) => {
			return b.request?.isResponse === true && b.request.response != null;
		};

		const hasBlockInResponse = (b: CoordinatorBatch<BlockId[], GetBlockResults>) => {
			if (!hasValidResponse(b)) return false;
			const resp = b.request!.response! as GetBlockResults;
			return b.payload.some(bid => {
				const entry = resp[bid];
				return entry && typeof entry === 'object' && 'block' in entry && entry.block != null;
			});
		};

		// Retry batches that either failed to respond OR responded with "not found"
		// This provides tolerance for different cluster member views
		const retryable = Array.from(allBatches(batches)).filter(b =>
			!hasValidResponse(b as any) || !hasBlockInResponse(b as any)
		) as CoordinatorBatch<BlockId[], GetBlockResults>[];

		if (retryable.length > 0 && Date.now() < expiration) {
			log('get:retry retryable=%d', retryable.length);
			try {
				const excludedByRoot = new Map<CoordinatorBatch<BlockId[], GetBlockResults>, Set<PeerId>>();
				for (const b of retryable) {
					const excluded = new Set<PeerId>([b.peerId, ...((b.excludedPeers ?? []) as PeerId[])]);
					excludedByRoot.set(b, excluded);
					const retries = await createBatchesForPayload<BlockId[], GetBlockResults>(
						b.payload,
						b.payload,
						(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(id => id === blockId)],
						Array.from(excluded),
						async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
					);
					if (retries.length > 0) {
						b.subsumedBy = [...(b.subsumedBy ?? []), ...retries];
						await processBatches(
							retries,
							(batch) => this.getRepo(batch.peerId).get({ blockIds: batch.payload, context: blockGets.context }, { expiration }),
							batch => batch.payload,
							(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(id => id === blockId)],
							expiration,
							async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
						);
					}
				}
			} catch (e) {
				// keep original error if any
				if (!error) error = e as Error;
			}
		}


		// Cache the completed batches that had actual responses (not just coordinator not found)
		const completedBatches = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && !isRecordEmpty(b.request!.response!)));

		// Create a lookup map from successful responses only
		const resultEntries = new Map<string, any>();
		for (const batch of completedBatches) {
			const resp = batch.request!.response! as any;
			for (const [bid, res] of Object.entries(resp)) {
				const existing = resultEntries.get(bid);
				// Prefer responses that include a materialized block
				const resHasBlock = res && typeof res === 'object' && 'block' in (res as any) && (res as any).block != null;
				const existingHasBlock = existing && typeof existing === 'object' && 'block' in (existing as any) && (existing as any).block != null;
				if (!existing || (resHasBlock && !existingHasBlock)) {
					resultEntries.set(bid, res);
				}
			}
		}
		// Ensure we have at least one response per requested block id
		const missingIds = distinctBlockIds.filter(bid => !resultEntries.has(bid));
		if (missingIds.length > 0) {
			log('get:missing blockIds=%o', missingIds);
			const details = this.formatBatchStatuses(batches,
				b => (b.request?.isResponse as boolean) ?? false,
				b => {
					const status = b.request == null ? 'no-response' : (b.request.isResponse ? 'response' : 'in-flight')
					const errMsg = b.request?.isError ? ` cause=${errorMessage(b.request.error)}` : ''
					return `${b.peerId.toString()}[block:${b.blockId}](${status})${errMsg}`
				});
			const rootCause = firstBatchError(batches) ?? error;
			const aggregate = new Error(`Some peers did not complete: ${details}${rootCause ? `; root: ${rootCause.message}` : ''}`);
			(aggregate as any).cause = rootCause;
			throw aggregate;
		}

		log('get:done blockIds=%d ms=%d', distinctBlockIds.length, Date.now() - t0);
		return Object.fromEntries(resultEntries) as GetBlockResults;
	}

	async getStatus(blockActions: ActionBlocks[]): Promise<BlockActionStatus[]> {
		// Collect all unique block IDs across all action refs
		const allBlockIds = [...new Set(blockActions.flatMap(ref => ref.blockIds))];

		if (allBlockIds.length === 0) {
			return blockActions.map(ref => ({ ...ref, statuses: [] }));
		}

		// Get block states from repos
		const blockStates = await this.get({ blockIds: allBlockIds });

		// Determine status for each action ref
		return blockActions.map(ref => ({
			...ref,
			statuses: ref.blockIds.map(blockId => {
				const result = blockStates[blockId];
				if (!result) {
					return 'aborted';
				}
				const { state } = result;
				if (state.pendings?.includes(ref.actionId)) {
					return 'pending';
				}
				if (state.latest?.actionId === ref.actionId) {
					return 'committed';
				}
				// Action is neither pending nor the latest committed - consider it aborted
				// Note: This doesn't check historical commits; a more complete implementation
				// would need to query the revision history
				return 'aborted';
			})
		}));
	}

	private async consolidateCoordinators(
		blockIds: BlockId[],
		transforms: Transforms,
		transformForBlock: (payload: Transforms, blockId: BlockId, mergeWith?: Transforms) => Transforms
	): Promise<CoordinatorBatch<Transforms, PendResult>[]> {
		// Use cluster intersections to minimize the number of coordinators.
		// For each block, find its full cluster, then greedily assign blocks to
		// peers that appear in the most clusters — reducing round trips when
		// blocks share cluster members.

		// Step 1: Get cluster peer sets for each block
		const blockClusterPeerIds: Map<BlockId, Set<string>> = new Map();
		const fallbackBlocks: BlockId[] = [];

		await Promise.all(blockIds.map(async bid => {
			try {
				const clusterPeers = await this.keyNetwork.findCluster(await blockIdToBytes(bid));
				blockClusterPeerIds.set(bid, new Set(Object.keys(clusterPeers)));
			} catch {
				fallbackBlocks.push(bid);
			}
		}));

		// Step 2: Build peer → blocks index (which blocks each peer can coordinate)
		const peerBlocks = new Map<string, BlockId[]>();
		for (const [blockId, peerIds] of blockClusterPeerIds) {
			for (const peerId of peerIds) {
				const blocks = peerBlocks.get(peerId) ?? [];
				blocks.push(blockId);
				peerBlocks.set(peerId, blocks);
			}
		}

		// Step 3: Greedy set cover — assign blocks to peers covering the most uncovered blocks
		const uncovered = new Set(blockClusterPeerIds.keys());
		const assignments = new Map<string, BlockId[]>(); // peerIdStr → assigned blockIds

		while (uncovered.size > 0) {
			let bestPeer: string | undefined;
			let bestCount = 0;

			for (const [peerId, blocks] of peerBlocks) {
				const coverCount = blocks.filter(bid => uncovered.has(bid)).length;
				if (coverCount > bestCount) {
					bestCount = coverCount;
					bestPeer = peerId;
				}
			}

			if (!bestPeer || bestCount === 0) break;

			const covered = peerBlocks.get(bestPeer)!.filter(bid => uncovered.has(bid));
			assignments.set(bestPeer, covered);
			for (const bid of covered) uncovered.delete(bid);
		}

		// Step 4: Any remaining uncovered blocks fall back to findCoordinator
		for (const bid of uncovered) fallbackBlocks.push(bid);

		const fallbackCoordinators = await Promise.all(
			fallbackBlocks.map(async bid => ({
				blockId: bid,
				coordinator: await this.keyNetwork.findCoordinator(await blockIdToBytes(bid), { excludedPeers: [] })
			}))
		);
		for (const { blockId, coordinator } of fallbackCoordinators) {
			const key = coordinator.toString();
			const existing = assignments.get(key) ?? [];
			existing.push(blockId);
			assignments.set(key, existing);
		}

		// Step 5: Convert assignments to batches
		const batches: CoordinatorBatch<Transforms, PendResult>[] = [];
		for (const [peerIdStr, consolidatedBlocks] of assignments) {
			const peerId = peerIdFromString(peerIdStr);

			let batchTransforms: Transforms = { inserts: {}, updates: {}, deletes: [] };
			for (const bid of consolidatedBlocks) {
				const blockTransforms = transformForBlock(transforms, bid, batchTransforms);
				batchTransforms = blockTransforms;
			}

			batches.push({
				peerId,
				payload: batchTransforms,
				blockId: consolidatedBlocks[0]!,
				coordinatingBlockIds: consolidatedBlocks,
				excludedPeers: []
			});
		}

		return batches;
	}

	async pend(blockAction: PendRequest): Promise<PendResult> {
		const t0 = Date.now();
		const transformForBlock = (payload: Transforms, blockId: BlockId, mergeWithPayload: Transforms | undefined): Transforms => {
			const filteredTransform = transformForBlockId(payload, blockId);
			return mergeWithPayload
				? concatTransform(mergeWithPayload, blockId, filteredTransform)
				: transformsFromTransform(filteredTransform, blockId);
		};
		const blockIds = blockIdsForTransforms(blockAction.transforms);
		const batches = await this.consolidateCoordinators(blockIds, blockAction.transforms, transformForBlock);
		log('pend actionId=%s blockIds=%d batches=%d', blockAction.actionId, blockIds.length, batches.length);
		if (verbose) {
			const batchSummary = batches.map(b => ({
				peer: b.peerId.toString().substring(0, 12),
				blocks: b.coordinatingBlockIds ?? [b.blockId],
				inserts: Object.keys(b.payload.inserts ?? {}).length,
				updates: Object.keys(b.payload.updates ?? {}).length,
				deletes: b.payload.deletes?.length ?? 0
			}));
			log('pend:batches actionId=%s detail=%o', blockAction.actionId, batchSummary);
		}
		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			// Process all batches, noting all outstanding peers
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).pend(
					{ ...blockAction, transforms: batch.payload },
					{
						expiration,
						coordinatingBlockIds: batch.coordinatingBlockIds
					} as any
				),
				batch => blockIdsForTransforms(batch.payload),
				transformForBlock,
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
			);
			// Cache resolved coordinators for follow-up commit to hit the same peers
			try {
				const pn: any = this.keyNetwork as any;
				if (typeof pn?.recordCoordinator === 'function') {
					for (const b of Array.from(allBatches(batches))) {
						pn.recordCoordinator(await blockIdToBytes(b.blockId), b.peerId);
					}
				}
			} catch (e) { console.warn('Failed to record coordinator hint', e); }
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			const details = this.formatBatchStatuses(batches,
				b => (b.request?.isResponse as boolean && (b.request as any).response?.success) ?? false,
				b => {
					const status = b.request == null ? 'no-response' : (b.request.isResponse ? 'non-success' : 'in-flight')
					const errMsg = b.request?.isError ? ` cause=${errorMessage(b.request.error)}` : ''
					return `${b.peerId.toString()}[block:${b.blockId}](${status})${errMsg}`
				});
			// Prefer the first-attempt per-batch error over any outer `error` so the root cause
			// surfaced in the aggregate message is the actual coordinator failure, not any
			// downstream "no coordinator available" thrown by retry lookup.
			const rootCause = firstBatchError(batches) ?? error;
			const aggregate = new Error(`Some peers did not complete: ${details}${rootCause ? `; root: ${rootCause.message}` : ''}`);
			(aggregate as any).cause = rootCause;
			(aggregate as AggregateError).errors = rootCause ? [rootCause] : [];
			error = aggregate;
		}

		if (error) { // If any failures, cancel all pending actions as background microtask
			log('pend:cancel actionId=%s', blockAction.actionId);
			void Promise.resolve().then(() => this.cancelBatch(batches, { blockIds, actionId: blockAction.actionId }));
			const stale = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {	// Any active stale failures should preempt reporting connection or other potential transient errors (we have information)
				log('pend:stale actionId=%s staleCount=%d', blockAction.actionId, stale.length);
				return {
					success: false,
					missing: distinctBlockActionTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing).filter((x): x is ActionTransforms => x !== undefined)),
				};
			}
			throw error;	// No stale failures, report the original error
		}

		// Collect replies back into result structure
		const completed = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && b.request!.response!.success));
		log('pend:done actionId=%s ms=%d batches=%d', blockAction.actionId, Date.now() - t0, batches.length);
		return {
			success: true,
			pending: completed.flatMap(b => (b.request!.response! as PendSuccess).pending),
			blockIds: blockIdsForTransforms(blockAction.transforms)
		};
	}

	async cancel(actionRef: ActionBlocks): Promise<void> {
		log('cancel actionId=%s blockIds=%d', actionRef.actionId, actionRef.blockIds.length);
		const batches = await this.batchesForPayload<BlockId[], void>(
			actionRef.blockIds,
			actionRef.blockIds,
			mergeBlocks,
			[]
		);
		const expiration = Date.now() + this.abortOrCancelTimeoutMs;
		await processBatches(
			batches,
			(batch) => this.getRepo(batch.peerId).cancel({ actionId: actionRef.actionId, blockIds: batch.payload }, { expiration }),
			batch => batch.payload,
			mergeBlocks,
			expiration,
			async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
		);
	}

	async queryClusterNominees(blockId: BlockId): Promise<ClusterNomineesResult> {
		const blockIdBytes = await blockIdToBytes(blockId);
		const clusterPeers = await this.keyNetwork.findCluster(blockIdBytes);
		const nominees = Object.keys(clusterPeers).map(idStr => peerIdFromString(idStr));
		return { nominees };
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		const t0 = Date.now();
		log('commit actionId=%s rev=%d blockIds=%d', request.actionId, request.rev, request.blockIds.length);
		const allBlockIds = [...new Set([...request.blockIds, request.tailId])];

		// Commit the header block if provided and not already in blockIds
		if (request.headerId && !request.blockIds.includes(request.headerId)) {
			const headerResult = await this.commitBlock(request.headerId, allBlockIds, request.actionId, request.rev);
			if (!headerResult.success) {
				return headerResult;
			}
		}

		// Commit the tail block
		const tailResult = await this.commitBlock(request.tailId, allBlockIds, request.actionId, request.rev);
		if (!tailResult.success) {
			return tailResult;
		}

		// Commit all remaining block ids (excluding tail and header if it was already handled)
		const remainingBlocks = request.blockIds.filter(bid =>
			bid !== request.tailId &&
			!(request.headerId && bid === request.headerId && !request.blockIds.includes(request.headerId))
		);
		if (remainingBlocks.length > 0) {
			const { batches, error } = await this.commitBlocks({ blockIds: remainingBlocks, actionId: request.actionId, rev: request.rev });
			if (error) {
				// Non-tail block commit failures should not fail the overall action once the tail has committed.
				// Proceed and rely on reconciliation paths (e.g. reads with context) to finalize state on lagging peers.
				try { console.warn('[NetworkTransactor] non-tail commit had errors; proceeding after tail commit:', error.message); } catch { /* ignore */ }
			}
		}

		log('commit:done actionId=%s ms=%d', request.actionId, Date.now() - t0);
		return { success: true };
	}

	private async commitBlock(blockId: BlockId, blockIds: BlockId[], actionId: ActionId, rev: number): Promise<CommitResult> {
		const { batches: tailBatches, error: tailError } = await this.commitBlocks({ blockIds: [blockId], actionId, rev });
		if (tailError) {
			// Cancel all pending actions as background microtask
			Promise.resolve().then(() => this.cancel({ blockIds, actionId }));
			// Collect and return any active stale failures
			const stale = Array.from(allBatches(tailBatches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {
				return { missing: distinctBlockActionTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing!)), success: false as const };
			}
			throw tailError;
		}
		return { success: true };
	}

	/** Attempts to commit a set of blocks, and handles failures and errors */
	private async commitBlocks({ blockIds, actionId, rev }: RepoCommitRequest) {
		const expiration = Date.now() + this.timeoutMs;
		const batches = await this.batchesForPayload<BlockId[], CommitResult>(blockIds, blockIds, mergeBlocks, []);
		log('commitBlocks actionId=%s rev=%d batches=%d', actionId, rev, batches.length);
		let error: Error | undefined;
		try {
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).commit({ actionId, blockIds: batch.payload, rev }, { expiration }),
				batch => batch.payload,
				mergeBlocks,
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
			);
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			const details = this.formatBatchStatuses(batches,
				b => (b.request?.isResponse as boolean && (b.request as any).response?.success) ?? false,
				b => {
					const status = b.request == null ? 'no-response' : (b.request.isResponse ? 'non-success' : 'in-flight')
					const resp: any = (b.request as any)?.response;
					const extra = resp && resp.success === false ? (Array.isArray(resp.missing) ? ` missing=${resp.missing.length}` : ' success=false') : '';
					const errMsg = b.request?.isError ? ` cause=${errorMessage(b.request.error)}` : ''
					return `${b.peerId.toString()}[blocks:${b.payload instanceof Array ? (b.payload as any[]).length : 1}](${status})${extra ? ' ' + extra : ''}${errMsg}`
				});
			const rootCause = firstBatchError(batches) ?? error;
			const aggregate = new Error(`Some peers did not complete: ${details}${rootCause ? `; root: ${rootCause.message}` : ''}`);
			(aggregate as any).cause = rootCause;
			error = aggregate;
		}
		return { batches, error };
	};

	/** Creates batches for a given payload, grouped by the coordinating peer for each block id */
	private async batchesForPayload<TPayload, TResponse>(
		blockIds: BlockId[],
		payload: TPayload,
		getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
		excludedPeers: PeerId[]
	): Promise<CoordinatorBatch<TPayload, TResponse>[]> {
		return createBatchesForPayload<TPayload, TResponse>(
			blockIds,
			payload,
			getBlockPayload,
			excludedPeers,
			async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
		);
	}

	/** Cancels a pending transaction by canceling all blocks associated with the transaction, including failed peers */
	private async cancelBatch<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		actionRef: ActionBlocks,
	) {
		const expiration = Date.now() + this.abortOrCancelTimeoutMs;
		const operationBatches = makeBatchesByPeer(
			Array.from(allBatches(batches)).map(b => [b.blockId, b.peerId] as const),
			actionRef.blockIds,
			mergeBlocks,
			[]
		);
		await processBatches(
			operationBatches,
			(batch) => this.getRepo(batch.peerId).cancel({ actionId: actionRef.actionId, blockIds: batch.payload }, { expiration }),
			batch => batch.payload,
			mergeBlocks,
			expiration,
			async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
		);
	}

	private formatBatchStatuses<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		isSuccess: (b: CoordinatorBatch<TPayload, TResponse>) => boolean,
		formatter: (b: CoordinatorBatch<TPayload, TResponse>) => string
	): string {
		const incompletes = Array.from(incompleteBatches(batches))
		let details = incompletes.map(formatter).join(', ')
		if (details.length === 0) {
			details = Array.from(allBatches(batches)).map(formatter).join(', ')
		}
		return details
	}
}


/** Returns a readable message for an unknown error value. */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err == null) return 'unknown';
	try { return String(err); } catch { return 'unknown'; }
}

/**
 * Returns the first batch-level error encountered across the batch tree,
 * preferring root batches over retries. Used to preserve the ORIGINAL first-attempt
 * failure reason when constructing aggregate errors — retry lookup failures
 * (e.g., findCoordinator throwing because self is excluded on a solo node) must
 * not shadow the actual root cause.
 */
function firstBatchError<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[]): Error | undefined {
	// Prefer errors on root batches first
	for (const root of batches) {
		if (root.request?.isError) return asError(root.request.error);
	}
	// Fall back to errors in any retry subtree
	for (const b of allBatches(batches)) {
		if (b.request?.isError) return asError(b.request.error);
	}
	return undefined;
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(errorMessage(err));
}

/**
 * Returns the block actions grouped by action id and concatenated transforms
 */
export function distinctBlockActionTransforms(blockActions: ActionTransforms[]): ActionTransforms[] {
	const grouped = groupBy(blockActions, ({ actionId }) => actionId);
	return Object.entries(grouped).map(([actionId, actions]) =>
		({ actionId, transforms: concatTransforms(...actions.map(t => t.transforms)) } as ActionTransforms));
}
