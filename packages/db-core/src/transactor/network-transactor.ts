import { peerIdFromString } from "../network/types.js";
import type { PeerId } from "../network/types.js";
import type { ActionTransforms, ActionBlocks, BlockActionStatus, ITransactor, PendSuccess, StaleFailure, IKeyNetwork, BlockId, GetBlockResults, PendResult, CommitResult, PendRequest, IRepo, BlockGets, Transforms, CommitRequest, ActionId, RepoCommitRequest, ClusterNomineesResult, CollectionId, IBlock } from "../index.js";
import type { IBlockChangeNotifier, CollectionChangeListener } from "./change-notifier.js";
import { transformForBlockId, groupBy, concatTransforms, concatTransform, transformsFromTransform, blockIdsForTransforms, Log, Tracker, CacheSource, TransactorSource } from "../index.js";
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
	/**
	 * Per-peer dial deadline in ms applied to each downstream repo call.
	 * `timeoutMs` is the overall transaction budget; `dialTimeoutMs` caps how
	 * long a single peer can hold that budget hostage during its dial. When a
	 * peer is unreachable, the dial fails fast and the batch-retry loop can
	 * re-pick a different coordinator within the remaining overall budget.
	 * Omit to fall back to a sensible default (3s); set 0 / negative to disable.
	 */
	dialTimeoutMs?: number;
	/**
	 * Optional local change-notifier (e.g. the hosting node's StorageRepo) used to
	 * satisfy {@link IBlockChangeNotifier}. When supplied, `onCollectionChange`
	 * delegates to it so consumers can feature-detect change notifications on the
	 * transactor they already hold rather than reaching into node internals. When
	 * absent, `onCollectionChange` is a logged no-op.
	 */
	localChangeNotifier?: IBlockChangeNotifier;
}

/**
 * Default per-peer dial deadline. Chosen as a compromise between:
 *  - long enough for a typical libp2p dial+TLS handshake on a wired LAN
 *    (sub-second) plus reasonable WAN latency, including circuit-relay hops;
 *  - short enough that an unreachable cluster member burns ~1/10th of a
 *    typical 30s transaction budget before the retry loop moves on.
 */
const DEFAULT_DIAL_TIMEOUT_MS = 3000;

export class NetworkTransactor implements ITransactor, IBlockChangeNotifier {
	private readonly keyNetwork: IKeyNetwork;
	private readonly timeoutMs: number;
	private readonly abortOrCancelTimeoutMs: number;
	private readonly dialTimeoutMs: number | undefined;
	private readonly getRepo: (peerId: PeerId) => IRepo;
	private readonly localChangeNotifier: IBlockChangeNotifier | undefined;

	/**
	 * Per-transaction coordinator cache: `actionId → (blockId → resolved coordinator)`.
	 * {@link pend} populates it from its final (retry-adjusted) batch assignment; commit
	 * reads it via {@link resolveCoordinator} before falling back to a live
	 * `findCoordinator`, so a block's coordinator is resolved once per transaction across
	 * the pend→commit window instead of once at pend and again at commit.
	 *
	 * Keyed by `actionId`, which is unique per transaction, so an entry is only ever read
	 * by commits of the SAME transaction — the ones that immediately follow its pend. Once
	 * those finish, nothing reads the entry again (a later transaction has a fresh
	 * actionId), so it carries no cross-transaction staleness even if it lingers. The TTL
	 * and size cap in {@link txnCoordinatorsFor} are therefore only a memory backstop that
	 * reclaims entries from transactions that pend but never commit — NOT a staleness
	 * bound. This is why keying by actionId gives the same "thrown away when the
	 * transaction ends" safety as threading a Map through the call, without touching the
	 * ITransactor contract.
	 */
	private readonly txnCoordinatorCache = new Map<ActionId, { coordinators: Map<BlockId, PeerId>; expires: number }>();
	private static readonly MAX_TXN_COORDINATOR_CACHE_ENTRIES = 1000;

	constructor(
		init: NetworkTransactorInit,
	) {
		this.keyNetwork = init.keyNetwork;
		this.timeoutMs = init.timeoutMs;
		this.abortOrCancelTimeoutMs = init.abortOrCancelTimeoutMs;
		// A user explicitly passing 0 or negative means "do not bound dials separately".
		// Undefined falls back to the library default.
		this.dialTimeoutMs = init.dialTimeoutMs === undefined
			? DEFAULT_DIAL_TIMEOUT_MS
			: (init.dialTimeoutMs > 0 ? init.dialTimeoutMs : undefined);
		this.getRepo = init.getRepo;
		this.localChangeNotifier = init.localChangeNotifier;
	}

