/**
 * One action's pends, or one action's commits, of several collections that a coordinator runs as ONE
 * consensus record — what `IRepo.pendMany` and `IRepo.commitMany` take. `CoordinatorRepo` runs a single
 * `pend` or `commit` as a batch of one, so both shapes take one code path.
 */
import type { ActionId, BlockId, CommitRequest, IRepo, PendRequest, RepoOperation } from "@optimystic/db-core";
import { blockIdsForTransforms } from "@optimystic/db-core";
import { batchShapeFault } from "../cluster/record-operations.js";

export interface RequestBatch<TRequest> {
	/** The requests in the order given. Each keeps its own revision, tail, bases and digests. */
	readonly requests: readonly [TRequest, ...TRequest[]];
	/** The record's operations: one per request, in the same order. */
	readonly operations: [RepoOperation, ...RepoOperation[]];
	/** The one action every request names. */
	readonly actionId: ActionId;
	/** Every block any request writes, each once, in request order. The first is the block a cohort is
	 *  resolved for when nothing else names one. */
	readonly blockIds: BlockId[];
	/** Each block with the request that writes it, in request order — what a per-collection judgement
	 *  of a block (its revision, base or action) reads. No block appears twice. */
	readonly writes: readonly BlockWrite<TRequest>[];
}

export interface BlockWrite<TRequest> {
	readonly request: TRequest;
	readonly blockId: BlockId;
}

export type PendBatch = RequestBatch<PendRequest>;
export type CommitBatch = RequestBatch<CommitRequest>;

/** `requests` as a batch, or a thrown error naming why they are not one ({@link batchOf}). */
export function pendBatchOf(requests: readonly PendRequest[]): PendBatch {
	return batchOf(requests, request => ({ pend: request }), pendBlockIds);
}

/** `requests` as a batch, or a thrown error naming why they are not one ({@link batchOf}). */
export function commitBatchOf(requests: readonly CommitRequest[]): CommitBatch {
	return batchOf(requests, request => ({ commit: request }), request => request.blockIds);
}

/** The blocks one pend request writes. */
function pendBlockIds(request: PendRequest): BlockId[] {
	return blockIdsForTransforms(request.transforms);
}

/**
 * The batch `requests` form, or a thrown error when they form none: an empty list, two action ids, or a
 * block written by two requests (`batchShapeFault`). Thrown, never answered as a refusal: a sender that
 * builds such a list has a bug, and no cohort was asked anything.
 */
function batchOf<TRequest extends { actionId: ActionId }>(
	requests: readonly TRequest[],
	toOperation: (request: TRequest) => RepoOperation,
	blocksOf: (request: TRequest) => readonly BlockId[]
): RequestBatch<TRequest> {
	if (requests.length === 0) {
		throw new Error('Malformed batch: it carries no request');
	}
	const operations = requests.map(toOperation) as [RepoOperation, ...RepoOperation[]];
	const fault = batchShapeFault(operations);
	if (fault !== undefined) {
		throw new Error(`Malformed batch: ${fault}`);
	}
	const writes = requests.flatMap(request => [...new Set(blocksOf(request))].map(blockId => ({ request, blockId })));
	return {
		requests: requests as readonly [TRequest, ...TRequest[]],
		operations,
		actionId: requests[0]!.actionId,
		blockIds: writes.map(write => write.blockId),
		writes
	};
}

/**
 * `repo`'s batch methods, for a wrapper to spread into the repo it builds: present exactly when `repo`
 * has them. A wrapper that leaves them off makes a writer fall back to one request per collection
 * without saying so.
 */
export function forwardedBatchMethods(repo: IRepo): Pick<IRepo, 'pendMany' | 'commitMany'> {
	return {
		...(repo.pendMany ? { pendMany: repo.pendMany.bind(repo) } : {}),
		...(repo.commitMany ? { commitMany: repo.commitMany.bind(repo) } : {})
	};
}
