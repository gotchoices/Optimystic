import type { GetBlockResults, ActionBlocks, BlockActionStatus, PendResult, CommitResult, PendRequest, CommitRequest, BlockGets } from "../index.js";

export type ITransactor = {
	/** Get blocks by their IDs and versions or a specific action
		- Does not update the version of the block, but the action is available for explicit reading, and for committing
		- If the action targets the correct version, the call succeeds, unless failIfPending and there are any pending actions - the caller may choose to wait for pending actions to clear rather than risk racing with them
		- If the action targets an older version, the call fails, and the caller must resync using the missing actions
	 */
	get(blockGets: BlockGets): Promise<GetBlockResults>;

	/** Get statuses of block actions */
	getStatus(actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]>;

	/** Post an action for a set of blocks
		- Does not update the version of the block, but the action is available for explicit reading, and for committing
		- If the action targets the correct version, the call succeeds, unless pending = 'fail' and there are any pending actions - the caller may choose to wait for pending actions to clear rather than risk racing with them
		- If the action targets an older version, the call fails, and the caller must resync using the missing actions
	 */
	pend(blockAction: PendRequest): Promise<PendResult>;

	/** Cancel a pending action
		- If the given action ID is pending, it is canceled
	 */
	cancel(actionRef: ActionBlocks): Promise<void>;

	/** Commit a pending action
		- If the action references the current version, the pending action is committed
		- If the returned fails, the transforms necessary to update all overlapping blocks are returned
		- If the action mentions other collections, those are assumed conditions - returned conditions only list inherited conditions
	 */
	commit(request: CommitRequest): Promise<CommitResult>;
}
