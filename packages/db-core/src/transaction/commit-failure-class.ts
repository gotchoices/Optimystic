import { BlockUnavailableError, type BlockUnavailableReason } from "../network/struct.js";
import { PromiseShortfallError } from "../network/promise-shortfall-error.js";
import { ValidityRejectedError } from "../network/validity-rejected-error.js";
import { TransactionExpiredError } from "../network/transaction-expired-error.js";
import { TransactionTooLargeError } from "../network/transaction-size.js";
import { BlockTooLargeError } from "../network/block-size.js";
import { SyncRetryExhaustedError, TornActionError } from "../collection/struct.js";
import { TreeEntryChangedError, TreeGuardRefusedError } from "../collections/tree/struct.js";
import { CoordinatorPartialCommitError, CoordinatorStaleLossError } from "./errors.js";

/**
 * What a failed commit attempt says about the write, sorted for a caller that has to decide whether
 * to wait and send it again, give it up, or treat it as possibly saved (docs/offline-sync.md
 * §Classifying an attempt's outcome). Each arm carries the error it was sorted from, narrowed to the
 * classes that produce it.
 *
 * - `cohort-unreachable` — too few of the cohort answered, so the attempt that met it stored nothing.
 *   Wait for the cohort.
 * - `contention` — the write lost races until its retry budget ran out and was not saved, though an
 *   earlier attempt's log entry may still stand (see {@link SyncRetryExhaustedError}). Back off.
 * - `guard-refused` — a rival's commit made the write wrong: `constraint` for a uniqueness refusal,
 *   `concurrent-modification` for a lost update. Final.
 * - `rejected` — the members that sank the write judged it invalid. Final.
 * - `too-large` — the transaction, or a block it writes, is over the size limit. Final: it can never
 *   commit as it is.
 * - `expired` — the attempt outlived its expiry; a new attempt gets a fresh one.
 * - `torn-not-saved` — the write half-landed and is provably not saved; sending it again stores it once.
 * - `in-doubt` — the write half-landed and may be saved or may still land.
 * - `partial` — some collections of a multi-collection commit are saved and the rest are not.
 * - `unknown` — anything else. Treat as in doubt: retry only under the attempt's own identity.
 */
export type CommitFailureClass =
	| { kind: 'cohort-unreachable'; error: PromiseShortfallError | BlockUnavailableError }
	| { kind: 'contention'; error: SyncRetryExhaustedError | CoordinatorStaleLossError }
	| { kind: 'guard-refused'; refusal: 'constraint' | 'concurrent-modification'; error: TreeGuardRefusedError }
	| { kind: 'rejected'; error: ValidityRejectedError }
	| { kind: 'too-large'; error: TransactionTooLargeError | BlockTooLargeError }
	| { kind: 'expired'; error: TransactionExpiredError }
	| { kind: 'torn-not-saved'; error: TornActionError }
	| { kind: 'in-doubt'; error: TornActionError }
	| { kind: 'partial'; error: CoordinatorPartialCommitError }
	| { kind: 'unknown'; error: unknown };

/** The two unavailability reasons that mean the cohort could not be reached. The others are doubts
 *  about one block's read (a reconstruction gap, a claim nobody corroborated, a log naming a block
 *  nobody serves) and say nothing about whether a write could be sent. */
const cohortUnreachableReasons: ReadonlySet<BlockUnavailableReason> = new Set(['cohort-unreachable', 'peers-unreachable']);

/**
 * Sorts a commit failure into a {@link CommitFailureClass} — the one place every commit failure is
 * sorted, so no caller has to read an error's message to decide what to do with a write.
 *
 * Two rules keep the answer safe:
 *
 * - **Type only, never text.** It reads the error's class and the structured fields
 *   `BlockUnavailableError.reason` and `TornActionError.final`, never `message`.
 * - **The error thrown, never its `cause`.** A commit-phase shortfall reaches a local writer nested
 *   as the `cause` of the transactor's plain `Some peers did not complete` aggregate; that write is
 *   in doubt, not "nothing sent", and walking `cause` would sort it as unreachable. A wrapper whose
 *   wrapping means something is its own arm (`CoordinatorPartialCommitError`).
 *
 * The Quereus bridge's mapped errors (`ConstraintError`, `ConcurrentModificationError`) are not
 * recognised: classify the db-core error before mapping it.
 *
 * Classes are matched with `instanceof`, so an error constructed by a second copy of this package
 * sorts as `unknown` — the conservative answer, but a host that installs two copies loses every
 * other class. No guard in this repository checks for that.
 */
export function classifyCommitFailure(error: unknown): CommitFailureClass {
	if (error instanceof PromiseShortfallError) {
		return { kind: 'cohort-unreachable', error };
	}
	if (error instanceof BlockUnavailableError) {
		return cohortUnreachableReasons.has(error.reason)
			? { kind: 'cohort-unreachable', error }
			: { kind: 'unknown', error };
	}
	// `SyncRevisionStalledError` is a `SyncRetryExhaustedError`, so the base class covers it.
	if (error instanceof SyncRetryExhaustedError || error instanceof CoordinatorStaleLossError) {
		return { kind: 'contention', error };
	}
	if (error instanceof TreeGuardRefusedError) {
		// Every guard refusal other than a lost update is a uniqueness refusal, including a subclass
		// added later: the hierarchy's contract is that a refusal is never downgraded to retryable.
		const refusal = error instanceof TreeEntryChangedError ? 'concurrent-modification' : 'constraint';
		return { kind: 'guard-refused', refusal, error };
	}
	if (error instanceof ValidityRejectedError) {
		return { kind: 'rejected', error };
	}
	if (error instanceof TransactionTooLargeError || error instanceof BlockTooLargeError) {
		return { kind: 'too-large', error };
	}
	if (error instanceof TransactionExpiredError) {
		return { kind: 'expired', error };
	}
	if (error instanceof TornActionError) {
		return error.final ? { kind: 'torn-not-saved', error } : { kind: 'in-doubt', error };
	}
	if (error instanceof CoordinatorPartialCommitError) {
		return { kind: 'partial', error };
	}
	return { kind: 'unknown', error };
}
