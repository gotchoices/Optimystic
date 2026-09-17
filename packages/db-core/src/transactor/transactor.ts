import type { GetBlockResults, ActionBlocks, ActionLineage, BlockActionStatus, PendResult, CommitResult, PendRequest, CommitRequest, BlockGets, BlockId } from "../index.js";
import type { PeerId } from "../network/types.js";

export type ClusterNomineesResult = {
	/** Peer IDs of the cluster members who can participate in consensus */
	nominees: PeerId[];
};

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
		- Returning means DISCHARGED: an implementation that could not remove the pending records
		  must throw rather than return, because nothing else will ever remove them (a record's only
		  removers are this cancel, a divergence-shaped commit refusal, and a forward write of the
		  same action id — see docs/repository.md), and while one stands every later write to the
		  block is refused. A caller that swallows the throw must still say so in its log.
	 */
	cancel(actionRef: ActionBlocks): Promise<void>;

	/** Commit a pending action
		- If the action references the current version, the pending action is committed
		- If the returned fails, the transforms necessary to update all overlapping blocks are returned
		- If the action mentions other collections, those are assumed conditions - returned conditions only list inherited conditions
	 */
	commit(request: CommitRequest): Promise<CommitResult>;

	/** Query cluster nominees for a critical block (used in GATHER phase for multi-collection transactions)
		- Returns the peer IDs of cluster members who can participate in consensus for the given block
		- Used to build the supercluster for multi-collection transaction consensus
	 */
	queryClusterNominees?(blockId: BlockId): Promise<ClusterNomineesResult>;

	/** Whether a COMMITTED action is part of what each named block holds now — the question a
		writer asks when its own write was superseded before it could confirm it (see `BlockLineage`).
		- `getStatus` cannot answer this: it judges a block by who holds its LATEST revision, so a
		  write that landed and was then built upon reads there as not committed.
		- `contains` is an acknowledgement and meets the same bar as a commit's: a strict majority of
		  the block's cohort holds content built from the action.
		- Read-only. It promotes nothing, so asking can never be what makes a write land.
		- Optional: a transactor (or a wrapper around one) that does not offer it leaves the writer
		  unable to establish the outcome, which it reports as such rather than guessing either way.
	 */
	getLineage?(ref: ActionBlocks & { rev: number }): Promise<ActionLineage>;
}
