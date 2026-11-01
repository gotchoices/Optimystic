import type { RejectedFailure, TransactionInvalidity, ValidityRefusal } from "./struct.js";

/**
 * A write the cohort refused because the members that sank it judged the transaction INVALID: it failed
 * its re-execution, its operations hash, its stamp or its client signature (`ValidityRejection` in
 * `transaction/transaction.ts` says which refusals qualify). Not retryable — re-sending the same
 * content to the same checks is refused the same way. Nothing was saved: the members that approved
 * release their reservation when the writer cancels.
 *
 * ONE class for every place it is raised, as `TransactionExpiredError` is. The coordinating repo (db-p2p
 * `CoordinatorRepo`) returns its facts as a {@link RejectedFailure} ({@link toFailure}) when every reject
 * that sank a pend was validity-marked or an expiry vote and its own storage confirms no revision loss,
 * and a cohort of one's storage tier returns the same for its own check; each write path
 * (`Collection.sync`, `TransactionCoordinator.commit`) raises it again from that refusal.
 *
 * Not the dispute answer. With disputes enabled, a marked rejection beside approvals is held for a ruling
 * before it ends the pend, and that writer is answered with the dispute's own refusal (backlog
 * `dispute-commit-path-block`, `dispute-writer-sees-disputed-pend`); this error stays the answer for a
 * rejection no approval contests.
 */
export class ValidityRejectedError extends Error {
	/** Every validity refusal that sank the write. Never empty. */
	readonly refusals: readonly ValidityRefusal[];

	constructor(invalidity: TransactionInvalidity) {
		// NOTE: `invalidity` off the wire is trusted as shaped (`isRejectedFailure` checks only presence),
		// so a malformed coordinator answer throws a TypeError here (no `refusals` array) instead of this
		// error. Either still ends the write; if hostile coordinators become a concern, validate the shape
		// where the refusal is received, as for `TransactionExpiredError`.
		super(validityRejectedMessage(invalidity.refusals));
		this.name = 'ValidityRejectedError';
		this.refusals = invalidity.refusals.map(refusal => ({ ...refusal }));
	}

	/** The refusal a coordinating repo returns for this error, so it crosses the repo protocol as an
	 *  answer rather than as a reset stream. */
	toFailure(): RejectedFailure {
		return {
			success: false,
			conflict: false,
			reason: this.message,
			rejected: { refusals: this.refusals.map(refusal => ({ ...refusal })) },
		};
	}
}

/** Written to be shown to a person. Names each refuser — the member's peer id, or the coordinating
 *  node's own check where no vote was cast — with the reason it gave. */
function validityRejectedMessage(refusals: readonly ValidityRefusal[]): string {
	const details = refusals
		.map(refusal => `${refusal.peerId ?? 'coordinating node'}: ${refusal.reason ?? 'no reason given'}`)
		.join('; ');
	return `The transaction was rejected as invalid by ${refusals.length} validator(s) (${details}). `
		+ `This is a verdict on the transaction itself, not a conflict or an unreachable cohort, and sending it again is refused the same way.`;
}
