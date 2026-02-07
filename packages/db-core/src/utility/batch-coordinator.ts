import type { PeerId } from "../network/types.js";
import type { BlockId } from "../index.js";
import { Pending } from "./pending.js";

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
export function mergeBlocks(payload: BlockId[], blockId: BlockId, mergeWithPayload: BlockId[] | undefined): BlockId[] {
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
 */
export async function processBatches<TPayload, TResponse>(
	batches: CoordinatorBatch<TPayload, TResponse>[],
	process: (batch: CoordinatorBatch<TPayload, TResponse>) => Promise<TResponse>,
	getBlockIds: (batch: CoordinatorBatch<TPayload, TResponse>) => BlockId[],
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	expiration: number,
	findCoordinator: (blockId: BlockId, options: { excludedPeers: PeerId[] }) => Promise<PeerId>
): Promise<void> {
    // Root-map ensures retries are recorded on the original batch to avoid deep trees
    const rootOf = new WeakMap<CoordinatorBatch<TPayload, TResponse>, CoordinatorBatch<TPayload, TResponse>>();
    for (const b of batches) rootOf.set(b, b);

    // Process a set of batches concurrently and enqueue retries flatly onto the root's subsumedBy list
    const processSet = async (set: CoordinatorBatch<TPayload, TResponse>[]) => {
        await Promise.all(set.map(async (batch) => {
            batch.request = new Pending(process(batch)
                .catch(async e => {
                    if (expiration > Date.now()) {
                        const excludedPeers = [batch.peerId, ...(batch.excludedPeers ?? [])];
                        const retries = await createBatchesForPayload<TPayload, TResponse>(
                            getBlockIds(batch),
                            batch.payload,
                            getBlockPayload,
                            excludedPeers,
                            findCoordinator
                        );
                        if (retries.length > 0 && expiration > Date.now()) {
                            const root = rootOf.get(batch) ?? batch;
                            root.subsumedBy = [...(root.subsumedBy ?? []), ...retries];
                            for (const r of retries) rootOf.set(r, root);
                            // Process retries, but ensure further failures also attach to the same root
                            await processSet(retries);
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
	return makeBatchesByPeer<TPayload, TResponse>(blockIdPeerId, payload, getBlockPayload, excludedPeers);
}
