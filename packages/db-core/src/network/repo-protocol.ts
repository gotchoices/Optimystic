import type { ActionBlocks, PendRequest, CommitRequest, BlockGets, InvalidateRequest } from "../index.js";

/** One operation a {@link RepoMessage} asks for. */
export type RepoOperation =
	{ get: BlockGets } |
	{ pend: PendRequest } |
	{ cancel: { actionRef: ActionBlocks } } |
	{ commit: CommitRequest } |
	{ invalidate: InvalidateRequest };

export type RepoMessage = {
	/**
	 * What the message asks for. A message of more than one operation must be a **batch**, the several
	 * collections of one action written together:
	 * - every operation is a `pend`, or every operation is a `commit` — no `get`, `cancel` or
	 *   `invalidate`, and no mixing;
	 * - every operation names the same action id;
	 * - no block id appears in two operations: collections never share blocks, and a duplicate would
	 *   pend or commit one block twice under one action, at two revisions.
	 *
	 * Each operation keeps its own request — its own revision, log tail, bases and digests — and is
	 * applied one at a time. A one-operation message is trivially a batch. `batchShapeFault` in
	 * `packages/db-p2p/src/cluster/record-operations.ts` is the one implementation of the rule.
	 */
	operations: [RepoOperation, ...RepoOperation[]],
	expiration?: number,
	coordinatingBlockIds?: string[],
};
