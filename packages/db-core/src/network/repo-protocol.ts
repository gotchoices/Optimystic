import type { ActionBlocks, PendRequest, CommitRequest, BlockGets, InvalidateRequest } from "../index.js";

export type RepoMessage = {
	operations: [
		{ get: BlockGets } |
		{ pend: PendRequest } |
		{ cancel: { actionRef: ActionBlocks } } |
		{ commit: CommitRequest } |
		{ invalidate: InvalidateRequest }
	],
	expiration?: number,
	coordinatingBlockIds?: string[],
};
