/**
 * The read-only `ITransactor` one blob reclaim pass reads committed state through (docs/blobs.md
 * §Lifetime).
 *
 * It does two things the pass cannot do for itself, because the pass reads through
 * `BlobScopeRegistry.enumerate` and `BlobReferenceTree.listed` and never sees a block answer:
 *
 *  - every read asks the answering coordinators to consult their cohorts in FRONT of the answer
 *    (`BlockGets.awaitConsult`), so an answer served from an expired read-repair window can carry
 *    that consult's verdict rather than having it run behind the read;
 *  - every block whose answer did not carry `GetBlockResult.cohortConfirmed` is recorded, so the
 *    pass can ask whether this node is the whole cohort of exactly those blocks before it counts.
 */

import type {
	ActionBlocks,
	BlockActionStatus,
	BlockGets,
	BlockId,
	CommitResult,
	HlcClock,
	ITransactor,
	GetBlockResults,
	PendResult,
} from '@optimystic/db-core';

/**
 * A reclaim pass tried to write through its transactor. Nothing in a pass writes — it reads
 * committed state and then changes this node's own blob records — so this is a defect in the pass,
 * not a condition a caller handles.
 */
export class ReclaimReadOnlyError extends Error {
	constructor(attempted: string) {
		super(`A blob reclaim pass tried to ${attempted}: a pass only reads committed state`);
		this.name = 'ReclaimReadOnlyError';
	}
}

/**
 * One reclaim pass's view of committed state. Built fresh per pass, so {@link unconfirmed}
 * accumulates over the registry read and every reference-tree read of that one pass and over
 * nothing else.
 *
 * `ITransactor`'s optional members (`queryClusterNominees`, `getLineage`, `pendMany`, `commitMany`)
 * are deliberately omitted: a read path asks none of them, and leaving them off is how this type
 * says so. The three write methods throw rather than delegate — a transactor that quietly allowed a
 * pass to write would hide the defect instead of reporting it.
 */
export class ConfirmationRecordingTransactor implements ITransactor {
	private readonly recorded = new Set<BlockId>();

	constructor(private readonly inner: ITransactor) {}

	/** Block ids whose answers no cohort member other than the answering node vouched for. */
	get unconfirmed(): ReadonlySet<BlockId> {
		return this.recorded;
	}

	get clock(): HlcClock | undefined {
		return this.inner.clock;
	}

	/**
	 * The inner read with `awaitConsult` set, then one record per block that came back unvouched.
	 *
	 * A block the result OMITS counts as unconfirmed, as does one whose entry carries no
	 * `cohortConfirmed`: the marker is positive (docs/internals.md §Consensus Execution, *A third,
	 * POSITIVE marker*), so absent means "not known to be confirmed" — including an answer from a
	 * peer that predates the field. A read that throws records nothing and propagates; the blob
	 * readers turn the two doubt-shaped errors into `certain: false` and let anything else through,
	 * which the pass catches as a throw.
	 */
	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		const results = await this.inner.get({ ...blockGets, awaitConsult: true });
		for (const blockId of blockGets.blockIds) {
			if (results[blockId]?.cohortConfirmed !== true) {
				this.recorded.add(blockId);
			}
		}
		return results;
	}

	async getStatus(actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]> {
		return await this.inner.getStatus(actionRefs);
	}

	pend(): Promise<PendResult> {
		throw new ReclaimReadOnlyError('pend an action');
	}

	cancel(): Promise<void> {
		throw new ReclaimReadOnlyError('cancel an action');
	}

	commit(): Promise<CommitResult> {
		throw new ReclaimReadOnlyError('commit an action');
	}
}