	/**
	 * Subscribe to commits landing on the local node for `collectionId`, delegating
	 * to the `localChangeNotifier` supplied at construction. When no notifier was
	 * supplied this is a no-op (returns an inert unsubscribe) — a NetworkTransactor
	 * with no co-located storage cannot observe commits locally.
	 */
	onCollectionChange(collectionId: CollectionId, listener: CollectionChangeListener): () => void {
		if (!this.localChangeNotifier) {
			log('onCollectionChange: no localChangeNotifier configured; subscription is a no-op for collection=%s', collectionId);
			return () => { };
		}
		return this.localChangeNotifier.onCollectionChange(collectionId, listener);
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
				(batch) => this.getRepo(batch.peerId).get({ blockIds: batch.payload, context: blockGets.context }, { expiration, dialTimeoutMs: this.dialTimeoutMs }),
				batch => batch.payload,
				(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(bid => bid === blockId)],
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
			);
		} catch (e) {
			error = e as Error;
		}

		// Second-chance retry: ONLY for a genuine no-response — a batch with no valid
		// response, or a response missing an entry for a requested block id. An
		// authoritative "absent" answer (a valid response that carries an entry for
		// every requested block id, even one whose entry has only `state` and no
		// materialized `block`) is FINAL and must not retry. A block that genuinely
		// does not exist yet surfaces as `{ state: {} }` (an entry that is present) —
		// retrying it doubles the round-trips on the common createOrOpen "does this
		// block exist?" probe. Cross-member reconciliation for a missing block has
		// already happened one layer down: CoordinatorRepo.get detects `isMissing` and
		// consults cluster peers before it responds, so by the time an authoritative
		// absent reaches here there is nothing left for a transactor-level retry to
		// discover. See ticket txn-perf-authoritative-notfound.
		const hasValidResponse = (b: CoordinatorBatch<BlockId[], GetBlockResults>) => {
			return b.request?.isResponse === true && b.request.response != null;
		};

		// A batch is answered when its response carries an entry for EVERY requested
		// block id. An entry present with only `state` (no `block`) is an authoritative
		// "absent", which counts as answered — not a gap.
		const isAuthoritative = (b: CoordinatorBatch<BlockId[], GetBlockResults>) => {
			if (!hasValidResponse(b)) return false;
			const resp = b.request!.response! as GetBlockResults;
			return b.payload.every(bid => resp[bid] !== undefined);
		};

		// Retry only genuine no-response / partial-response batches. An authoritative
		// absent answer is not retried.
		const retryable = Array.from(allBatches(batches)).filter(b =>
			!isAuthoritative(b as any)
		) as CoordinatorBatch<BlockId[], GetBlockResults>[];

		if (retryable.length > 0 && Date.now() < expiration) {
			log('get:retry retryable=%d', retryable.length);
			// Fan out the per-batch retries concurrently. Each root batch builds its own
			// excluded-peer set and attaches its own `subsumedBy`, so the retry rounds are
			// independent per root and safe to run in parallel.
			const retryOutcomes = await Promise.allSettled(retryable.map(async b => {
				const excluded = new Set<PeerId>([b.peerId, ...((b.excludedPeers ?? []) as PeerId[])]);
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
						(batch) => this.getRepo(batch.peerId).get({ blockIds: batch.payload, context: blockGets.context }, { expiration, dialTimeoutMs: this.dialTimeoutMs }),
						batch => batch.payload,
						(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(id => id === blockId)],
						expiration,
						async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
					);
				}
			}));
			// First-error-wins: keep any pre-existing error, otherwise adopt the first
			// rejection across the concurrent retries (retryable order is preserved).
			for (const outcome of retryOutcomes) {
				if (outcome.status === 'rejected' && !error) {
					error = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
				}
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
		const results: BlockActionStatus[] = blockActions.map(ref => ({
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
				// Neither pending nor the latest committed. Block state alone calls this `aborted`, but a
				// committed action that was later durably **invalidated** also presents this way — the
				// compensating revision is now the block's latest, so the original action is no longer it.
				// The `refineInvalidatedStatuses` pass below disambiguates from the authoritative log.
				return 'aborted';
			})
		}));

		// Authoritative `committed-invalidated` from durable state: consult each affected collection's
		// log for an InvalidationEntry against the queried action (survives a node restart — the in-memory
		// dispute map is only a fast cache; the log is the source of truth). Only `aborted` slots are
		// ambiguous, so this is a no-op for ordinary pending/committed queries.
		await this.refineInvalidatedStatuses(results, blockStates);
		return results;
	}

	/**
	 * Refine the otherwise-`aborted` statuses to `committed-invalidated` for any queried action that has a
	 * durable {@link import("../log/struct.js").InvalidationEntry} against it. Reads the collection log via
	 * {@link Log.findInvalidation} — the durable, restart-surviving source of truth (`docs/right-is-right.md`
	 * §Durable Invalidation) — rather than the per-node, in-memory dispute map. A `pending` slot is left
	 * untouched: a still-pending transaction whose base was invalidated will be rejected on its own
	 * validation ("pending → will-be-rejected"), which is not the same as `committed-invalidated`.
	 *
	 * Best-effort and isolated: a log-open/read fault leaves the slot `aborted` (logged) rather than
	 * failing the whole status query. The per-call caches keep one log open and one lookup per
	 * `(collection, action)` even when many refs share a collection.
	 */
	private async refineInvalidatedStatuses(results: BlockActionStatus[], blockStates: GetBlockResults): Promise<void> {
		const logByCollection = new Map<CollectionId, Log<unknown> | undefined>();
		const invalidatedByKey = new Map<string, boolean>();

		for (const ref of results) {
			if (!ref.statuses.some(status => status === 'aborted')) {
				continue; // no ambiguous slot — an invalidation could not change this ref's answer
			}
			const collectionId = collectionIdForRef(ref, blockStates);
			if (collectionId === undefined) {
				continue; // genuinely aborted: no fetched block to anchor a collection log on
			}
			const key = `${collectionId} ${ref.actionId}`;
			let invalidated = invalidatedByKey.get(key);
			if (invalidated === undefined) {
				invalidated = await this.hasDurableInvalidation(collectionId, ref.actionId, logByCollection);
				invalidatedByKey.set(key, invalidated);
			}
			if (!invalidated) {
				continue;
			}
			for (let i = 0; i < ref.statuses.length; i++) {
				if (ref.statuses[i] === 'aborted') {
					ref.statuses[i] = 'committed-invalidated';
				}
			}
		}
	}

	/** Whether `actionId` has a durable invalidation entry in `collectionId`'s log (opened once, cached). */
	private async hasDurableInvalidation(
		collectionId: CollectionId,
		actionId: ActionId,
		logByCollection: Map<CollectionId, Log<unknown> | undefined>,
	): Promise<boolean> {
		try {
			let collectionLog = logByCollection.get(collectionId);
			if (!logByCollection.has(collectionId)) {
				const source = new TransactorSource<IBlock>(collectionId, this, undefined);
				const tracker = new Tracker<IBlock>(new CacheSource<IBlock>(source));
				collectionLog = await Log.open<unknown>(tracker, collectionId);
				logByCollection.set(collectionId, collectionLog);
			}
			if (!collectionLog) {
				return false;
			}
			return (await collectionLog.findInvalidation(actionId)) !== undefined;
		} catch (err) {
			log('getStatus: durable invalidation lookup failed collection=%s action=%s: %o', collectionId, actionId, err);
			return false;
		}
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
						dialTimeoutMs: this.dialTimeoutMs,
						coordinatingBlockIds: batch.coordinatingBlockIds
					}
				),
				batch => blockIdsForTransforms(batch.payload),
				transformForBlock,
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
			);
			// Cache resolved coordinators for follow-up commit to hit the same peers
			try {
				for (const b of Array.from(allBatches(batches))) {
					this.keyNetwork.recordCoordinator?.(await blockIdToBytes(b.blockId), b.peerId);
				}
			} catch (e) { log('WARN: Failed to record coordinator hint %o', e); }
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
			void Promise.resolve().then(() => this.cancelBatch(batches, { blockIds, actionId: blockAction.actionId })).catch(e => log('WARN: cancel after pend failure rejected: %o', e));
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

		// Seed the per-transaction coordinator cache from the final (retry-adjusted) batch
		// assignment so the follow-up commit reuses pend's resolution without a fresh
		// findCoordinator round or a hop through the optional recordCoordinator hint. We read
		// blockIdsForTransforms(b.payload) rather than the anchor b.blockId so EVERY block a
		// consolidated batch coordinates is recorded — and against the peer that actually
		// pended it, since a block re-homed by a retry lands in the retry batch's payload.
		// NOTE: this cache assumes cluster membership is stable for the transaction's
		// lifetime — the coordinator resolved here is reused verbatim at commit. Transactions
		// are short, so that holds today. If a future change lets clusters churn *within* a
		// single transaction (e.g. very long-running commits), a cached coordinator could
		// point at a peer no longer in the cohort; commit self-heals (a failed cached peer is
		// excluded and re-resolved live by processBatches), at the cost of one wasted round-trip.
		const txnCoordinators = this.txnCoordinatorsFor(blockAction.actionId);
		for (const b of completed) {
			for (const bid of blockIdsForTransforms(b.payload)) {
				txnCoordinators.set(bid, b.peerId);
			}
		}

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
			(batch) => this.getRepo(batch.peerId).cancel({ actionId: actionRef.actionId, blockIds: batch.payload }, { expiration, dialTimeoutMs: this.dialTimeoutMs }),
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

		// Commit the header block if provided and not already in blockIds.
		// `request.tailId` is threaded into every per-block commit so the coordinator carries it into the
		// consensus commit op → each committing node's StorageRepo.commit stamps it onto the emitted
		// CollectionChangeEvent (the reactivity topic anchor). Without this the per-block RepoCommitRequest
		// drops the collection tail and reactivity origination is gated off (undefined tail → non-member).
		if (request.headerId && !request.blockIds.includes(request.headerId)) {
			const headerResult = await this.commitBlock(request.headerId, allBlockIds, request.actionId, request.rev, request.tailId);
			if (!headerResult.success) {
				return headerResult;
			}
		}

		// Commit the tail block
		const tailResult = await this.commitBlock(request.tailId, allBlockIds, request.actionId, request.rev, request.tailId);
		if (!tailResult.success) {
			return tailResult;
		}

		// Commit all remaining block ids (excluding tail and header if it was already handled)
		const remainingBlocks = request.blockIds.filter(bid =>
			bid !== request.tailId &&
			!(request.headerId && bid === request.headerId && !request.blockIds.includes(request.headerId))
		);
		if (remainingBlocks.length > 0) {
			const { error } = await this.commitBlocks({ blockIds: remainingBlocks, actionId: request.actionId, rev: request.rev, tailId: request.tailId });
			if (error) {
				// Non-tail block commit failures should not fail the overall action once the tail has committed.
				// Proceed and rely on reconciliation paths (e.g. reads with context) to finalize state on lagging peers.
				try { log('WARN: non-tail commit had errors; proceeding after tail commit: %s', error.message); } catch { /* ignore */ }
			}
		}

		log('commit:done actionId=%s ms=%d', request.actionId, Date.now() - t0);
		return { success: true };
	}

	private async commitBlock(blockId: BlockId, blockIds: BlockId[], actionId: ActionId, rev: number, tailId?: BlockId): Promise<CommitResult> {
		const { batches: tailBatches, error: tailError } = await this.commitBlocks({ blockIds: [blockId], actionId, rev, tailId });
		if (tailError) {
			// Cancel all pending actions as background microtask
			void Promise.resolve().then(() => this.cancel({ blockIds, actionId })).catch(e => log('WARN: cancel after commit failure rejected: %o', e));
			// Collect and return any active stale failures
			const stale = Array.from(allBatches(tailBatches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {
				return { missing: distinctBlockActionTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing).filter((x): x is ActionTransforms => x !== undefined)), success: false as const };
			}
			throw tailError;
		}
		return { success: true };
	}

	/** Attempts to commit a set of blocks, and handles failures and errors */
	private async commitBlocks({ blockIds, actionId, rev, tailId }: RepoCommitRequest) {
		const expiration = Date.now() + this.timeoutMs;
		// Thread the transaction's actionId so both the initial batch assembly and any
		// per-block retry re-resolution prefer the coordinator pend already resolved.
		const batches = await this.batchesForPayload<BlockId[], CommitResult>(blockIds, blockIds, mergeBlocks, [], actionId);
		log('commitBlocks actionId=%s rev=%d batches=%d', actionId, rev, batches.length);
		let error: Error | undefined;
		try {
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).commit({ actionId, blockIds: batch.payload, rev, tailId }, { expiration, dialTimeoutMs: this.dialTimeoutMs }),
				batch => batch.payload,
				mergeBlocks,
				expiration,
				async (blockId, options) => this.resolveCoordinator(blockId, options, actionId)
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
		excludedPeers: PeerId[],
		/** When set, prefer a coordinator this transaction already resolved at pend (see {@link resolveCoordinator}). */
		actionId?: ActionId
	): Promise<CoordinatorBatch<TPayload, TResponse>[]> {
		return createBatchesForPayload<TPayload, TResponse>(
			blockIds,
			payload,
			getBlockPayload,
			excludedPeers,
			async (blockId, options) => this.resolveCoordinator(blockId, options, actionId)
		);
	}

	/**
	 * Resolve the coordinator for `blockId`, preferring one this transaction already
	 * resolved during pend (the per-transaction cache) before falling back to a live
	 * `findCoordinator`. A cached coordinator that is in `excludedPeers` (already tried and
	 * failed during a retry) is skipped so a retry can't loop on a dead coordinator. A
	 * cache miss — including every call with no `actionId` (get/cancel) — never fails; it
	 * always falls through to live resolution.
	 */
	private async resolveCoordinator(
		blockId: BlockId,
		options: { excludedPeers: PeerId[] },
		actionId: ActionId | undefined
	): Promise<PeerId> {
		if (actionId !== undefined) {
			const cached = this.txnCoordinatorCache.get(actionId)?.coordinators.get(blockId);
			if (cached && !options.excludedPeers.some(p => p.toString() === cached.toString())) {
				return cached;
			}
		}
		return this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options);
	}

	/**
	 * Get (creating if absent) the per-transaction coordinator map for `actionId`,
	 * refreshing its expiry and lazily sweeping expired sibling entries. See
	 * {@link txnCoordinatorCache} for why the TTL/size cap here is a memory backstop and
	 * not a staleness bound.
	 */
	private txnCoordinatorsFor(actionId: ActionId): Map<BlockId, PeerId> {
		const now = Date.now();
		// Reclaim entries from transactions that pended but never committed. A live entry is
		// never stale (unique actionId; read only by its own transaction's commit), so
		// sweeping lazily on write is safe.
		for (const [aid, entry] of this.txnCoordinatorCache) {
			if (entry.expires <= now) this.txnCoordinatorCache.delete(aid);
		}
		// Comfortably covers a normal pend→commit gap (~2 op budgets) with a fixed floor;
		// an entry outliving this only loses the optimization (commit re-resolves live),
		// never correctness.
		const ttlMs = Math.max(this.timeoutMs * 2, 60_000);
		const existing = this.txnCoordinatorCache.get(actionId);
		if (existing) {
			existing.expires = now + ttlMs;
			return existing.coordinators;
		}
		const created = { coordinators: new Map<BlockId, PeerId>(), expires: now + ttlMs };
		this.txnCoordinatorCache.set(actionId, created);
		while (this.txnCoordinatorCache.size > NetworkTransactor.MAX_TXN_COORDINATOR_CACHE_ENTRIES) {
			const oldest = this.txnCoordinatorCache.keys().next().value as ActionId | undefined;
			if (oldest == null || oldest === actionId) break;
			this.txnCoordinatorCache.delete(oldest);
		}
		return created.coordinators;
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
			(batch) => this.getRepo(batch.peerId).cancel({ actionId: actionRef.actionId, blockIds: batch.payload }, { expiration, dialTimeoutMs: this.dialTimeoutMs }),
			batch => batch.payload,
			mergeBlocks,
			expiration,
			async (blockId, options) => this.keyNetwork.findCoordinator(await blockIdToBytes(blockId), options)
		);
	}

	private formatBatchStatuses<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		_isSuccess: (b: CoordinatorBatch<TPayload, TResponse>) => boolean,
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


/**
 * The owning collection id for an action ref, read from any fetched block's header. A
 * committed-then-invalidated action still has a materialized (compensating) block whose header carries
 * the collection id; a genuinely-aborted action has no fetched block, so this returns `undefined` and
 * the status stays `aborted`.
 */
function collectionIdForRef(ref: ActionBlocks, blockStates: GetBlockResults): CollectionId | undefined {
	for (const blockId of ref.blockIds) {
		const collectionId = blockStates[blockId]?.block?.header.collectionId;
		if (collectionId !== undefined) {
			return collectionId;
		}
	}
	return undefined;
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
