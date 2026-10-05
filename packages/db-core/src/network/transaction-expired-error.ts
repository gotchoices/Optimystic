import type { ExpiredFailure, TransactionExpiry } from "./struct.js";
import { formatInstant } from "../utility/format-instant.js";

/**
 * A write the cohort refused because, by the refusing members' own clocks, the transaction had
 * already expired when it reached them. Nobody judged the write and nobody was unreachable: the clock
 * that set the expiration (the writer's) and the members' clocks disagree by more than the
 * transaction timeout (30 s by default). Not retryable — a retry's expiration comes from the same
 * clock, so it is refused the same way until one of the clocks is corrected. Nothing was saved.
 *
 * ONE class for every place it is raised, so the coordinator's report and the writer's cannot drift.
 * The cluster coordinator (db-p2p `ClusterCoordinator`) raises it when every reject vote that sank a
 * transaction was an expiry vote; the coordinating repo returns its facts as an
 * {@link ExpiredFailure} ({@link toFailure}), which is what lets a remote writer receive them at all;
 * and each write path (`Collection.sync`, `TransactionCoordinator.commit`) raises it again from that
 * refusal, with its own clock as {@link localClock}. Deliberately not a db-p2p
 * `ValidatorRejectionError`, which means "the cohort judged the write": the coordinating repo turns
 * this one into its refusal before its validator-rejection classifiers run.
 */
export class TransactionExpiredError extends Error {
	/** The transaction's expiration (unix ms), as the writer's transactor set it. */
	readonly expiration: number;
	/** Per refusing cohort member (peer-id string), the clock reading (unix ms) it signed. */
	readonly memberClocks: Readonly<Record<string, number>>;
	/** The coordinating node's clock (unix ms) when it concluded the refusal. */
	readonly coordinatorClock: number;
	/**
	 * How far ahead of {@link localClock} the most-skewed refusing member's clock appeared: the largest
	 * `memberClocks[peer] − localClock`. An estimate, low by the time the answer took to travel back
	 * (a member read its clock before then). Raised by a write path, this is how far the cohort's
	 * clocks appear to be from the writer's own — the number to act on whichever side is wrong. Zero or
	 * less means this node's clock has the expiration past as well.
	 */
	readonly apparentSkewMs: number;

	constructor(
		expiry: TransactionExpiry,
		/** This node's clock (unix ms) when it raised the error: the coordinator's where the cluster
		 *  raised it, the writer's where a write path raised it from a returned refusal. */
		readonly localClock: number = Date.now(),
	) {
		// NOTE: `expiry` off the wire is trusted as shaped (`isExpiryFailure` checks only presence), so a
		// malformed coordinator answer gives NaN here, or a TypeError when `memberClocks` is missing,
		// instead of this error. Either still ends the write; if hostile coordinators become a concern,
		// validate the shape where the refusal is received.
		const apparentSkewMs = Math.max(...Object.values(expiry.memberClocks)) - localClock;
		super(transactionExpiredMessage(expiry, localClock, apparentSkewMs));
		this.name = 'TransactionExpiredError';
		this.expiration = expiry.expiration;
		this.memberClocks = { ...expiry.memberClocks };
		this.coordinatorClock = expiry.coordinatorClock;
		this.apparentSkewMs = apparentSkewMs;
	}

	/** The refusal a coordinating repo returns for this error, so it crosses the repo protocol as an
	 *  answer rather than as a reset stream. */
	toFailure(): ExpiredFailure {
		return {
			success: false,
			conflict: false,
			reason: this.message,
			expired: { expiration: this.expiration, memberClocks: { ...this.memberClocks }, coordinatorClock: this.coordinatorClock },
		};
	}
}

/**
 * Written to be shown to a person. Deliberately free of the shortfall error's text ("Failed to get
 * super-majority"), which a downstream repository matches to retry a silent cohort: a clock
 * disagreement is neither silence nor transient.
 */
function transactionExpiredMessage(expiry: TransactionExpiry, localClock: number, apparentSkewMs: number): string {
	const seconds = (ms: number) => (ms / 1000).toFixed(1);
	const refusing = Object.keys(expiry.memberClocks).length;
	const gap = apparentSkewMs > 0
		? `Their clocks appear to be about ${seconds(apparentSkewMs)} s ahead of this device's.`
		: `This device's clock has it ${seconds(localClock - expiry.expiration)} s past as well, so the clock that set the expiration may be behind, or the transaction outlived its deadline.`;
	return `The transaction expired before the cohort could accept it: by their own clocks, ${refusing} cohort member(s) found its expiration (${formatInstant(expiry.expiration)}) already past. `
		+ `${gap} This is a clock disagreement, not a conflict or an unreachable cohort, and retrying fails the same way until it is resolved: `
		+ `correct the clock of whichever device is wrong — this one, or the refusing members.`;
}
