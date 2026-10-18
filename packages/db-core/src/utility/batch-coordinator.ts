import type { PeerId } from "../network/types.js";
import type { BlockId } from "../index.js";
import { Pending } from "./pending.js";
import { unrefDelay } from "./unref-timer.js";
import { createLogger } from "../logger.js";

const log = createLogger('batch-coordinator');

/**
 * How a transactor paces the retries it sends after a request went unanswered. A request given up
 * on at a deadline was usually not lost: its frames are still in this node's send queue to that
 * peer, so a retry sent at once through the same queue only lengthens the backlog that made its
 * predecessor late. See {@link retryWaitMs}.
 */
export type RetryBackoff = {
	/** First wait in ms — one declared link round trip. Not above 0 disables every wait (no declared round trip). */
	baseMs: number;
	/** The peer this transactor runs on, when it runs on one (`NetworkTransactorInit.localPeerId`). */
	localPeerId?: PeerId;
	/** Test seam; default an unref'd `setTimeout` promise. */
	sleep?: (ms: number) => Promise<void>;
};

/** The retry {@link retryWaitMs} is asked to pace. */
export type RetryAttempt = {
	/** 1-based: how many coordinators this retry's chain has already tried — the retry batch's `excludedPeers.length`. */
	attempt: number;
	/** The coordinator whose request failed. */
	failedPeer: PeerId;
	/** How long that request was outstanding before it failed, ms. */
	outstandingMs: number;
	/** The coordinators the retry will be sent to. */
	retryPeers: readonly PeerId[];
};

/**
 * How long to wait before sending a retry: one base for the first retry of an operation, doubling
 * for each further coordinator its chain tries, and never less than the failed request was
 * outstanding when the retry goes out through this node's own queue to the peer whose request is
 * still in it — when the retry re-picks the failed peer, or when this node coordinates the retry
 * (the failed peer was picked from the block's cohort, so this node's consensus round sends to it).
 * A retry to a third coordinator goes over a different connection and takes no such floor. A fast
 * failure (connection refused) was outstanding briefly, so its floor is small too.
 */
export function retryWaitMs(backoff: RetryBackoff, retry: RetryAttempt): number {
	if (!(backoff.baseMs > 0)) return 0;
	const doubled = backoff.baseMs * 2 ** Math.max(0, retry.attempt - 1);
	// NOTE: the floor is as large as the failure was slow — a request that ran out a whole RPC dial
	// deadline (33 s at a declared 3 s round trip, of a 132 s transaction budget) holds a retry this
	// node coordinates back that long. `retryWaitWithinBudget` keeps the wait inside the budget, not
	// small within it. If field logs show `retry ... waitMs` near the dial deadline costing operations
	// their answer, cap the floor at a few round trips rather than dropping it.
	return sendsThroughFailedPeersQueue(backoff, retry) ? Math.max(doubled, retry.outstandingMs) : doubled;
}

function sendsThroughFailedPeersQueue(backoff: RetryBackoff, retry: RetryAttempt): boolean {
	const failed = retry.failedPeer.toString();
	const local = backoff.localPeerId?.toString();
	return retry.retryPeers.some(peer => {
		const id = peer.toString();
		return id === failed || id === local;
	});
}

/**
 * The wait before a retry, or `undefined` when a positive wait would reach `expiration` — the retry
 * is then not sent (logged `retry:skipped-budget`) and the caller keeps the original failure. The
 * check runs before any timer is armed, which also keeps a doubled wait from reaching `setTimeout`
 * above its 32-bit limit: the transaction budget is far below it. A zero wait is returned as is,
 * leaving the caller's own expiration checks exactly as they were without a backoff.
 */
export function retryWaitWithinBudget(backoff: RetryBackoff | undefined, retry: RetryAttempt, expiration: number): number | undefined {
	const waitMs = backoff ? retryWaitMs(backoff, retry) : 0;
	if (waitMs > 0 && Date.now() + waitMs >= expiration) {
		log('retry:skipped-budget peer=%s waitMs=%d remainingMs=%d', retry.failedPeer.toString(), waitMs, expiration - Date.now());
		return undefined;
	}
	return waitMs;
}

/** The backoff's sleep. Callers await it only for a positive wait, so a zero wait adds no yield and ordering is as it was without one. */
export function retrySleep(backoff: RetryBackoff | undefined): (ms: number) => Promise<void> {
	return backoff?.sleep ?? unrefDelay;
}

