import type { CohortOutOfSpace, OutOfSpaceFailure } from "./struct.js";

/**
 * A pend the cohort could not accept because members with no storage left refused to take it: they
 * answered the promise round with a signed `out-of-space` vote (`Signature`'s `out-of-space`) and the
 * approvals fell short of the bar. Nobody judged the write, nobody holds a rival, and the cohort was
 * not silent — it simply has nowhere to put the bytes.
 *
 * Not retryable by a write path. Nothing about the write's revision is the problem, so a re-read and
 * rebase sends the same bytes to the same full members. What clears it is those members shedding what
 * they hold to peers with room, or their operator giving them more space. Nothing was saved: the
 * members that approved release their reservation when the writer cancels.
 *
 * A block's cohort is its replica set, derived from the block's own key, so there is no other member
 * to ask and no re-placement to attempt — this typed answer, naming every refuser, is the whole of
 * what a writer can be told. (A blob's cohort does have a choice of holders; that is the blob side's
 * question, not this one's.)
 *
 * ONE class for every place it is raised, as `PromiseShortfallError` is. The cluster coordinator
 * (db-p2p `ClusterCoordinator`) raises it; the coordinating repo returns its facts as an
 * {@link OutOfSpaceFailure} ({@link toFailure}), which is what lets a remote writer receive them at
 * all; and each write path (`Collection.sync`, `TransactionCoordinator.commit`) raises it again from
 * that refusal.
 *
 * NOTE: `classifyCommitFailure` has no arm for this class, so an offline drain sorts it as `unknown`
 * and treats the write as in doubt. Conservative and safe — the write was never stored, and a retry
 * under its own identity stores it once — but less specific than the facts allow. If a drain ever
 * needs to tell "the cohort has no room" from "we do not know what happened", give it its own class
 * there rather than folding it into `cohort-unreachable`, whose meaning is "too few members answered".
 */
export class CohortOutOfSpaceError extends Error {
	/** Peer-id strings of the cohort members that voted `out-of-space`. Never empty. */
	readonly peerIds: readonly string[];
	/** Approve votes the round received. */
	readonly approvals: number;
	/** How many members the cohort the round ran on has. */
	readonly peerCount: number;
	/** The approvals the round needed. */
	readonly needed: number;

	constructor(outOfSpace: CohortOutOfSpace) {
		// NOTE: `outOfSpace` off the wire is trusted as shaped (`isOutOfSpaceFailure` checks only
		// presence), so a malformed coordinator answer throws a TypeError here (no `peerIds` array)
		// instead of this error. Either still ends the write; if hostile coordinators become a concern,
		// validate the shape where the refusal is received, as for `TransactionExpiredError`.
		super(`Cohort is out of space: ${outOfSpace.peerIds.length}/${outOfSpace.peerCount} member(s) have no room left `
			+ `(${outOfSpace.approvals}/${outOfSpace.needed} approvals): ${outOfSpace.peerIds.join(', ')}`);
		this.name = 'CohortOutOfSpaceError';
		this.peerIds = [...outOfSpace.peerIds];
		this.approvals = outOfSpace.approvals;
		this.peerCount = outOfSpace.peerCount;
		this.needed = outOfSpace.needed;
	}

	/** The refusal a coordinating repo returns for this error, so it crosses the repo protocol as an
	 *  answer rather than as a reset stream. */
	toFailure(): OutOfSpaceFailure {
		return {
			success: false,
			conflict: false,
			reason: this.message,
			outOfSpace: {
				peerIds: [...this.peerIds],
				approvals: this.approvals,
				peerCount: this.peerCount,
				needed: this.needed,
			},
		};
	}
}
