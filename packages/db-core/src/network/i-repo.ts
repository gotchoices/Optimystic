import type { ActionBlocks, CommitResult, GetBlockResults, PendResult, PendRequest, BlockGets, BlockId, ActionId } from "../index.js";

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
};

export type IRepo = {
	get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults>;
	pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
	cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void>;
	commit(request: RepoCommitRequest, options?: MessageOptions): Promise<CommitResult>;
}