/**
 * Represents a batch of operations for a specific block coordinated by a peer
 */
export type CoordinatorBatch<TPayload, TResponse> = {
	peerId: PeerId;
	blockId: BlockId;
	payload: TPayload;
	request?: Pending<TResponse>;
	/** Whether this batch has been subsumed by other successful batches */
	subsumedBy?: CoordinatorBatch<TPayload, TResponse>[];
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
	/** When a batch coordinates multiple blocks (via cluster intersection), lists all block IDs */
	coordinatingBlockIds?: BlockId[];
	/** How long this batch's request was outstanding before it failed, ms — set by {@link processBatches} on failure only. */
	outstandingMs?: number;
	/**
	 * Set by {@link processBatches} when it re-batched this batch's failure onto other coordinators. The
	 * retries sit in the ROOT batch's `subsumedBy` (not this one's) and carry this batch's peer in their
	 * `excludedPeers`, so the chain has already moved past it.
	 */
	rebatched?: true;
}

/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 */
export function makeBatchesByPeer<TPayload, TResponse>(
	blockPeers: (readonly [BlockId, PeerId])[],
	payload: TPayload,
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	excludedPeers?: PeerId[]
): CoordinatorBatch<TPayload, TResponse>[] {
	const groups = blockPeers.reduce((acc, [blockId, peerId]) => {
		const peerId_str = peerId.toString();
		const coordinator = acc.get(peerId_str) ?? { peerId, blockId, excludedPeers } as Partial<CoordinatorBatch<TPayload, TResponse>>;
		acc.set(peerId_str, { ...coordinator, payload: getBlockPayload(payload, blockId, coordinator.payload) } as CoordinatorBatch<TPayload, TResponse>);
		return acc;
	}, new Map<string, CoordinatorBatch<TPayload, TResponse>>());
	return Array.from(groups.values());
}

/**
 * Iterates over all batches that have not completed, whether subsumed or not
 */
export function* incompleteBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[]): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
    const stack: CoordinatorBatch<TPayload, TResponse>[] = [...batches];
    while (stack.length > 0) {
        const batch = stack.pop()!;
        if (!batch.request || !batch.request.isResponse) {
            yield batch;
        }
        if (batch.subsumedBy && batch.subsumedBy.length) {
            stack.push(...batch.subsumedBy);
        }
    }
}

/**
 * Checks if all completed batches (ignoring failures) satisfy a predicate
 */
export function everyBatch<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): boolean {
    // For each root batch require that SOME node in its retry tree satisfies the predicate.
    // Use iterative DFS to avoid recursion depth and minimize allocations.
    for (const root of batches) {
        let found = false;
        const stack: CoordinatorBatch<TPayload, TResponse>[] = [root];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (predicate(node)) { found = true; break; }
            if (node.subsumedBy && node.subsumedBy.length) {
                for (let i = 0; i < node.subsumedBy.length; i++) stack.push(node.subsumedBy[i]!);
            }
        }
        if (!found) return false;
    }
    return true;
}

/**
 * Iterates over all batches that satisfy an optional predicate, whether subsumed or not
 */
export function* allBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate?: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
    const stack: CoordinatorBatch<TPayload, TResponse>[] = [...batches];
    while (stack.length > 0) {
        const batch = stack.pop()!;
        if (!predicate || predicate(batch)) {
            yield batch;
        }
        if (batch.subsumedBy && batch.subsumedBy.length) {
            stack.push(...batch.subsumedBy);
        }
    }
}

/**
 * Returns a new blockId list payload with the given block id appended
 */
export function mergeBlocks(_payload: BlockId[], blockId: BlockId, mergeWithPayload: BlockId[] | undefined): BlockId[] {
	return [...(mergeWithPayload ?? []), blockId];
}

/**
 * Processes a set of batches, retrying any failures until success or expiration
 * @param batches - The batches to process - each represents a group of blocks centered on a coordinating peer
 * @param process - The function to call for a given batch
 * @param getBlockIds - The function to call to get the block ids for a given batch
 * @param getBlockPayload - The function to call to get the payload given a parent payload and block id, and optionally merge with an existing payload
 * @param expiration - The expiration time for the operation
 * @param findCoordinator - The function to call to find a coordinator for a block id
 * @param backoff - How long to wait before each retry ({@link retryWaitMs}); absent, retries go out at once
 */
