import type { ActionBlocks, BlockContentDigests, CommitResult, GetBlockResults, PendResult, PendRequest, BlockGets, BlockId, ActionId } from "../index.js";

export type MessageOptions = {
	expiration?: number;
	signal?: AbortSignal;
	/**
	 * Per-peer dial deadline in ms. Bounds only the dial portion of a call, so
	 * an unreachable peer fails fast and the caller's retry loop can re-pick
	 * a different coordinator. Independent of `expiration` (the overall budget):
	 * a 30s transaction with `dialTimeoutMs: 3000` can afford ten 3s dial
	 * attempts against different peers. Once a dial succeeds, the response wait
	 * is bound by the remaining `expiration` budget. Undefined means "do not
	 * impose a separate dial cap; the overall budget is the cap".
	 */
	dialTimeoutMs?: number;
	/**
	 * Blocks this coordinator is responsible for driving through consensus. Threaded
	 * from {@link NetworkTransactor.pend}'s batch (which consolidates several blocks
	 * onto one coordinating peer) into {@link CoordinatorRepo.pend}, which uses it to
	 * pick the cluster anchor. Absent on bare per-block paths, which fall back to the
	 * transforms' own block ids.
	 */
	coordinatingBlockIds?: BlockId[];
}

export type RepoCommitRequest = {
	blockIds: BlockId[];
	actionId: ActionId;
	rev: number;
	/**
	 * The collection's chain tail block id (the {@link CommitRequest.tailId}). Optional on the per-block
	 * repo operation: the transactor threads the committing collection's tail through every per-block
	 * commit so the coordinator carries it into the consensus commit op, letting the committing node's
	 * `StorageRepo.commit` stamp it onto the emitted `CollectionChangeEvent` (the reactivity topic anchor
	 * `H(tailId ‖ "reactivity")`). Absent on bare per-block paths (e.g. churn replication), which never
	 * originate reactivity.
	 */
	tailId?: BlockId;
	/**
	 * Per-block content declarations for this batch (see {@link BlockContentDigests}).
	 * The transactor narrows its action-wide {@link CommitRequest.blockDigests} to this request's own
	 * `blockIds` before sending, so a cohort only ever declares for the blocks it is driving —
	 * `RepoClient.commit` wraps this whole request into the `RepoMessage`, and the coordinator places
	 * the received request into the consensus message, so the digests land inside every cohort
	 * signature's preimage. Absent when no block in this batch could be digested (each undeclared
	 * block falls back to corroboration).
	 */
	blockDigests?: BlockContentDigests;
};

export type IRepo = {
	get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults>;
	pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
	cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void>;
	commit(request: RepoCommitRequest, options?: MessageOptions): Promise<CommitResult>;
}
