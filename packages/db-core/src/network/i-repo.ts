import type { ActionBlocks, CommitResult, GetBlockResults, PendResult, PendRequest, CommitRequest, BlockGets, BlockId, ActionId } from "../index.js";

export type MessageOptions = {
	expiration?: number;
	signal?: AbortSignal;
}

export type RepoCommitRequest = {
	blockIds: BlockId[];
	actionId: ActionId;
	rev: number;
};

export type IRepo = {
	get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults>;
	pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
	cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void>;
	commit(request: RepoCommitRequest, options?: MessageOptions): Promise<CommitResult>;
}