export async function processBatches<TPayload, TResponse>(
	batches: CoordinatorBatch<TPayload, TResponse>[],
	process: (batch: CoordinatorBatch<TPayload, TResponse>) => Promise<TResponse>,
	getBlockIds: (batch: CoordinatorBatch<TPayload, TResponse>) => BlockId[],
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	expiration: number,
	findCoordinator: (blockId: BlockId, options: { excludedPeers: PeerId[] }) => Promise<PeerId>,
	backoff?: RetryBackoff
): Promise<void> {
    // Root-map ensures retries are recorded on the original batch to avoid deep trees
    const rootOf = new WeakMap<CoordinatorBatch<TPayload, TResponse>, CoordinatorBatch<TPayload, TResponse>>();
    for (const b of batches) rootOf.set(b, b);

    // Re-batch a failed batch onto the next coordinators and process them, after the backoff's wait.
    // The wait is ONE for the whole retry set, decided once its coordinators are known; a wait that
    // would reach the expiration sends no retry, leaving the batch's original failure as its outcome.
    const retry = async (batch: CoordinatorBatch<TPayload, TResponse>, outstandingMs: number) => {
        const excludedPeers = [batch.peerId, ...(batch.excludedPeers ?? [])];
        const retries = await createBatchesForPayload<TPayload, TResponse>(
            getBlockIds(batch),
            batch.payload,
            getBlockPayload,
            excludedPeers,
            findCoordinator
        );
        if (retries.length === 0) return;
        const waitMs = retryWaitWithinBudget(backoff, {
            attempt: excludedPeers.length,
            failedPeer: batch.peerId,
            outstandingMs,
            retryPeers: retries.map(r => r.peerId)
        }, expiration);
        if (waitMs === undefined) return;
        log('retry peer=%s excluded=%d waitMs=%d outstandingMs=%d', batch.peerId.toString(), excludedPeers.length, waitMs, outstandingMs);
        if (waitMs > 0) await retrySleep(backoff)(waitMs);
        if (expiration <= Date.now()) return;
        const root = rootOf.get(batch) ?? batch;
        root.subsumedBy = [...(root.subsumedBy ?? []), ...retries];
        for (const r of retries) rootOf.set(r, root);
        batch.rebatched = true;
        // Process retries, but ensure further failures also attach to the same root
        await processSet(retries);
    };

    // Process a set of batches concurrently and enqueue retries flatly onto the root's subsumedBy list
    const processSet = async (set: CoordinatorBatch<TPayload, TResponse>[]): Promise<void> => {
        await Promise.all(set.map(async (batch) => {
            const sentAt = Date.now();
            batch.request = new Pending(process(batch)
                .catch(async e => {
                    batch.outstandingMs = Date.now() - sentAt;
                    // Always rethrow the ORIGINAL first-attempt error `e` so batch.request.error
                    // preserves the root cause. If retry setup itself fails (e.g., findCoordinator
                    // throws "self-exhausted" on a solo node), that retry error MUST NOT mask `e`.
                    if (expiration > Date.now()) {
                        try {
                            await retry(batch, batch.outstandingMs);
                        } catch (retryErr) {
                            log('retry:setup-failed peer=%s original=%o retry=%o',
                                batch.peerId.toString(), e, retryErr);
                            // Swallow retryErr; the original `e` is authoritative.
                        }
                    }
                    throw e;
                }));
        }));

        // Wait for all in this set to settle
        await Promise.all(set.map(b => b.request?.result().catch(() => { /* ignore */ })));
    };

    await processSet(batches);
}

/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 * This is a placeholder function that will be implemented by the caller
 */
export async function createBatchesForPayload<TPayload, TResponse>(
	blockIds: BlockId[],
	payload: TPayload,
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	excludedPeers: PeerId[],
	findCoordinator: (blockId: BlockId, options: { excludedPeers: PeerId[] }) => Promise<PeerId>
): Promise<CoordinatorBatch<TPayload, TResponse>[]> {
	// Group by block id
	const distinctBlockIds = new Set(blockIds);

	// Find coordinator for each key
	const blockIdPeerId = await Promise.all(
		Array.from(distinctBlockIds).map(async (bid) =>
			[bid, await findCoordinator(bid, { excludedPeers })] as const
		)
	);

	// Group blocks around their coordinating peers
	const batches = makeBatchesByPeer<TPayload, TResponse>(blockIdPeerId, payload, getBlockPayload, excludedPeers);
	log('createBatches blockIds=%d batches=%d excluded=%d', distinctBlockIds.size, batches.length, excludedPeers.length);
	return batches;
}
